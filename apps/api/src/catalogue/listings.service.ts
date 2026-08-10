import {
  TRANSPORT_REQUIREMENT_LABELS,
  moderationRequiresReason,
  offersTransportRequirement,
  publicationBlockers,
  transitionRefusal,
  validateAttributeValues,
} from '@platform/contracts';
import type {
  AttributeValueIssue,
  ExportedListingsSection,
  ListingCollectionLocation,
  ListingStatus,
  ListingTransition,
  ModerationState,
  PublicationBlocker,
  TransportRequirement,
} from '@platform/contracts';
import { Paging, Time } from '@platform/core';
import type { Logger } from '@platform/observability';
import { CATEGORY_LIST_LIMIT, EXPORTED_LISTING_LIMIT } from './limits.js';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ListingLocator } from './listing-locator.js';
import type { PublicationSwitch } from './publication-switch.js';
import type { ListingRateCard } from '@platform/contracts';
import type { MoneyValue } from '@platform/core';
import type {
  CategoryOptionRecord,
  CategoryOptionSource,
  ListingRecord,
  ListingStore,
} from './listing-store.js';
import { CategoryChangedError, UnknownCategoryError } from './listing-store.js';

/**
 * What an owner submits: everything the wire carries, with the attribute values
 * still unchecked.
 *
 * Deliberately not `ListingDraft`. That is the store's shape and its
 * `attributes` are *validated* values — the difference between the two types is
 * exactly the work this service does, and collapsing them into one would make it
 * possible to reach the store with values nothing had looked at.
 */
export interface SubmittedListing {
  readonly ownerId: string;
  readonly categorySlug: string;
  readonly title: string;
  readonly description: string;
  readonly replacementValue: MoneyValue;
  readonly attributes: unknown;
  /**
   * In the platform's vocabulary already — the wire schema checked that — but
   * not yet known to be one *this category* offers. That is configuration on the
   * version about to be pinned, so only this service can decide it.
   */
  readonly transportRequirement: TransportRequirement | null;
  readonly requiresTwoPersonLift: boolean;
  /**
   * What it costs to rent (§8.5.2).
   *
   * Typed as the validated shape rather than `unknown`, unlike the attributes
   * above, and the difference is the point: an attribute value's legality
   * depends on *category configuration* on the version about to be pinned, so
   * only this service can judge it. A rate depends on nothing but itself, so the
   * contract has already finished the job before it arrives here.
   */
  readonly rates: ListingRateCard;
  /**
   * Where the item is collected from, or null on a draft that has not said.
   *
   * Already normalised by the contract — the postcode arrives as `BS7 8AA` and
   * `line2` as null rather than absent — so nothing here re-decides what a valid
   * postcode is. **Unlike the attributes and the transport requirement, this
   * needs no check against the category**: where somebody's lawnmower lives is
   * not something a category configures, and no version pins it.
   */
  readonly collectionLocation: ListingCollectionLocation | null;
  readonly categoryVersionNumber: number;
}

/**
 * Raised when the category does not offer the transport requirement chosen.
 *
 * Its own error rather than an `AttributeValueIssue`, because it is not an
 * attribute and a form showing errors beside fields must not be told it is one.
 * The message names the offered options **by label**, because the stored values
 * appear nowhere on screen — 2.4b's lesson, and 2.4c-i's.
 */
export class TransportRequirementNotOfferedError extends Error {
  constructor(
    readonly requirement: string,
    offered: readonly { readonly requirement: TransportRequirement }[],
  ) {
    super(
      offered.length === 0
        ? 'This category does not ask how an item is collected, so it cannot ' +
            'take a transport requirement'
        : `This category is collected by ${offered
            .map((option) => TRANSPORT_REQUIREMENT_LABELS[option.requirement])
            .join(', ')}`,
    );
    this.name = 'TransportRequirementNotOfferedError';
  }
}

/**
 * Raised when the answers do not fit the category's schema.
 *
 * Carries the structured issues rather than a joined string so the controller
 * can hand a form the key of each offending field. A message assembled here
 * would be one the interface has to take apart again.
 */
export class AttributeValuesInvalidError extends Error {
  constructor(readonly issues: readonly AttributeValueIssue[]) {
    super(`The attribute values were rejected: ${String(issues.length)} problem(s)`);
    this.name = 'AttributeValuesInvalidError';
  }
}

/**
 * Raised when a listing is not complete enough to be published (§8.3).
 *
 * **Distinct from `AttributeValuesInvalidError`, and the difference is which
 * question was answered wrongly.** That one means the request carried a value
 * the category cannot accept — a different body would fix it. This means the
 * request was fine and the *listing* is not ready, which no request body can
 * fix. The controller turns the first into a 400 and this into a 422 for that
 * reason.
 *
 * Carries every blocker rather than the first, so an owner sees the whole list
 * at once instead of discovering it one save at a time.
 */
/**
 * Raised when publishing is switched off platform-wide (slice H3a, §9).
 *
 * **Its own error rather than a `PublicationBlocker`**, and the distinction is
 * the point. A blocker is something *this listing* is missing and its owner can
 * fix — the 422 lists them so somebody knows what to do next. This is nothing to
 * do with the listing: it is complete, it is theirs, and the platform is not
 * accepting publications right now. Folding it into the blocker list would tell
 * an owner that their listing was incomplete, and they would go looking for the
 * missing field forever.
 *
 * It carries no reason, deliberately. The administrator's reason is written for
 * the audit trail and for whoever reviews the incident; it is not copy for the
 * public, and a message typed under pressure at 3am is not something to show
 * strangers verbatim.
 */
export class PublicationSuspendedError extends Error {
  constructor() {
    super('Publishing listings is temporarily switched off');
    this.name = 'PublicationSuspendedError';
  }
}

/**
 * Raised when a transition is not legal from the listing's current state
 * (slice 2.8b).
 *
 * **A third error rather than a blocker or a publication refusal**, because it
 * answers a third question. `ListingNotPublishableError` means the listing is
 * incomplete and names what to add. This means the listing is in a state where
 * the request makes no sense — pausing something that was never published — and
 * there is nothing to add, nothing to fix, and no reason to show a list of
 * fields. The controller answers 409 rather than 422 for exactly that reason:
 * one is fixed by supplying more, the other is not fixed by supplying anything.
 *
 * Carries the sentence `transitionRefusal` produced, so the wording lives beside
 * the rule rather than being reinvented at the route.
 */
export class ListingTransitionRefusedError extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = 'ListingTransitionRefusedError';
  }
}

/**
 * Raised when a moderation decision that hides a listing carries no reason
 * (§9, ADR 0024, slice 2.8c-i).
 *
 * A 400 rather than a 422: the request body is genuinely missing a field, and
 * supplying it is exactly what fixes it. That is the distinction
 * `ListingNotPublishableError` draws from the other side.
 */
export class ModerationReasonRequiredError extends Error {
  constructor(readonly state: ModerationState) {
    super('A reason is required when a listing is taken out of public view');
    this.name = 'ModerationReasonRequiredError';
  }
}

export class ListingNotPublishableError extends Error {
  constructor(readonly blockers: readonly PublicationBlocker[]) {
    super(
      `The listing is not ready to publish: ${String(blockers.length)} thing(s) missing`,
    );
    this.name = 'ListingNotPublishableError';
  }
}

/**
 * The Listings application service.
 *
 * **Nothing here is audited, and that is a decision rather than an omission.**
 * §8.13 requires an audit entry for administrative actions — an actor doing
 * something to somebody else, with a reason the subject can read. An owner
 * writing their own listing is neither: there is no second party, and demanding
 * a reason from somebody describing their own lawnmower would be the ritual that
 * makes the reasons which *do* matter look like paperwork.
 *
 * Slice 2.11 is where that changes. An administrator creating a listing on an
 * owner's behalf is an administrative action about another person's account, and
 * it must be audited **as that** rather than recorded as though the owner did
 * it. When that arrives it belongs in its own method here, not as a flag on
 * this one.
 */
export class ListingsService {
  constructor(
    private readonly store: ListingStore,
    private readonly categories: CategoryOptionSource,
    /**
     * Search & Location, reached through the port `listing-locator.ts` states
     * (BRD §5.1: Catalogue must not own postcodes or coordinates).
     *
     * Required rather than optional, for the reason slice 2.1 learned when it
     * made `catalogue` a required `AppModule` option: an optional dependency is
     * one that several boot sites forget, and the failure would arrive as
     * listings silently never being locatable.
     */
    private readonly locator: ListingLocator,
    /**
     * Here from slice H2, and only to report a guardrail firing — the same
     * narrow role it has on `CatalogueService`. Nothing on the ordinary path
     * logs.
     */
    private readonly logger: Logger,
    /**
     * Whether publishing is switched on (slice H3a, §9's kill switch).
     *
     * A port this module declares and the feature-flags module answers, the same
     * shape as `locator` above. **One method, not the flag service**, so a later
     * slice cannot switch a flag from inside a listing operation — a state
     * change with no administrator and no reason behind it.
     *
     * Required rather than optional, for the reason `locator` is: an optional
     * dependency is one several boot sites forget, and the failure would arrive
     * as a kill switch that silently does nothing.
     */
    private readonly publication: PublicationSwitch,
    /**
     * The audit trail, for the one operation here that is administrative
     * (slice 2.8c-i, ADR 0041).
     *
     * **This service went eight slices without one, deliberately** — everything
     * it did was an owner acting on their own listing, and `catalogue.service.ts`
     * beside it has had an audit dependency since 2.1 because everything *it*
     * does is administrative. Moderation is the first thing on this side of the
     * line to cross over.
     *
     * Required rather than optional, for the reason every other dependency here
     * is: an optional audit log is one a composition root forgets, and ADR 0017
     * makes an unaudited administrative action a failure rather than a
     * quiet success.
     */
    private readonly audit: AuditService,
  ) {}

  /**
   * Create a draft for this owner.
   *
   * Three things happen in order, and the order is the design.
   *
   * 1. **The category's current configuration is read.** Its schema is what the
   *    answers are checked against, because a listing may only ever be valid
   *    under the configuration it is about to pin.
   * 2. **The version is compared with the one the form was built from.** If the
   *    category has been reconfigured since the page was opened, the answers
   *    were given against a schema that no longer exists and the whole draft is
   *    refused. Validating against the new schema instead would silently discard
   *    an answer to a renamed attribute — data loss with no error.
   * 3. **The store writes, and re-checks the version as it pins.** This service
   *    cannot close the window between its own read and the write; the store
   *    can, because it pins inside the same statement.
   *
   * The category version itself is still never chosen by a caller — see
   * `ListingDraft`. What travels is an assertion about what was read, which the
   * write refuses to honour if it has stopped being true.
   */
  async createDraft(submitted: SubmittedListing): Promise<ListingRecord> {
    const category = await this.categories.findOption(submitted.categorySlug);
    if (category === null) throw new UnknownCategoryError(submitted.categorySlug);

    if (category.versionNumber !== submitted.categoryVersionNumber) {
      throw new CategoryChangedError(
        submitted.categorySlug,
        submitted.categoryVersionNumber,
        category.versionNumber,
      );
    }

    const values = validateAttributeValues(category.attributes, submitted.attributes);
    if (!values.ok) throw new AttributeValuesInvalidError(values.issues);

    // Checked against the options on the version being pinned, never against the
    // category as it stands now — the rule ADR 0029 established for attribute
    // values, and it matters here for the same reason: withdrawing an option
    // must not retroactively invalidate a listing that chose it.
    //
    // Null is always allowed. §8.3 makes a draft permissive, so "not said yet"
    // is legitimate even for a category that offers plenty; completeness is a
    // publication rule (2.8).
    if (
      submitted.transportRequirement !== null &&
      !offersTransportRequirement(
        category.transportOptions,
        submitted.transportRequirement,
      )
    ) {
      throw new TransportRequirementNotOfferedError(
        submitted.transportRequirement,
        category.transportOptions,
      );
    }

    // **After every refusal above, and deliberately.** Geocoding is a call to a
    // third party; doing it before the checks would spend somebody else's
    // service on drafts we are about to reject, and would make a validation
    // error take 2.5 s to arrive when the provider is slow.
    //
    // Null for either failure — unrecognised postcode or unreachable provider —
    // and neither stops the save. §8.3 makes a draft permissive, so a listing
    // with an address we could not place is a legitimate draft that reads as
    // "not located yet". **Slice 2.8 must refuse to publish one**, because a
    // published listing no search can find is worse than a draft.
    const locatedPoint =
      submitted.collectionLocation === null
        ? null
        : await this.locator.locate(submitted.collectionLocation.postcode);

    return this.store.createDraft({
      ownerId: submitted.ownerId,
      categorySlug: submitted.categorySlug,
      title: submitted.title,
      description: submitted.description,
      replacementValue: submitted.replacementValue,
      attributes: values.values,
      transportRequirement: submitted.transportRequirement,
      requiresTwoPersonLift: submitted.requiresTwoPersonLift,
      rates: submitted.rates,
      collectionLocation: submitted.collectionLocation,
      locatedPoint,
      categoryVersionNumber: category.versionNumber,
    });
  }

  /**
   * One of this owner's listings.
   *
   * Ownership is the store's query, not a comparison made here. Resolves to null
   * for both "no such listing" and "not yours", so the route cannot leak the
   * difference even by accident.
   */
  findOwned(id: string, ownerId: string): Promise<ListingRecord | null> {
    return this.store.findOwnedBy(id, ownerId);
  }

  /**
   * Whether the platform is accepting publications right now (slice H3b).
   *
   * **Exposed so the interface can say so before somebody presses the button**,
   * not so it can decide anything. `publish` asks the same question again on
   * every attempt, and it has to: this answer is read when a page is rendered
   * and acted on whenever the owner gets round to it, which may be long after
   * somebody threw the switch.
   *
   * Named for the question rather than for the flag. A caller should not have to
   * know that `listing.publication` exists, or that flags exist at all — which
   * is the same reason the port is one method rather than the flag service.
   */
  isPublicationAvailable(): Promise<boolean> {
    return this.publication.isPublicationEnabled();
  }

  /** The categories an owner may list in, with the fields each one asks for. */
  async categoryOptions(): Promise<readonly CategoryOptionRecord[]> {
    const rows = await this.categories.listOptions(Paging.probe(CATEGORY_LIST_LIMIT));
    const page = Paging.fitTo(rows, CATEGORY_LIST_LIMIT);

    if (page.truncated) {
      // Worse here than on the admin list, which is why it is logged separately
      // rather than sharing one call site. A truncated admin list is an
      // administrator seeing less configuration than exists; a truncated picker
      // is a category **nobody can list an item in**, with a form that looks
      // perfectly normal and says nothing.
      this.logger.warn('category list truncated', {
        limit: CATEGORY_LIST_LIMIT,
        surface: 'owner-picker',
      });
    }

    return page.items;
  }

  /**
   * This module's contribution to somebody's data export.
   *
   * **Catalogue became a personal-data module in slice 2.5a**, and this method
   * and `eraseFor` below are what that means in practice. Until a listing
   * carried a collection address, the only personal data outside Identity was a
   * profile, and the export document said so by omission — a subject-access
   * request answered from it would have missed the street the person is
   * standing on.
   *
   * The address arrives **decrypted**, which is why this is built here rather
   * than by the identity module assembling the document: the key belongs to this
   * module's store, and handing it out so somebody else could decrypt would put
   * it in a second place. Exactly the reasoning `ProfilesService.exportFor`
   * gives.
   *
   * The empty list is the answer for somebody with no listings — see
   * `exportedListingsSchema` for why there is no null beside it.
   */
  /**
   * Publish a listing, if it is ready (§8.3, slice 2.8a).
   *
   * The completeness rules live in `@platform/contracts` rather than here,
   * because 2.9's owner dashboard needs the same answer *without* performing the
   * transition — "what is still missing" is what a dashboard shows, and a rule
   * reachable only by trying to publish would have to be written twice.
   *
   * **The rules read the pinned version's schema and options**, which the record
   * already carries for exactly this reason (ADR 0029). A listing is judged
   * against the terms it was written under, not against what the category asks
   * today.
   *
   * **Publishing does not re-pin.** ADR 0029 makes re-pinning explicit and
   * value-migrating, never a side effect — and "side effect of publishing" is
   * the same defect as "side effect of saving". A listing goes live under the
   * version it was written against; moving it to a newer one is slice 2.8d's
   * deliberate operation.
   *
   * Returns null when no such listing belongs to this owner, so the route can
   * answer 404 without distinguishing "not yours" from "does not exist".
   *
   * Throws `ListingNotPublishableError` with every unmet requirement, and
   * `PublicationSuspendedError` when the platform-wide switch is off.
   *
   * **The switch is checked before the ownership read** (slice H3a). A kill
   * switch that still costs a database query and a completeness evaluation per
   * request is not much of a kill switch, and the traffic it is thrown at is
   * often exactly the traffic causing the incident. It also means a suspended
   * platform tells everybody the same thing, rather than telling a stranger
   * "that listing is not yours" first — the ordering is a disclosure decision as
   * well as a cost one.
   */
  async publish(id: string, ownerId: string): Promise<ListingRecord | null> {
    if (!(await this.publication.isPublicationEnabled())) {
      throw new PublicationSuspendedError();
    }

    const listing = await this.store.findOwnedBy(id, ownerId);
    if (listing === null) return null;

    /*
     * **Resuming a paused listing comes through here**, and that is the design
     * rather than an accident of routing (slice 2.8b). An owner sees two words,
     * Publish and Resume, and the platform sees one operation: putting a listing
     * in front of strangers. Everything that guards the first must guard the
     * second — the kill switch above, and the completeness rules below.
     *
     * A separate `resume` that trusted "it was complete when it was published"
     * would be a second door into public view, and the first thing to walk
     * through it would be a listing whose category was reconfigured while it
     * was paused.
     */
    this.refuseIllegalTransition('publish', listing.status);

    const blockers = publicationBlockers({
      description: listing.description,
      attributes: listing.attributes,
      categoryAttributes: listing.categoryAttributes,
      categoryTransportOptions: listing.categoryTransportOptions,
      transportRequirement: listing.transportRequirement,
      rates: listing.rates,
      hasCollectionLocation: listing.collectionLocation !== null,
      isLocated: listing.isLocated,
    });

    if (blockers.length > 0) throw new ListingNotPublishableError(blockers);

    return this.store.publish(id, ownerId);
  }

  /**
   * Take a listing out of public view, reversibly (§8.3, slice 2.8b).
   *
   * **The kill switch is deliberately not checked here.** It stops listings
   * *going* public; stopping an owner from taking one down would be the switch
   * working backwards, and the incident it exists for is exactly when somebody
   * most needs to be able to withdraw their item. `isPublicationEnabled` gates
   * `publish` alone, which is why resuming is refused while pausing is not.
   *
   * **No audit entry, and that is a decision rather than an omission.** Every
   * audited action in this system is administrative (§8.13), about personal data
   * (§10.1), or a configuration change (§8.2). An owner pausing their own
   * listing is none of the three — it is the same kind of act as publishing it,
   * which 2.8a also left unaudited. The line is *who performed it*: when an
   * administrator pauses somebody else's listing in 2.8c, that is an
   * administrative action on a stranger's property and it must be audited then.
   *
   * This supersedes the note slice 2.5a left, which guessed that archival would
   * deserve an entry because "archival is an action". Archival no longer exists,
   * and the reasoning was the wrong test anyway.
   *
   * Returns null when no such listing belongs to this owner, so the route
   * answers 404 without telling a stranger whose listing it is.
   *
   * Throws `ListingTransitionRefusedError` when the listing is not published.
   */
  async pause(id: string, ownerId: string): Promise<ListingRecord | null> {
    const listing = await this.store.findOwnedBy(id, ownerId);
    if (listing === null) return null;

    this.refuseIllegalTransition('pause', listing.status);

    return this.store.pause(id, ownerId);
  }

  /**
   * Decide what the platform permits of a listing (§8.3, §9, ADR 0041).
   *
   * **The only write in this module performed by somebody who is not the
   * owner**, and everything unusual about it follows from that:
   *
   * - There is no ownership filter to lean on. Every other write here puts the
   *   owner in the `where` so a forgotten comparison cannot touch a stranger's
   *   listing; a moderator's whole job is to touch strangers' listings, so
   *   **the role and second factor at the guard are the entire control**.
   * - **It is audited, and pausing is not.** An owner pausing their own listing
   *   is not an administrative act; this is (§8.13). The distinction is who
   *   performed it, which is the rule 2.8b settled and this slice inherits.
   * - **The audit write is awaited and its failure propagates** (ADR 0017).
   *   A listing taken down with no record of who did it or why is precisely the
   *   decision somebody will need to answer for.
   *
   * **The reason is required for any state that hides a listing** and refused
   * for none — `moderationRequiresReason` decides, the database enforces it as
   * a backstop, and this raises `ModerationReasonRequiredError` before either.
   *
   * **It does not touch `status`.** An owner's intent is theirs; a moderator
   * hides the listing without republishing or unpausing anything, which is the
   * whole reason ADR 0041 gave moderation its own field.
   *
   * Returns null when no such listing exists, so the route answers 404.
   */
  async moderate(input: {
    readonly listingId: string;
    readonly state: ModerationState;
    readonly reason: string | null;
    readonly actor: Actor;
  }): Promise<ListingRecord | null> {
    const reason = input.reason?.trim() ?? '';

    if (moderationRequiresReason(input.state) && reason === '') {
      throw new ModerationReasonRequiredError(input.state);
    }

    const before = await this.store.findForModeration(input.listingId);
    if (before === null) return null;

    const after = await this.store.moderate({
      listingId: input.listingId,
      state: input.state,
      // Empty becomes null rather than '', so "no reason" has one
      // representation. The CHECK treats a blank string as absent too, and two
      // spellings of the same thing is how a query later misses half the rows.
      reason: reason === '' ? null : reason,
      moderatorId: input.actor.userId,
      decidedAt: Time.nowUtc(),
    });

    /* c8 ignore next 2 -- the row was read a statement ago; only a concurrent
       delete could reach this, and nothing deletes a listing but erasure. */
    if (after === null) return null;

    await this.audit.record({
      actor: input.actor,
      action: 'listing.moderated',
      targetType: 'listing',
      targetId: after.id,
      before: moderationAuditable(before),
      after: moderationAuditable(after),
      // Spread rather than `reason: undefined`, because `exactOptionalPropertyTypes`
      // draws a real distinction here: an absent key means "this action owes no
      // explanation", and a present `undefined` would be a reason somebody
      // failed to supply.
      ...(reason === '' ? {} : { reason }),
    });

    return after;
  }

  /**
   * The state machine, consulted in one place.
   *
   * Both transitions ask the same question of the same table in
   * `@platform/contracts`, and asking it inline twice is how the two come to
   * disagree once 2.8c adds moderation states.
   */
  private refuseIllegalTransition(
    transition: ListingTransition,
    from: ListingStatus,
  ): void {
    const refusal = transitionRefusal(transition, from);
    if (refusal !== null) throw new ListingTransitionRefusedError(refusal);
  }

  async exportFor(userId: string): Promise<ExportedListingsSection> {
    // One more than the document will carry, so the cut is measured rather than
    // guessed from a full page (slice H2). The bound is what stops a subject
    // access request assembling an owner's entire history into a synchronous
    // response; declaring it is what stops the bound turning a complete answer
    // into a quietly partial one, which §10.1 does not allow.
    const rows = await this.store.listOwnedBy(
      userId,
      Paging.probe(EXPORTED_LISTING_LIMIT),
    );
    const page = Paging.fitTo(rows, EXPORTED_LISTING_LIMIT);

    return {
      listings: page.items.map((listing) => ({
        id: listing.id,
        title: listing.title,
        createdAt: Time.toIsoUtc(listing.createdAt),
        collectionLocation: listing.collectionLocation,
      })),
      truncated: page.truncated,
    };
  }

  /**
   * Remove what this module holds about somebody: their listings, entirely.
   *
   * **Until 2.8b this erased locations and kept the listings**, and the change
   * is the product owner's decision of 10 August 2026: deleting an account means
   * the account and its listings are gone. The question 2.5a left open — whether
   * a deleted owner's listing stays visible — is answered by there being no
   * listing to show.
   *
   * **§10.1 permits this today and will not permit it forever**, and the
   * difference is worth stating precisely because it is a legal line rather than
   * a preference. §10.1 distinguishes erasable personal data from records the
   * platform is *required to retain*. Nothing refers to a listing today, so
   * nothing requires retaining one. From Phase 4 a booking does, and a renter's
   * rental history, receipts and any dispute evidence all point at the listing —
   * at which point deleting it destroys the other party's records, which is the
   * carve-out's whole purpose. The rule then becomes delete-if-unreferenced,
   * hide-if-referenced. `ListingStore.deleteAllOwnedBy` carries the same warning
   * where whoever adds the booking foreign key will meet it.
   *
   * **Unaudited, deliberately.** `ProfilesService.eraseFor` writes a
   * `profile.erased` entry; there is no equivalent here because Identity writes
   * the entry for the deletion itself, and a second line per listing would
   * record a consequence rather than an action, with a target id for every row,
   * in a trail retained six years, about rows that no longer exist.
   */
  async eraseFor(actor: Actor): Promise<void> {
    await this.store.deleteAllOwnedBy(actor.userId);
  }
}

/**
 * What the audit trail digests about a moderation decision: the decision, and
 * nothing else.
 *
 * **Narrow on purpose**, exactly as `auditable` in `catalogue.service.ts` is.
 * The digest has to change when the decision changes and *only* then — feeding
 * it the whole record would make an unrelated edit look like a moderation event,
 * and would fold somebody's address into a hash retained for six years
 * (ADR 0017).
 *
 * The title is not here either, tempting as it is for a human reading the trail.
 * A listing renamed after being rejected would produce a differing digest for a
 * decision nobody revisited.
 */
function moderationAuditable(listing: ListingRecord): Record<string, unknown> {
  return {
    moderationState: listing.moderationState,
    moderationReason: listing.moderationReason,
  };
}
