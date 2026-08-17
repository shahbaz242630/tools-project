import type {
  CategoryAttribute,
  CategoryFeePolicy,
  CategoryTransportOption,
  ListingAttributeValues,
  ListingCollectionLocation,
  ListingStatus,
  ModerationState,
  PublicCategory,
  TransportRequirement,
} from '@platform/contracts';
import type { ListingRateCard } from '@platform/contracts';
import type { MoneyValue } from '@platform/core';
import type { LocatedListingPoint, StoredFuzzOffset } from './listing-locator.js';

/**
 * Listings, as the rest of the application sees them.
 *
 * **Every read here is scoped by owner, and that is the design.** There is no
 * `findById(id)` — only `findOwnedBy(id, ownerId)` — because a port offering an
 * unscoped read is a port some later route calls without remembering to check
 * whose listing it got back. The public projection slice 2.10 needs will be its
 * own method with its own name, so that the two can never be confused at a call
 * site.
 *
 * The Catalogue module reaches these rows only through this interface, the same
 * boundary rule that keeps Profiles out of `users` (BRD §5.1).
 */

/** A listing as its owner sees it, with the category it was written against. */
export interface ListingRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly categorySlug: string;
  readonly categoryName: string;
  readonly categoryVersionNumber: number;
  /**
   * The attribute schema **as pinned**, read from the version this listing
   * points at rather than from the category as it stands now.
   *
   * A value cannot be read without it: `25` means nothing until something says
   * it is a weight in kilograms at one decimal place, and `cordless` means
   * nothing without the label it was chosen by.
   */
  readonly categoryAttributes: readonly CategoryAttribute[];
  /**
   * The fee policy **as it stands now** — read from the category's latest
   * version, deliberately *not* from the one this listing pinned (ADR 0042).
   *
   * **Named `current` rather than `category…` because the field beside it is the
   * opposite.** `categoryAttributes` two lines up is pinned and must be; this is
   * not and must not be. Two fields resolved from two different versions of the
   * same row is the sort of thing that reads as a bug unless the names say so.
   *
   * **This docblock used to argue the other case, fluently, and slice 2.7c
   * replaced it.** It said the policy travels with the listing for the reason the
   * schema does, citing §8.2's rule that a booking retains the terms it was made
   * under. The rule is right and the inference was wrong: **a listing is not a
   * booking.** A listing is an offer standing in a shop window, and §3.4.4 wants
   * the price in that window to be the price payable today. It is the *booking*
   * that retains terms, and the booking pins this in Phase 5.
   *
   * The practical consequence is what settled it. With the policy pinned, an
   * owner editing their listing's title moved it to a newer version and silently
   * changed what they are paid — a money consequence attached to an unrelated
   * action, with no honest place to disclose it. ADR 0042 has the research: no
   * marketplace does per-listing fee versioning, and the UK P2B Regulation makes
   * a fee change an announcement with a notice period rather than a per-listing
   * consent.
   *
   * **Every read must resolve this afresh.** It cannot be captured when the row
   * is written, because the whole point is that it changes underneath a listing
   * nobody has touched.
   */
  readonly currentFeePolicy: CategoryFeePolicy;
  /**
   * Which transport requirements the **pinned** version offers (ADR 0029,
   * ADR 0031).
   *
   * Here for the reason the schema and the fee policy are: the publication rule
   * in slice 2.8a has to know whether this listing's category asks how an item
   * is collected *at all*, and a category configured before 2.4c-i offers
   * nothing. Reading today's options instead would make a listing publishable or
   * not according to a configuration change it never saw.
   */
  readonly categoryTransportOptions: readonly CategoryTransportOption[];
  readonly title: string;
  readonly description: string;
  readonly replacementValue: MoneyValue;
  /** What it costs to rent. Every rate null on a draft nobody has priced. */
  readonly rates: ListingRateCard;
  /** Answers keyed by attribute key. An unanswered attribute is absent. */
  readonly attributes: ListingAttributeValues;
  /** What it takes to collect it, or null on a draft that has not said (§8.3). */
  readonly transportRequirement: TransportRequirement | null;
  readonly requiresTwoPersonLift: boolean;
  /**
   * Where it is collected from, **decrypted**, or null on a draft that has not
   * said.
   *
   * This record is the owner's view, so it carries the precise half. The
   * decryption happens in the adapter, which is the only thing holding the key —
   * the same division `PrismaProfileStore` makes, and the reason neither service
   * ever sees an envelope.
   *
   * 2.10's public projection is a different method returning a different type
   * (`CoarseLocation`), so a route cannot reach the precise half by asking the
   * wrong question.
   */
  readonly collectionLocation: ListingCollectionLocation | null;
  /**
   * Whether the collection postcode has been resolved to a point (slice 2.5b).
   *
   * **A boolean, not the coordinates.** Nothing above the store needs to know
   * where the listing is: the owner sees their own address, and the published
   * point is Phase 3's business. What an owner does need to know is that their
   * listing is not yet locatable, because §8.3's draft is permissive and slice
   * 2.8 will refuse to publish without it.
   *
   * Exposing the pair here instead would put true coordinates on the record that
   * every controller maps to a response, which is exactly the shape §8.4.1 says
   * must never reach a public projection.
   */
  readonly isLocated: boolean;
  readonly status: ListingStatus;
  /**
   * What the platform permits, beside what the owner wants (ADR 0041).
   *
   * On the record rather than fetched separately because every read that
   * decides whether somebody may see this listing needs both, and a second
   * query would be a second chance to forget one.
   */
  readonly moderationState: ModerationState;
  /**
   * Why it was hidden, in the administrator's words — null while `APPROVED`.
   *
   * **Carried on the owner's record deliberately.** ADR 0024 settled that a
   * person reads the reason for a decision made about them, and a listing
   * removed from public view with no explanation is the thing that makes
   * somebody conclude the platform is arbitrary. Slice 2.8c-ii is what puts it
   * in front of them.
   */
  readonly moderationReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A listing as a stranger sees it, at the store boundary (slice 2.10).
 *
 * **A separate record rather than `ListingRecord` narrowed at the controller**,
 * and the difference is where the guarantee lives. `ListingRecord` carries
 * `collectionLocation` decrypted, because an owner reading their own listing
 * typed it; if the public route were served from that, the only thing standing
 * between a street address and the internet would be a mapping function
 * somebody has to keep correct. There is nothing to strip here, because the
 * street lines were never read.
 *
 * `town` and `outwardCode` come from the `listings` row, which has never held
 * anything finer than a postal district (§8.4.1, slice 2.5a). The query behind
 * this does not join `listing_locations`, and that is a stronger promise than a
 * `select` — a join that was never written cannot be forgotten.
 */
export interface PublicListingRecord {
  readonly id: string;
  /**
   * Whose listing it is — **so the service can ask Profiles a question, and for
   * nothing else** (slice 2.13).
   *
   * On the record and deliberately **not** on `PublicListing`. §8.3 requires the
   * page to disclose whether the owner is a private individual or a business,
   * which means somebody has to look the owner up; it does not require telling
   * the internet who they are. The wire type has no owner field and the mapper
   * has no line that could add one.
   */
  readonly ownerId: string;
  readonly categorySlug: string;
  readonly categoryName: string;
  /** The schema **as pinned**, so the stored answers can be read (ADR 0029). */
  readonly categoryAttributes: readonly CategoryAttribute[];
  /**
   * The fee policy **as it stands now** (ADR 0042), for the displayed price.
   *
   * Current rather than pinned for the reason `ListingRecord.currentFeePolicy`
   * gives, and it matters more here: §3.4.4 wants the price in the shop window
   * to be the price payable today, and this *is* the shop window.
   */
  readonly currentFeePolicy: CategoryFeePolicy;
  readonly title: string;
  readonly description: string;
  readonly rates: ListingRateCard;
  readonly attributes: ListingAttributeValues;
  readonly transportRequirement: TransportRequirement | null;
  readonly requiresTwoPersonLift: boolean;
  /** The publishable half of the address, and there is no other half here. */
  readonly outwardCode: string;
  readonly town: string;
}

/**
 * A listing as it appears in a list of search results (slice 3.1a).
 *
 * **Narrower again than `PublicListingRecord`, and built field by field.** The
 * detail projection is already the narrowest view of a listing in the system, so
 * reusing it and dropping two fields at the controller is the obvious move — and
 * it is how a results page comes to carry two thousand characters of description
 * per row, and the whole pinned attribute schema twenty-four times over. What a
 * card renders is a name, a category, a district, a price and a distance.
 *
 * `ownerId` is here for the reason it is on `PublicListingRecord`: so the
 * service can ask Profiles a question about the owner, and for nothing else. It
 * is not on the wire type.
 *
 * There is deliberately no `distance` field. Distance is not a property of a
 * listing — it is a property of a listing *and an origin somebody chose* — and
 * putting it on a record the store returns would mean the store had to know
 * about searching. The service pairs the two.
 */
/**
 * A listing as the quote engine needs it (slice 4.4b).
 *
 * **The narrowest projection in this module, and the only one with no words on
 * it.** No title, no description, no attributes, no district — a quote is
 * arithmetic about dates and money. Booking declares what it needs as
 * `QuotableListing`, and this is what fills it.
 *
 * **Two `current` fields and the id they came from.** ADR 0042: a listing reads
 * the *current* fee policy rather than the one it pinned, because a listing is not
 * a contract and §3.4.4 wants the price in the window to be the price payable
 * today. `currentCategoryVersionId` is what the quote stores, so the price it gave
 * can be explained afterwards — the pin ADR 0042 places at the moment of
 * commitment, arriving one phase earlier than that ADR expected because a quote is
 * already a commitment.
 */
export interface QuotableListingRecord {
  readonly id: string;
  /** So the service can refuse to quote somebody their own item. */
  readonly ownerId: string;
  /**
   * What the item is called and what kind of thing it is (slice 4.5a).
   *
   * **Added when a booking started copying its terms**, not for the quote: §8.2
   * requires a booking to keep what it was made under, so the words have to reach
   * Booking once, at the moment of booking. An address still does not.
   */
  readonly title: string;
  readonly categoryName: string;
  readonly rates: ListingRateCard;
  /** The fee policy **as it stands now** (ADR 0042). */
  readonly currentFeePolicy: CategoryFeePolicy;
  /**
   * The longest hire the category permits **as it stands now** (§8.5.3).
   *
   * Current rather than pinned, for the reason `QuotableListing` gives at length:
   * a pinned version gives stored answers their meaning, and a duration cap is a
   * rule about what may happen now — a legal one, which an administrator
   * narrowing a category has to be able to apply to the next hire.
   */
  readonly currentMaximumRentalDays: number;
  /**
   * How long the owner has to answer a request, in hours (§8.6, slice 4.5a).
   *
   * Current rather than pinned, like the cap above and for the same reason: it is
   * a rule about what may happen now, and a request records the deadline it was
   * actually given.
   */
  readonly currentRequestExpiryHours: number;
  readonly currentCategoryVersionId: string;
}

export interface PublicListingSummaryRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly categoryName: string;
  /** The fee policy **as it stands now** (ADR 0042), for the displayed price. */
  readonly currentFeePolicy: CategoryFeePolicy;
  readonly title: string;
  readonly rates: ListingRateCard;
  /** The publishable half of the address, and there is no other half here. */
  readonly outwardCode: string;
  readonly town: string;
}

/**
 * One moderation decision, as the store is asked to write it.
 *
 * A named shape rather than four positional arguments, because three of them
 * are strings and `moderate(id, reason, moderatorId, state)` is a bug nothing
 * would catch — the compiler cannot tell a reason from an id.
 */
export interface ModerationDecision {
  readonly listingId: string;
  readonly state: ModerationState;
  /** Null only where `moderationRequiresReason` says none is needed. */
  readonly reason: string | null;
  /** The administrator, by platform id. Never the Clerk id (ADR 0015). */
  readonly moderatorId: string;
  readonly decidedAt: Date;
}

/**
 * What an owner supplies, plus what the server decides.
 *
 * `categoryVersionId` and `categoryId` are **not** here: the store resolves them
 * from the slug itself, at the moment of writing. Passing them in would mean a
 * caller could pin a version it read some time ago, which is exactly the stale
 * pin the version exists to prevent — and it would put the burden of keeping the
 * pair consistent on every caller rather than on the one place that can.
 */
export interface ListingDraft {
  readonly ownerId: string;
  readonly categorySlug: string;
  readonly title: string;
  readonly description: string;
  readonly replacementValue: MoneyValue;
  /**
   * Already validated against the schema on version `categoryVersionNumber`.
   *
   * The store does not know the attribute vocabulary and must not learn it —
   * that is domain logic and lives in the service (BRD §5.1). What the store
   * guarantees is narrower and is the thing the service cannot do for itself:
   * that the version it ends up pinning is the version these were checked
   * against.
   */
  readonly attributes: ListingAttributeValues;
  /**
   * Already checked against the options on version `categoryVersionNumber`.
   *
   * Same division of labour as the attributes: the service decides whether the
   * category offers this requirement, because that is domain meaning, and the
   * store only guarantees the version it pins is the one that was checked.
   */
  readonly transportRequirement: TransportRequirement | null;
  readonly requiresTwoPersonLift: boolean;
  /**
   * What it costs to rent (§8.5.2).
   *
   * Validated by the contract before it reaches here — the daily rate is the
   * spine and the others are alternatives to it — and the database refuses the
   * same shape independently. Nothing about a rate is category configuration, so
   * unlike the attributes and the transport requirement there is no per-version
   * check for the service to do.
   */
  readonly rates: ListingRateCard;
  /**
   * Where the item is collected from, in plaintext.
   *
   * **The port speaks plaintext and the adapter encrypts**, exactly as
   * `ProfileStore` does. It is what stops a caller forgetting to encrypt on a
   * path somebody adds later: there is no way to reach the database with a
   * street line except through the one method that puts it in an envelope.
   *
   * The outward code is *not* here. It is derived from the postcode on write, in
   * the adapter, because that is the only place the two can diverge — the same
   * reasoning `addresses.outwardCode` records.
   */
  readonly collectionLocation: ListingCollectionLocation | null;
  /**
   * Where that postcode is, with its fuzz offset already drawn (slice 2.5b).
   *
   * **Null is ordinary**, and means either that the geocoder does not recognise
   * the postcode or that it could not be reached. §8.3 makes a draft permissive
   * and neither may stop a save; slice 2.8 is where publication refuses a
   * listing nothing can find.
   *
   * Always null when `collectionLocation` is null — there is nothing to
   * geocode — and the store does not check that, because the service is what
   * produces both from one address. What the *database* checks is the narrower
   * thing only it can see: that all six coordinate columns are set together.
   *
   * Like the attribute values, this arrives already decided. The store does not
   * know what a fuzz offset is and must not learn: that is domain logic living
   * in Search & Location (BRD §5.1).
   */
  readonly locatedPoint: LocatedListingPoint | null;
  /**
   * The version the values above were validated against.
   *
   * **This is a guard, not a choice.** The store still pins whatever is current
   * when it writes; if that is no longer this number, it refuses rather than
   * writing answers checked against a schema that has been replaced. Closing
   * that window inside the write is the only place it can be closed — a check
   * in the service would leave the gap between its read and the store's.
   */
  readonly categoryVersionNumber: number;
}

/**
 * What an edit does to a listing's collection address (slice 2.9b-ii).
 *
 * Three cases, and the one that carries the slice is the middle one.
 */
export type CollectionLocationEdit =
  /**
   * **The address is rewritten and the point is left exactly as it is.**
   *
   * Taken when the postcode has not changed and the listing is already located —
   * somebody correcting a flat number, or saving a form they only came to for the
   * title. The street lines and town are rewritten; the six coordinate columns
   * are not read, not recomputed and not written.
   *
   * It is the case worth having for two reasons beyond saving a call to somebody
   * else's service. A geocoder that is briefly down must not be able to strip the
   * coordinates off a listing whose location nobody touched. And a point that is
   * never recomputed is a point that cannot be recomputed *wrongly*.
   */
  | { readonly kind: 'address-only'; readonly location: ListingCollectionLocation }
  /**
   * **The address and the point are both rewritten.**
   *
   * Taken when the postcode changed, and also when it did not but the listing has
   * no coordinates — which is the only retry 2.5b left for an address a provider
   * outage could not place, and would be lost if this case keyed off the postcode
   * alone.
   *
   * `point` is null when nothing could place the postcode, which nulls all six
   * coordinate columns together. That is ordinary for a draft (§8.3) and is
   * refused for a published listing before it ever reaches the store.
   *
   * **The offset inside `point` is the service's to get right, not the store's.**
   * One offset per listing, drawn once and reused for ever including across a
   * move (§8.4.1, ADR 0032). The store cannot check that and must not try — the
   * fuzz maths lives in Search & Location (BRD §5.1). What the database checks is
   * the narrower thing only it can see: all six columns set together, and the
   * distance clearing the floor.
   */
  | {
      readonly kind: 'relocated';
      readonly location: ListingCollectionLocation;
      readonly point: LocatedListingPoint | null;
    }
  /**
   * **The address is removed entirely**, and the publishable pair with it.
   *
   * A real operation rather than a missing argument: the form posts back what it
   * was given, so an empty address is somebody who emptied it. Whether they are
   * *allowed* to is the service's question — a published listing may not be left
   * with nowhere to collect from.
   */
  | { readonly kind: 'cleared' };

/**
 * What an owner may rewrite about a listing they already have (slice 2.9b-i).
 *
 * **Deliberately not `Partial<ListingDraft>`.** A partial is a shape where
 * "absent" and "clear this" are the same value on the wire, and the field that
 * would suffer is the one somebody most regrets losing — a description they had
 * written. Every field here is present on every edit, and the form sends back
 * what it was given.
 *
 * `ownerId` is absent too, unlike `ListingDraft`: it is an argument to `update`
 * rather than part of the payload, because it identifies *which row may be
 * written* rather than what to write. A field on the object is one a caller could
 * set to somebody else.
 */
export interface ListingEdit {
  readonly title: string;
  readonly description: string;
  readonly replacementValue: MoneyValue;
  /** Already validated against the schema on the version about to be pinned. */
  readonly attributes: ListingAttributeValues;
  /** Already checked against the options on the version about to be pinned. */
  readonly transportRequirement: TransportRequirement | null;
  readonly requiresTwoPersonLift: boolean;
  readonly rates: ListingRateCard;
  /**
   * What this edit does to the collection address (slice 2.9b-ii).
   *
   * **One field of three shapes rather than an address beside a point**, and the
   * reason is that the pair has a combination which must never be written: an
   * address removed while its coordinates stay behind, or coordinates replaced
   * while the address they belong to does not. Two nullable fields can express
   * both; this cannot express either.
   *
   * It is also where the §8.4.1 rule is *visible* rather than implied. The
   * adapter switches on three cases and writes each literally, so a reader can
   * see that one of them deliberately does not touch the point.
   */
  readonly collectionLocation: CollectionLocationEdit;
  /**
   * The version the values above were validated against — a guard, not a choice,
   * exactly as on `ListingDraft`.
   *
   * The store pins whatever is current when it writes. If that is no longer this
   * number, it refuses rather than writing answers checked against a schema that
   * has been replaced.
   */
  readonly categoryVersionNumber: number;
}

/**
 * Raised when the category a draft names does not exist.
 *
 * Its own error rather than a null return, because the caller has to tell it
 * apart from "you have no listing with that id": one is a 404 about a category
 * the owner chose from a list that has since changed, and the other is a 404
 * about a listing. Same status code, completely different message.
 */
export class UnknownCategoryError extends Error {
  constructor(readonly slug: string) {
    super(`No category has the slug "${slug}"`);
    this.name = 'UnknownCategoryError';
  }
}

/**
 * Raised when the category was reconfigured while the form was open.
 *
 * A 409 rather than a 400: nothing the owner typed is wrong, and there is no
 * field for them to correct. The configuration moved underneath them, which is
 * a conflict about state rather than a fault in the request.
 *
 * **It is refused rather than accommodated, and that is the point.** Validating
 * against the new schema instead would silently drop an answer to an attribute
 * that had just been renamed or removed — throwing away something somebody typed
 * without telling them. Pinning the old version instead would be worse: the
 * listing would claim configuration nobody could see any more.
 */
export class CategoryChangedError extends Error {
  constructor(
    readonly slug: string,
    readonly expectedVersionNumber: number,
    readonly actualVersionNumber: number,
  ) {
    super(
      `Category "${slug}" was configured as version ${String(
        expectedVersionNumber,
      )} when this form was opened and is now version ${String(actualVersionNumber)}`,
    );
    this.name = 'CategoryChangedError';
  }
}

export interface ListingStore {
  /**
   * Create a draft, pinning whichever category version is current right now.
   *
   * Throws `UnknownCategoryError` if the slug names no category, and
   * `CategoryChangedError` if the version it would pin is not the one the
   * draft's values were validated against.
   */
  createDraft(draft: ListingDraft): Promise<ListingRecord>;

  /**
   * One listing, but only if this owner owns it.
   *
   * Resolves to null both when the listing does not exist and when it belongs to
   * somebody else, so that a caller cannot accidentally distinguish the two —
   * telling a stranger "that exists but is not yours" confirms it exists.
   */
  findOwnedBy(id: string, ownerId: string): Promise<ListingRecord | null>;

  /**
   * Whether this owner owns this listing — the question, without the listing
   * (slice 4.3b).
   *
   * **A separate method rather than `findOwnedBy(…) !== null` at the call
   * site**, and it is the collection address that makes it worth one. That
   * record carries the decrypted street lines, so answering a yes/no question
   * with it means decrypting somebody's address to throw it away — and putting
   * it, however briefly, in a module that has no business holding one. Booking
   * asks this through a port and gets a boolean back (§8.4.1, BRD §5.1).
   *
   * **It reads nothing but the id**, so it cannot grow a projection later: a
   * caller that wants a field has to go and ask for the listing, in the place
   * that is entitled to it.
   *
   * True for a listing in any state. Ownership is not visibility — an owner may
   * manage a draft, a paused listing and one the platform has hidden, and the
   * routes that care about `status` or `moderationState` check them by name.
   */
  existsOwnedBy(id: string, ownerId: string): Promise<boolean>;

  /**
   * Rewrite what this owner wrote about their item (slice 2.9b-i, ADR 0042).
   *
   * **Re-pins to the category's current version as it writes**, which is the
   * whole of ADR 0042's fourth point: an owner editing a listing is looking at a
   * form built from the current configuration, so the listing comes onto it.
   * Nothing is silent — the current questions are on screen, and the publication
   * gate already refuses a listing that has not answered the required ones.
   *
   * It re-pins **within the same category** and cannot move between categories:
   * `categorySlug` is not on `ListingEdit` at all, and the composite foreign key
   * would refuse a version belonging to another category even if it were.
   *
   * **It writes `listing_locations` from 2.9b-ii**, and this docblock used to say
   * the opposite — that leaving the row alone *was* the behaviour, because
   * changing an address means geocoding again and the offset must survive. That
   * is still the rule; what changed is where it is kept. The offset arrives
   * already decided on `ListingEdit.locatedPoint`, so this method writes six
   * numbers it does not interpret, and the guarantee lives one layer up where the
   * fuzz maths does (BRD §5.1).
   *
   * A null `collectionLocation` removes the row and the publishable pair with it.
   * That is a real operation rather than a missing argument, and the service
   * refuses it for a listing that is published — nowhere to collect from is not a
   * state a live listing may be left in.
   *
   * **It does not touch `status` or `moderationState`.** Publishing and
   * pausing are their own transitions with their own preconditions, and
   * moderation is not the owner's (ADR 0041). Editing a published listing leaves
   * it published, which is what an owner correcting a typo expects.
   *
   * Throws `CategoryChangedError` when the version it would pin is not the one
   * the edit's values were validated against — the same guarantee `createDraft`
   * makes, inside the same read that resolves the version, because only there can
   * the window between the service's read and the write be closed.
   *
   * Resolves to null when no such listing belongs to this owner, matching
   * `findOwnedBy` so a stranger cannot tell "not yours" from "does not exist".
   */
  update(id: string, ownerId: string, edit: ListingEdit): Promise<ListingRecord | null>;

  /**
   * This listing's stored fuzz offset, or null if it has never had one (slice
   * 2.9b-ii).
   *
   * **Its own method rather than a field on `ListingRecord`, and that is the
   * decision worth defending.** The record is what every controller maps to a
   * response, and §8.4.1's rule is kept by there being nothing location-shaped on
   * it beyond `isLocated` — a boolean chosen precisely so a projection cannot leak
   * a point by forgetting a `select`. An offset is not a point and would leak
   * nothing, but putting it there would make the record the place location data
   * accumulates, and the next field added under the same argument might be one
   * that matters. A method that has to be called on purpose is harder to include
   * by accident.
   *
   * **Owner-scoped like every other read here**, even though the only caller has
   * already proved ownership a statement earlier. The rule in this port is that a
   * read takes an owner; an exception that is safe today is one somebody reuses
   * tomorrow from a route that has proved nothing.
   *
   * Null covers both "no such listing" and "no coordinates yet", because the
   * caller does the same thing with each: draw a new offset, since in both cases
   * this listing has no point to be consistent with.
   */
  findFuzzOffset(id: string, ownerId: string): Promise<StoredFuzzOffset | null>;

  /**
   * This owner's listings, newest first, at most `limit` of them.
   *
   * Exists for the data export, which is what made Catalogue a personal-data
   * module in the first place. Slice 2.9's owner dashboard wants the same query
   * and should reuse it rather than adding a second one that can drift in
   * ordering.
   *
   * **`limit` is required rather than defaulted, and that is the point of slice
   * H2.** An optional bound is one a caller omits, and the omission is invisible
   * until the table is large — which is exactly how this method spent five
   * slices reading every listing an owner had ever written. A caller that wants
   * to know whether it saw everything asks for `Paging.probe(n)` and reads the
   * answer with `Paging.fitTo`; nothing here infers truncation from a full page,
   * because a page that is exactly full is indistinguishable from a complete
   * one.
   */
  listOwnedBy(ownerId: string, limit: number): Promise<readonly ListingRecord[]>;

  /**
   * Move a listing to `PUBLISHED`, but only if this owner owns it.
   *
   * **Named for the transition rather than as `setStatus`**, for the reason
   * `addVersion` is not called `update`: a port offering an arbitrary status
   * write is one some later route uses to move a listing into a state nothing
   * checked the preconditions for. Each transition gets its own method and its
   * own guarantees — `pause` below is the second, and it is the only one 2.8b
   * added, because archive was removed from the BRD rather than built.
   *
   * **The completeness rules are not checked here**, and cannot be: they read
   * the `required` flags on the pinned category version's schema, which is JSON
   * in another table. The service decides whether a listing may be published;
   * this guarantees only what it alone can see — that the row belongs to this
   * owner, and that the write happened.
   *
   * **Idempotent**, as every state transition in this system is (CLAUDE.md).
   * Publishing an already-published listing succeeds and changes nothing but
   * `updatedAt`.
   *
   * Resolves to null when no such listing belongs to this owner, matching
   * `findOwnedBy` so a stranger cannot tell "not yours" from "does not exist".
   */
  publish(id: string, ownerId: string): Promise<ListingRecord | null>;

  /**
   * Move a listing to `PAUSED`, but only if this owner owns it (slice 2.8b).
   *
   * The mirror of `publish`, and deliberately as dull: the *state machine* lives
   * in `@platform/contracts` and the decision to allow this in the service. This
   * guarantees only what it alone can see — the row belongs to this owner, and
   * the write happened.
   *
   * **The filter is id and owner, and deliberately not `status: 'PUBLISHED'`.**
   * Adding the status would make a repeated pause report zero rows touched,
   * which the service cannot tell apart from "not yours" — trading idempotence
   * for a 404 on a request that succeeded the first time. `publish` made the
   * same choice for the same reason.
   *
   * Resolves to null when no such listing belongs to this owner.
   */
  pause(id: string, ownerId: string): Promise<ListingRecord | null>;

  /**
   * One listing, as **anybody** may see it — or null (slice 2.10).
   *
   * **The only read here that is neither owner-scoped nor administrative**, and
   * the one whose result reaches people who have not signed in. Two things
   * follow from that, and both are this method's job rather than the caller's:
   *
   * **It returns null for a listing that is not publicly visible**, not the
   * listing with a flag on it. A caller that received the row and had to decide
   * would be a caller that could forget, and the thing it would disclose is a
   * listing an owner paused or a moderator rejected. The route answers 404 to
   * null, so "not visible" and "does not exist" are one answer — a stranger
   * cannot use this to learn that a listing exists.
   *
   * **The visibility rule is `isPubliclyVisible`, restated in SQL here because
   * it has to be indexable** (Phase 3 filters millions of rows on it, and a
   * predicate in TypeScript cannot use an index). That restatement is the one
   * duplication of the rule in the system, and what holds the two together is a
   * db test walking all nine status × moderation pairs.
   *
   * **The projection is narrower than `ListingRecord` and that is structural.**
   * It returns `PublicListingRecord`, which has no decrypted address on it at
   * all, so the precise half cannot travel to a public route by a caller
   * forgetting to strip it. The query does not join `listing_locations`.
   */
  findPublished(id: string): Promise<PublicListingRecord | null>;

  /**
   * Several listings at once, as anybody may see them — for search (slice 3.1a).
   *
   * **The visibility predicate is applied here too, and that is not belt and
   * braces for its own sake.** The ids arrive from `ListingProximity`, which
   * filters on the same two columns inside its own SQL (ADR 0044) — so this
   * repeats a check that has already passed. It repeats it because the two
   * queries are not one transaction: a moderator can reject a listing in the
   * milliseconds between them, and the alternative to re-checking is serving
   * that listing because a different query said so a moment earlier. It is also
   * what stops this method becoming an unscoped bulk read that some later route
   * calls with ids from anywhere.
   *
   * **Returns what it found, in no promised order, and silently omits the
   * rest.** Both halves are deliberate. Order belongs to the caller, which has
   * the distances this method cannot see. Omission rather than nulls or an error
   * is right because a missing row means the listing stopped being visible
   * between the two queries, which is not exceptional and is not the caller's to
   * distinguish — it is the same "one answer for every reason" rule
   * `findPublished` follows.
   *
   * **Bounded by the caller's `ids`**, so there is no `limit` argument: the
   * bound was applied by the query that produced them (ADR 0035). A caller
   * handing this an unbounded list has already lost the argument upstream.
   */
  findPublishedSummaries(
    ids: readonly string[],
  ): Promise<readonly PublicListingSummaryRecord[]>;

  /**
   * What is needed to price a hire of this listing, or null (slice 4.4b).
   *
   * **Its own method rather than two fields added to `findPublished`**, and the
   * reason is the argument the record types here keep making: every projection is
   * built field by field for what its caller renders. The public listing page has
   * no use for a category version id or a duration cap, and putting them on its
   * record would mean a page holding configuration identifiers it will never show.
   *
   * **The same visibility predicate as `findPublished`**, so a quote cannot be
   * given for a paused or rejected listing. That predicate is now stated in three
   * queries and the db test that walks all nine status × moderation pairs is what
   * holds them together — which is the argument for `PUBLICLY_VISIBLE` being one
   * constant rather than three literals.
   *
   * **It does not read the owner's declaration**, and so is not the whole rule.
   * ADR 0044's asymmetry: that authority lives in another module's table, and the
   * service composes it — exactly as `findPublic` does.
   */
  findQuotable(id: string): Promise<QuotableListingRecord | null>;

  /**
   * Read a listing without knowing whose it is (slice 2.8c-i).
   *
   * **The first read in this module that is not owner-scoped, and that is the
   * whole security note.** Every other read and write here puts the owner in the
   * `where` precisely so a forgotten comparison cannot disclose or change
   * somebody else's listing. A moderator acts on listings that are by definition
   * not theirs, so that protection is unavailable and **the role check at the
   * guard is the entire control**.
   *
   * Named `findForModeration` rather than `findById` for that reason. A method
   * called `findById` is one somebody reaches for from an owner-facing service
   * without noticing what it skips; this name does not fit that sentence.
   */
  findForModeration(id: string): Promise<ListingRecord | null>;

  /**
   * Set what the platform permits, and record who decided (ADR 0041).
   *
   * Not owner-scoped, for the reason above. **Idempotent**, as every transition
   * here is: setting the state it is already in succeeds and rewrites the
   * author and the timestamp, because a second moderator agreeing is a real
   * decision and the trail should show the most recent one.
   *
   * The reason is the caller's to validate — `moderationRequiresReason` decides
   * whether one is needed and the database enforces it as a last resort. This
   * writes what it is given.
   */
  moderate(input: ModerationDecision): Promise<ListingRecord | null>;

  /** Every listing id this owner has, for the erasure path to ask about. */
  listIdsOwnedBy(ownerId: string): Promise<readonly string[]>;

  /**
   * Erase this owner's listings — **deleting the ones nothing has booked, and
   * collapsing the ones something has** (slice 4.2).
   *
   * **The day predicted in 2.8b has arrived, and this is what it changed.**
   * That slice deleted listings outright on the product owner's decision of
   * 10 August 2026, and §10.1 permitted it because nothing referred to a
   * listing — while warning, in this very docblock, that *"whoever adds the
   * booking foreign key must come back here"*. Slice 4.2 added it. A booking
   * now points at a listing, so deleting the row would leave a **renter's**
   * rental history pointing at nothing — which is what §10.1's carve-out for
   * records the platform must retain exists to prevent — and, more bluntly,
   * the foreign key would simply refuse and account deletion would fail.
   *
   * **So the rule is delete-if-unreferenced, collapse-if-referenced.** For a
   * referenced listing the `listing_locations` row goes — that is where the
   * street lines and the full postcode live — and the listing itself stays,
   * holding the district and town it was always published at (§8.4.1). The
   * owner's personal data is gone either way; what survives is the shell a
   * renter's history needs to still make sense.
   *
   * **`retain` is a set of ids rather than a predicate this store evaluates**,
   * because bookings are another module's table (BRD §5.1). Catalogue asks
   * through `BookingReferences` and passes the answer down; the store is told
   * which rows to keep and never learns why.
   *
   * **Idempotent**, as `PersonalDataEraser` requires: deleting what is already
   * gone is a success, because a retry after a partial failure has to finish
   * the job. Collapsing an already-collapsed listing is likewise a no-op.
   *
   * **What this does not do is unpublish.** A collapsed listing keeps its
   * `status`, and slice 4.3's calendar and 4.6's acceptance are where a listing
   * whose owner no longer exists stops being bookable — that is a lifecycle
   * decision with a product answer, not something to smuggle into an erasure.
   * Recorded because the omission looks like a bug from here.
   */
  eraseOwnedBy(ownerId: string, retain: ReadonlySet<string>): Promise<void>;
}

/**
 * The categories somebody choosing one may see.
 *
 * A separate port from `CategoryStore`, deliberately. That one serves the admin
 * surface and returns the risk level and the reportable-activity flag; this
 * returns what an owner needs to pick a category and fill in its fields, and
 * nothing else. Two ports rather than one with a projection argument, for the
 * reason `profiles.ts` gives about its two response shapes: a projection
 * argument is one a caller can forget.
 *
 * The attribute schema is on both, and that is not duplication — it is the one
 * piece of category configuration an owner legitimately needs, because it is the
 * form they are about to fill in.
 */
export interface CategoryOptionRecord {
  readonly slug: string;
  readonly name: string;
  /** The current schema, in render order. Empty is legitimate. */
  readonly attributes: readonly CategoryAttribute[];
  /**
   * Which transport requirements this category offers, and their weight
   * thresholds (§8.3, ADR 0031). Empty means the listing form asks nothing about
   * how the item is collected, which is what a category configured before slice
   * 2.4c-i has.
   */
  readonly transportOptions: readonly CategoryTransportOption[];
  /** Which version the schema above came from. */
  readonly versionNumber: number;
}

export interface CategoryOptionSource {
  /**
   * Categories, oldest first, as options — at most `limit` of them.
   *
   * **Bounded even though this table is small** (slice H2, ADR 0035). Categories
   * arrive only through an audited administrative form, so the row count is a
   * decision somebody made rather than a number users can drive; the bound is a
   * guardrail against a bug or a bad migration, not a page size. It is set far
   * above any plausible catalogue for that reason.
   *
   * It still must not truncate silently. A picker missing a category is a
   * category nobody can list in, with nothing on screen saying so — which is why
   * the caller probes for one extra row and says something when it comes back.
   */
  listOptions(limit: number): Promise<readonly CategoryOptionRecord[]>;

  /**
   * One category's current configuration, or null if the slug names none.
   *
   * Separate from `listOptions` rather than filtering it, because the service
   * needs exactly one row on the write path and reading every category to find
   * it would be a query that grows with the catalogue on the hottest path a
   * listing has.
   */
  findOption(slug: string): Promise<CategoryOptionRecord | null>;

  /**
   * The id of the category with this slug, or null if none has it (slice 3.2a).
   *
   * **An id and nothing else, which is the whole point of it being separate
   * from `findOption`.** The search path needs one thing — a value to compare
   * `listings."categoryId"` against — and `CategoryOptionRecord` carries none:
   * it holds the attribute schema and the transport options, because it exists
   * to render a form. Adding an id to that record so this caller could reach it
   * would hand an identifier to every consumer of a port whose docblock says it
   * returns *"what an owner needs to pick a category and fill in its fields, and
   * nothing else"*.
   *
   * **Not `findOption(slug) !== null` either**, which is the tempting reuse:
   * that reads the whole configuration — the attributes JSON and the transport
   * options — on the hottest public read in the system, to answer a question a
   * unique-index lookup answers.
   *
   * Null means no category, never "every category". The caller must not be able
   * to confuse the two, and `resolveSearchCategory` is where that is enforced.
   */
  findCategoryId(slug: string): Promise<string | null>;

  /**
   * Every category as a slug and a name, oldest first — at most `limit`
   * (slice 3.2b).
   *
   * **Narrow because the caller is the public search filter**, and the rule this
   * follows is the one `PublicListingSummary` records: a public shape is built
   * field by field rather than by narrowing a wider one. `listOptions` returns
   * the attribute schema and the transport options because an owner is about to
   * fill in a form; on the search path those are fields somebody has to remember
   * not to project, on the one route with no rate limit in front of it. Here
   * there is nothing to forget.
   *
   * **Bounded for `listOptions`' reason** (ADR 0035): rows arrive only through an
   * audited administrative form, so the count is a decision somebody made rather
   * than a number users can drive, and the bound is a guardrail against a bug.
   * It must not truncate silently — a category missing from the filter is
   * inventory a searcher cannot reach, with a control that looks complete.
   */
  listCategoryNames(limit: number): Promise<readonly PublicCategory[]>;
}
