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
  DistanceBucket,
  ExportedListingsSection,
  ListingCollectionLocation,
  ListingStatus,
  ListingTransition,
  ModerationState,
  PublicationBlocker,
  SearchRadiusMiles,
  TransportRequirement,
} from '@platform/contracts';
import { Paging, Time } from '@platform/core';
import type { Page } from '@platform/core';
import type { Logger } from '@platform/observability';
import {
  CATEGORY_LIST_LIMIT,
  EXPORTED_LISTING_LIMIT,
  OWNED_LISTING_LIMIT,
  SEARCH_RESULT_LIMIT,
} from './limits.js';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ListingLocator } from './listing-locator.js';
import type { ListingProximity } from './listing-proximity.js';
import type { PublicationSwitch } from './publication-switch.js';
import type { OwnerStatusSource } from './owner-status-source.js';
import type { OwnerStatus } from '@platform/contracts';
import type { ListingRateCard } from '@platform/contracts';
import type { MoneyValue } from '@platform/core';
import type {
  CategoryOptionRecord,
  CategoryOptionSource,
  CollectionLocationEdit,
  ListingRecord,
  ListingStore,
  PublicListingRecord,
  PublicListingSummaryRecord,
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
 * What an owner submits when editing (slices 2.9b-i and 2.9b-ii).
 *
 * `SubmittedListing` minus the one thing an edit cannot carry: the category,
 * which is fixed at creation. Expressed as an `Omit` rather than retyped, so a
 * field added to the create shape has to be considered here rather than quietly
 * diverging.
 *
 * **`collectionLocation` was in that `Omit` through 2.9b-i and came out in
 * 2.9b-ii.** It carries the address as typed, exactly as the create shape does;
 * what happens to the *point* underneath it is decided by the service, because
 * only the service can know whether this listing already has an offset to honour.
 */
export type SubmittedListingEdit = Omit<SubmittedListing, 'ownerId' | 'categorySlug'>;

/**
 * A public listing and the disclosure that goes with it (slice 2.13).
 *
 * **Two values rather than one enriched record**, because they come from two
 * modules and the seam should stay visible. The listing is Catalogue's; the
 * status is the person's and is read through a port. Flattening them would make
 * it look as though the store knew something about the owner, and the next
 * person to add a field would put it in the wrong place.
 *
 * `ownerStatus` is non-nullable and is always `private_owner` today, because
 * `findPublic` refuses to return anything else. It is carried rather than
 * assumed for the reason a disclosure is carried at all: the day traders are
 * supported, the page renders the truth without being edited.
 */
export interface PublicListingView {
  readonly listing: PublicListingRecord;
  readonly ownerStatus: OwnerStatus;
}

/**
 * One search result: a listing, its disclosure, and how far away it is
 * (slice 3.1a).
 *
 * **Three values rather than an enriched record**, extending the reason
 * `PublicListingView` gives to a third source. The listing is Catalogue's, the
 * status is the person's, and the distance is neither — it is a fact about this
 * listing *and the origin this searcher chose*, which is why it cannot be a
 * field on anything the store returns.
 */
export interface NearbyListingView {
  readonly listing: PublicListingSummaryRecord;
  readonly ownerStatus: OwnerStatus;
  readonly distance: DistanceBucket;
}

/**
 * A page of search results, and whether there were more.
 *
 * `truncated` comes from the proximity query rather than from counting what
 * survived the visibility filter, and that is the honest reading: it answers
 * "were there more listings inside this radius", which is the question the
 * page's control acts on. A listing dropped by the owner's declaration is not a
 * page boundary.
 */
export interface NearbySearchResults {
  readonly results: readonly NearbyListingView[];
  readonly truncated: boolean;
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
 * Raised when an edit would leave a **published** listing incomplete (slice
 * 2.9b-ii).
 *
 * **The same rules as `ListingNotPublishableError` and a different error, because
 * it is a different sentence.** That one means "you asked to publish this and it
 * is not ready", and the reader is about to go and finish it. This means "it is
 * already in front of strangers and what you just saved would break it", and the
 * reader's next move is to put back whatever they removed — or to pause the
 * listing first, which is what makes the removal legitimate.
 *
 * **Why the check exists at all.** Publication evaluates completeness once, at
 * the moment of publishing. Nothing re-evaluated it afterwards, so through 2.9b-i
 * an owner could blank a published listing's description or clear its rates and
 * the platform would keep showing it. 2.9b-ii would have added the worst version
 * of that — a live listing with nowhere to collect from, or one no search can
 * find — so the guard lands here rather than being left for whoever noticed.
 *
 * **It is deliberately not a refusal to edit.** Every field can still be
 * corrected; what is refused is *emptying* one that a published listing needs.
 * An owner who genuinely wants the listing off the market pauses it, which is one
 * reversible action away and is what pause is for.
 */
export class PublishedListingIncompleteError extends Error {
  constructor(readonly blockers: readonly PublicationBlocker[]) {
    super(
      `A published listing cannot be left incomplete: ${String(
        blockers.length,
      )} thing(s) would be missing`,
    );
    this.name = 'PublishedListingIncompleteError';
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
 * **This used to say "slice 2.11 is where that changes", and 2.11 was deleted**
 * — concierge listing creation, an administrator writing a listing on somebody
 * else's behalf, removed from the BRD on 12 August 2026 because it assumes a
 * person on a telephone and this platform has no support desk and will not be
 * hiring one.
 *
 * The rule it was going to demonstrate still stands and is worth keeping here,
 * because the next thing to cross this line will need it: **a write performed by
 * one person about another person's listing is an administrative action (§8.13)
 * and must be audited as the administrator's, never recorded as though the owner
 * did it.** BRD §9 puts the hard edge on the same idea — *write-capable
 * impersonation is prohibited at launch*.
 *
 * `moderate` below is the one method here that does cross it, and it is audited.
 * Anything else that arrives belongs in its own method for the same reason,
 * **not as a flag on an owner's one** — a boolean is how an unaudited path and
 * an audited path come to share a body.
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
    /**
     * How a listing's owner lists — themselves or as a business (slice 2.13).
     *
     * A port this module declares and Profiles answers, the same shape as
     * `locator` and `publication` above. Required rather than optional for the
     * reason both of those are: an optional dependency is one several boot sites
     * forget, and the failure here would be **a legal disclosure silently
     * defaulting to absent**, which refuses every publication — loud — or, if
     * somebody 'fixed' that by defaulting the other way, silently publishes
     * traders as private individuals.
     */
    private readonly ownerStatuses: OwnerStatusSource,
    /**
     * Which listings are near a postcode (slice 3.1a, ADR 0044).
     *
     * The second port this module declares for Search & Location to answer, and
     * deliberately not a method on `locator`: that one is about **a listing's**
     * location and is used only on write paths, this one is about a search and
     * is the only public read in the module that touches geography. One port per
     * question keeps the write path unable to reach the search, and the search
     * unable to reach a coordinate.
     *
     * Required rather than optional, for the reason every dependency here is:
     * an optional one is what several boot sites forget, and the failure would
     * arrive as a search that silently finds nothing.
     */
    private readonly proximity: ListingProximity,
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
   * Rewrite what an owner wrote about their item (slice 2.9b-i, ADR 0042).
   *
   * **The same three steps `createDraft` takes, in the same order and for the
   * same reasons** — read the category's current configuration, refuse a stale
   * form, validate against the version about to be pinned — and the only reason
   * they are not shared code is that the category comes from a different place:
   * a draft names one, an edit inherits the listing's.
   *
   * **The listing is read first, and by the store, so ownership is a query
   * rather than a comparison.** A null here is both "no such listing" and "not
   * yours", which the route answers 404 to without distinguishing.
   *
   * **Editing re-pins, and that is ADR 0042 rather than a shortcut.** The form
   * an owner is looking at is built from the current configuration, so saving it
   * brings the listing onto that configuration. Nothing is silent: the current
   * questions are on screen, and publication still refuses a listing that has
   * not answered the required ones. What must never happen — and does not —
   * is a listing re-pinning without its owner having seen the new form.
   *
   * **Geocoding happens here from 2.9b-ii, and it is the one step that does not
   * mirror `createDraft`.** Creation calls `locator.locate`, which draws a fresh
   * fuzz offset; an edit must not, because an owner who saved three times would
   * publish three points scattered around one true address and their mean is the
   * address (§8.4.1, ADR 0032). `editedLocation` below decides which of the three
   * things to do and is where that rule is kept.
   *
   * **A published listing may not be edited into an incomplete one.** The
   * completeness rules run again when the listing is `PUBLISHED`, against the
   * values about to be written and the version about to be pinned. See
   * `PublishedListingIncompleteError`. A draft is left permissive, as §8.3
   * requires, and a paused listing is too — it is not in front of anybody, and
   * `publish` will refuse to resume it until it is complete.
   *
   * **Unaudited**, like every other owner action on their own listing. The test
   * is who performed it (§8.13): there is no second party here, so there is
   * nobody the entry would be *for*. An administrator editing somebody else's
   * listing would be a different method with its own entry — and there is no
   * such route, deliberately. Concierge creation was the slice that would have
   * added one and it was deleted on 12 August 2026.
   */
  async edit(
    id: string,
    ownerId: string,
    submitted: SubmittedListingEdit,
  ): Promise<ListingRecord | null> {
    const listing = await this.store.findOwnedBy(id, ownerId);
    if (listing === null) return null;

    const category = await this.categories.findOption(listing.categorySlug);
    /* c8 ignore next 2 -- unreachable: the listing holds a foreign key to a
       version of this category, so the category exists. */
    if (category === null) throw new UnknownCategoryError(listing.categorySlug);

    if (category.versionNumber !== submitted.categoryVersionNumber) {
      throw new CategoryChangedError(
        listing.categorySlug,
        submitted.categoryVersionNumber,
        category.versionNumber,
      );
    }

    // Against the **current** version's schema, which is the version about to be
    // pinned — not against the one the listing is on. Validating against the old
    // schema and then pinning the new one is the mismatch this whole ordering
    // exists to prevent.
    const values = validateAttributeValues(category.attributes, submitted.attributes);
    if (!values.ok) throw new AttributeValuesInvalidError(values.issues);

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

    // **After every refusal above**, for `createDraft`'s reason: geocoding is a
    // call to a third party, and spending it on an edit we are about to reject
    // would make a validation error take as long as the provider does.
    const location = await this.editedLocation(listing, ownerId, submitted);

    /*
     * **The completeness re-check, and only for a listing that is published.**
     *
     * It reads the values about to be written rather than the ones on the record,
     * which is the whole point — the question is what the listing will be once
     * this save lands, not what it is now. The category's attributes and options
     * come from `category`, the version about to be pinned, for the same reason.
     */
    if (listing.status === 'PUBLISHED') {
      const blockers = publicationBlockers({
        description: submitted.description,
        attributes: values.values,
        categoryAttributes: category.attributes,
        categoryTransportOptions: category.transportOptions,
        transportRequirement: submitted.transportRequirement,
        rates: submitted.rates,
        hasCollectionLocation: location.kind !== 'cleared',
        isLocated: willBeLocated(location),
        // Read here rather than carried on the record, because it is a fact
        // about the person and not about the listing — and because reading it
        // fresh means an owner who declares "business" stops being able to keep
        // a published listing complete from that moment, rather than from
        // whenever the listing was last written.
        ownerStatus: await this.ownerStatuses.findOwnerStatus(ownerId),
      });

      if (blockers.length > 0) throw new PublishedListingIncompleteError(blockers);
    }

    return this.store.update(id, ownerId, {
      title: submitted.title,
      description: submitted.description,
      replacementValue: submitted.replacementValue,
      attributes: values.values,
      transportRequirement: submitted.transportRequirement,
      requiresTwoPersonLift: submitted.requiresTwoPersonLift,
      rates: submitted.rates,
      collectionLocation: location,
      categoryVersionNumber: category.versionNumber,
    });
  }

  /**
   * Decide what this edit does to the listing's location — **the slice's whole
   * security argument, in one method** (slice 2.9b-ii, §8.4.1, ADR 0032).
   *
   * The rule it keeps: **a listing's fuzz offset is drawn once and reused for
   * ever.** Redrawing it publishes a second point around the same address, and
   * the mean of enough such points is the address. Nothing downstream would
   * notice — no test, no constraint, no error — which is why the decision is
   * concentrated here instead of being spread across the caller.
   *
   * Three outcomes, in the order they are decided:
   *
   * 1. **No address submitted → `cleared`.** Nothing to place.
   * 2. **Same postcode, and the listing is already located → `address-only`.**
   *    The lines and town are rewritten and the point is not touched. The
   *    geocoder is not called at all, so an outage cannot strip the coordinates
   *    off a listing whose location nobody changed.
   * 3. **Anything else → `relocated`.** Either the postcode moved, or it did not
   *    and there are no coordinates to keep — the second being the retry 2.5b
   *    left for an address a provider outage could not place. The stored offset
   *    is reused if there is one, and drawn only if there is not, which is the
   *    single place `locate` and `relocate` are chosen between.
   *
   * **The postcodes are compared exactly, and the failure direction is safe.**
   * Both sides are normalised by the contract before they are ever stored, so
   * they agree or the postcode genuinely changed. If two spellings of one
   * postcode ever did slip through, this would take case 3 and re-place the
   * listing **with its existing offset** — the same published point, recomputed.
   * Wasteful, not disclosing. There is no comparison result that redraws.
   */
  private async editedLocation(
    listing: ListingRecord,
    ownerId: string,
    submitted: SubmittedListingEdit,
  ): Promise<CollectionLocationEdit> {
    const location = submitted.collectionLocation;
    if (location === null) return { kind: 'cleared' };

    if (
      listing.collectionLocation?.postcode === location.postcode &&
      listing.isLocated
    ) {
      return { kind: 'address-only', location };
    }

    /*
     * Null means this listing has no coordinates yet — a draft that has never
     * given an address, or one whose postcode nothing could place — and in both
     * cases these coordinates are the first it will have, which is exactly what
     * `locate` is for. Anything else is a listing that already publishes a point,
     * and moving it must keep the offset that point was made with.
     */
    const offset = await this.store.findFuzzOffset(listing.id, ownerId);
    const point =
      offset === null
        ? await this.locator.locate(location.postcode)
        : await this.locator.relocate(location.postcode, offset);

    return { kind: 'relocated', location, point };
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
   * One listing, as anybody may see it, or null (slice 2.10).
   *
   * **Two lines long and it is still the right place for this to exist.** The
   * temptation is to have the controller call the store directly, since nothing
   * is decided here — but a public route reaching past the application service
   * into a repository is precisely the boundary BRD §5.1 draws, and the first
   * thing that will want to sit here is Phase 3's "and what else is nearby".
   *
   * **No `isPubliclyVisible` check on the way out**, and its absence is
   * deliberate rather than an omission: the store answers null for a listing
   * that is not visible, so a check here would be a second statement of the rule
   * that could disagree with the one that ran. The visibility decision has one
   * home, and it is the query.
   *
   * **The owner's declared status is read here and is a second visibility
   * rule** (slice 2.13), which is worth its own paragraph because it closes a
   * hole rather than merely adding a field. Publication settles completeness at
   * the moment of publishing and never looks again — so somebody could publish
   * as a private individual, then change their profile to say they list as a
   * business, and their listing would keep serving a disclosure that had become
   * untrue. Making public visibility *depend* on the declaration means the
   * disclosure cannot go stale: change your answer, and the listing stops being
   * public until you change it back.
   *
   * Returning null rather than an error keeps the route's one-answer rule
   * intact — a stranger cannot tell this apart from a paused listing, and should
   * not be able to.
   */
  async findPublic(id: string): Promise<PublicListingView | null> {
    const listing = await this.store.findPublished(id);
    if (listing === null) return null;

    const ownerStatus = await this.ownerStatuses.findOwnerStatus(listing.ownerId);

    // Not `!== 'professional_trader'`: an owner who has *never* declared must
    // not be published either, and writing the negative would have let null
    // through. The positive is the only form of this test that is safe as the
    // vocabulary grows.
    if (ownerStatus !== 'private_owner') return null;

    return { listing, ownerStatus };
  }

  /**
   * Listings near a postcode, nearest first (slice 3.1a, BRD §8.4).
   *
   * **Four steps, and the order of the last two is the security of the method.**
   * Proximity gives ids in distance order; the store hydrates them, re-applying
   * the two visibility columns; the owner's declaration is checked; and only
   * then is anything paired with its distance. Checking the declaration *after*
   * hydration rather than inside the geo query is ADR 0044's asymmetry — the
   * third authority lives in another module's table, and it excludes almost
   * nothing, so reading it there would buy a boundary crossing for nothing.
   *
   * **Null means the origin could not be placed**, not that nothing was found.
   * Both an unrecognised postcode and a geocoder that is briefly down arrive as
   * null, exactly as they do on the write path — and the caller collapses them,
   * because a searcher is owed one answer rather than a diagnosis of our
   * provider.
   *
   * **The order comes from `page.matches` and is not recomputed.** Exact
   * distances do not cross the proximity boundary (§8.4.1), so this method
   * *cannot* re-sort even if somebody wanted it to — which is why it walks the
   * matches and looks each listing up, rather than mapping over what the store
   * returned.
   *
   * **Owner statuses are deduplicated and resolved together.** It is still one
   * query per distinct owner, which is an N+1 in the strict sense and is left
   * standing deliberately: the fix is a batch method on `OwnerStatusSource`, and
   * a port method added for a page size we have never served would be
   * speculation. It is recorded as a known limitation rather than forgotten.
   */
  async searchNearby(
    originPostcode: string,
    radiusMiles: SearchRadiusMiles,
  ): Promise<NearbySearchResults | null> {
    const page = await this.proximity.findWithin(
      originPostcode,
      radiusMiles,
      SEARCH_RESULT_LIMIT,
    );
    if (page === null) return null;

    const summaries = await this.store.findPublishedSummaries(
      page.matches.map((match) => match.listingId),
    );
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));

    const ownerIds = [...new Set(summaries.map((summary) => summary.ownerId))];
    const ownerStatuses = new Map(
      await Promise.all(
        ownerIds.map(
          async (ownerId) =>
            [ownerId, await this.ownerStatuses.findOwnerStatus(ownerId)] as const,
        ),
      ),
    );

    const results: NearbyListingView[] = [];

    for (const match of page.matches) {
      const listing = byId.get(match.listingId);
      // Absent means it stopped being visible between the two queries — a
      // moderator acting in the milliseconds between them. Dropped silently,
      // for the reason `findPublic` returns null: a searcher must not be able
      // to tell a moderated listing from one that was never there.
      if (listing === undefined) continue;

      const ownerStatus = ownerStatuses.get(listing.ownerId) ?? null;
      // Not `!== 'professional_trader'`, for the reason `findPublic` gives: an
      // owner who has never declared must not be published either, and the
      // negative would have let null through.
      if (ownerStatus !== 'private_owner') continue;

      results.push({ listing, ownerStatus, distance: match.distance });
    }

    return { results, truncated: page.truncated };
  }

  /**
   * Every listing this owner has, newest first (slice 2.9a).
   *
   * **The same store method the export uses, deliberately.** `listOwnedBy` was
   * written for the data export and its docblock has said since slice H2 that
   * the owner dashboard should reuse it rather than adding a second query that
   * can drift in ordering — a dashboard showing the oldest listing at the top is
   * the kind of defect that survives for months because nobody can say what the
   * order was supposed to be.
   *
   * **The limit is this caller's own** (`OWNED_LISTING_LIMIT`), which is the
   * whole reason that port takes a required one. The export's thousand is an
   * answer to a legal question and would be a strange number for a page.
   *
   * Truncation is measured with the same probe-and-fit pair every bounded read
   * here uses, and it is **returned rather than only logged**: the page has to
   * be able to say so. A list that quietly stops is one somebody reads as their
   * whole record.
   */
  async listOwned(ownerId: string): Promise<Page<ListingRecord>> {
    const rows = await this.store.listOwnedBy(
      ownerId,
      Paging.probe(OWNED_LISTING_LIMIT),
    );
    const page = Paging.fitTo(rows, OWNED_LISTING_LIMIT);

    if (page.truncated) {
      // Logged as well as returned, for the reason `categoryOptions` logs: the
      // owner learns their list was cut, and nobody operating the platform would
      // otherwise know a guardrail had fired at all. This one is the milder of
      // the two — the reader is told — so it records that the bound was reached
      // rather than warning about something invisible.
      this.logger.warn('owned listing list truncated', {
        limit: OWNED_LISTING_LIMIT,
        surface: 'owner-dashboard',
      });
    }

    return page;
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
      ownerStatus: await this.ownerStatuses.findOwnerStatus(ownerId),
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
/**
 * Whether the listing will have coordinates once this edit lands.
 *
 * A `switch` over every case rather than `kind !== 'cleared'`, so that adding a
 * fourth case is a compile error here instead of a listing that silently reads as
 * located when it is not. `address-only` is only ever chosen for a listing that
 * is already located, which is the one thing this function has to take on trust —
 * `editedLocation` is a dozen lines away and is where that is decided.
 */
function willBeLocated(location: CollectionLocationEdit): boolean {
  switch (location.kind) {
    case 'cleared':
      return false;
    case 'address-only':
      return true;
    case 'relocated':
      return location.point !== null;
  }
}

function moderationAuditable(listing: ListingRecord): Record<string, unknown> {
  return {
    moderationState: listing.moderationState,
    moderationReason: listing.moderationReason,
  };
}
