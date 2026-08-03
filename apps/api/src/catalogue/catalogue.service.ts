import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import type {
  CategoryConfiguration,
  CategoryRecord,
  CategoryStore,
} from './category-store.js';

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
  list(): Promise<readonly CategoryRecord[]> {
    return this.store.list();
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
 * **The attribute schema is in, and its order is part of what is digested.**
 * `canonicalise` sorts object keys but deliberately preserves array order, so
 * moving an attribute up the form registers as a change — which it is. The order
 * is what an owner filling in a listing sees, and a reorder that left no trace
 * would be the one configuration change nobody could account for afterwards.
 */
function auditable(record: CategoryRecord): Record<string, unknown> {
  return {
    slug: record.slug,
    name: record.name,
    riskLevel: record.riskLevel,
    attributes: record.attributes,
  };
}
