import { Paging } from '@platform/core';
import type { Logger } from '@platform/observability';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import type {
  CategoryConfiguration,
  CategoryRecord,
  CategoryStore,
} from './category-store.js';
import { CATEGORY_LIST_LIMIT } from './limits.js';

/**
 * The Catalogue module's application service.
 *
 * Its whole job in this slice is that **a configuration change and its audit
 * entry happen together, or not at all**. §8.2 requires configuration changes to
 * be "versioned and audited", and §8.13 requires every administrative action to
 * record actor, reason, target and before/after state. Two requirements, one
 * funnel — a route that wrote a version directly through the store would satisfy
 * neither by accident.
 *
 * The audit write is awaited and its failure propagates, which is the module's
 * inherited fail-closed rule (ADR 0017): a configuration change that succeeded
 * with no record of who made it or why is exactly what the trail exists to
 * prevent. Here that is stronger than usual, because these rows are the thing
 * every later booking is interpreted under.
 */
export class CatalogueService {
  constructor(
    private readonly store: CategoryStore,
    private readonly audit: AuditService,
    /**
     * Here from slice H2, and only to report a guardrail firing.
     *
     * Not for the ordinary path: a service that logs what it did on every call
     * produces a log nobody reads, and this module's real record of what
     * happened is the audit trail rather than the log stream.
     */
    private readonly logger: Logger,
  ) {}

  /**
   * Create a category.
   *
   * `before` is deliberately absent rather than null — there was no prior
   * state, and digesting one would claim a previous version existed.
   */
  async create(
    actor: Actor,
    input: CategoryConfiguration & { readonly slug: string },
    reason: string,
  ): Promise<CategoryRecord> {
    const created = await this.store.create(input, actor.userId);

    await this.audit.record({
      actor,
      action: 'category.created',
      targetType: 'category',
      targetId: created.id,
      after: auditable(created),
      reason,
    });

    return created;
  }

  /**
   * Change a category's configuration, minting a new version.
   *
   * The before-state is read from the store rather than reconstructed from the
   * request, because the digest has to describe what was actually there. Two
   * administrators saving at once is handled below it: the unique constraint on
   * `(categoryId, versionNumber)` refuses the second write rather than letting
   * it silently overwrite the first.
   *
   * Resolves to null if no category has that slug, so the route can answer 404
   * without this service knowing what HTTP is.
   */
  async reconfigure(
    actor: Actor,
    slug: string,
    configuration: CategoryConfiguration,
    reason: string,
  ): Promise<CategoryRecord | null> {
    const before = await this.store.findBySlug(slug);
    if (before === null) return null;

    const after = await this.store.addVersion(slug, configuration, actor.userId);
    // The category existed a moment ago and categories are never removed, so
    // this is unreachable rather than merely unlikely. Returning null keeps the
    // route's contract honest if that ever stops being true.
    if (after === null) return null;

    await this.audit.record({
      actor,
      action: 'category.reconfigured',
      targetType: 'category',
      targetId: after.id,
      before: auditable(before),
      after: auditable(after),
      reason,
    });

    return after;
  }

  /**
   * Every category.
   *
   * Not audited, and deliberately so. The administrative reads that *are*
   * audited disclose somebody's personal data (ADR 0021); a category is
   * configuration, will be public from slice 2.10, and recording an entry every
   * time an administrator opens the list would bury the disclosures that matter
   * under noise.
   */
  async list(): Promise<readonly CategoryRecord[]> {
    // One more than we will serve, so "there were more" is measured rather than
    // inferred from a full page (slice H2).
    const rows = await this.store.list(Paging.probe(CATEGORY_LIST_LIMIT));
    const page = Paging.fitTo(rows, CATEGORY_LIST_LIMIT);

    if (page.truncated) {
      // A guardrail firing, not a page being turned. `CATEGORY_LIST_LIMIT` is
      // two orders of magnitude above a plausible catalogue, so reaching it
      // means a bug, a bad migration or a runaway script — and an administrator
      // looking at a list of five hundred has no way to tell it from the whole
      // catalogue. It is a warning rather than a refusal because serving most of
      // the catalogue beats serving none of it.
      this.logger.warn('category list truncated', {
        limit: CATEGORY_LIST_LIMIT,
        surface: 'admin',
      });
    }

    return page.items;
  }

  findBySlug(slug: string): Promise<CategoryRecord | null> {
    return this.store.findBySlug(slug);
  }
}

/**
 * What the audit trail digests: the configuration, and nothing else.
 *
 * Timestamps and the version number are excluded on purpose. They change on
 * every write by definition, so including them would make every entry's digest
 * differ from the last regardless of whether anything meaningful changed —
 * which destroys the only thing comparing digests is for (ADR 0017).
 *
 * **`reportableActivity` is in, and it is the entry that most needs to be.**
 * §17's risk register names an undetected change of reporting scope as its own
 * risk, and this digest is what makes the change accountable afterwards: the
 * before and after both name the head, so a flip from `none` is visible in the
 * trail rather than inferable from a version number.
 *
 * **The attribute schema is in, and its order is part of what is digested.**
 * `canonicalise` sorts object keys but deliberately preserves array order, so
 * moving an attribute up the form registers as a change — which it is. The order
 * is what an owner filling in a listing sees, and a reorder that left no trace
 * would be the one configuration change nobody could account for afterwards.
 *
 * **The transport options are in**, for the reason §8.3 gives for having them at
 * all: withdrawing one changes what an owner can say about how their item is
 * collected, and changing a weight threshold changes what the form suggests they
 * say. Both are configuration decisions somebody should be accountable for. The
 * contract normalises the order on the way in, so unlike the attributes above,
 * a reorder here is not a change and cannot register as one.
 *
 * **The fee policy is in, and of everything here it is the one with money on the
 * other side of it.** A rate change decides what every owner is paid and what
 * every renter is charged from that version onward. §8.13 makes administrative
 * actions auditable; a fee change that left the same digest as the version
 * before it would be the platform's own margin moving with nobody accountable —
 * and the person it costs would have no way to establish when it changed.
 */
function auditable(record: CategoryRecord): Record<string, unknown> {
  return {
    slug: record.slug,
    name: record.name,
    riskLevel: record.riskLevel,
    reportableActivity: record.reportableActivity,
    attributes: record.attributes,
    transportOptions: record.transportOptions,
    feePolicy: record.feePolicy,
  };
}
