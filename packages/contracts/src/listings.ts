/**
 * Listings — the first thing a *user* creates rather than an administrator.
 *
 * Its own file rather than part of `catalogue.ts`, though BRD §5.1 puts both in
 * the Catalogue module. A category is configuration written by one of us and
 * read by everybody; a listing is content written by a stranger about an object
 * we have never seen. They diverge immediately — a listing acquires media,
 * a fuzzed location, prices, moderation state and a lifecycle, none of which a
 * category has — and the authority to write one is completely different.
 *
 * **A draft is deliberately permissive.** §8.3 says owners "create draft
 * listings and save progress", so this shape holds a half-finished thing on
 * purpose. Completeness is enforced at publication (slice 2.8), not here.
 * Getting that backwards would mean an owner cannot save until they have
 * everything, which is exactly what makes people abandon a listing form.
 */

import { z } from 'zod';
import { inclusiveDailyPriceSchema, listingRateCardSchema } from './pricing.js';
import type { InclusiveDailyPrice, ListingRateCard } from './pricing.js';
import { postalAddressResponseSchema, postalAddressSchema } from './address.js';
import type { PostalAddress } from './address.js';
import { boundedMoneySchema, moneySchema } from './money.js';
import { categoryAttributesSchema, categorySlugSchema } from './catalogue.js';
import type { CategoryAttribute } from './catalogue.js';
import {
  categoryTransportOptionsSchema,
  transportRequirementSchema,
} from './transport.js';
import type { CategoryTransportOption, TransportRequirement } from './transport.js';
import type { ListingAttributeValues } from './attribute-values.js';
import { hasUnsafeCharacters, UNSAFE_CHARACTERS_MESSAGE } from './text.js';
import { MAX_ADMIN_REASON_LENGTH, MIN_ADMIN_REASON_LENGTH } from './admin.js';
import { parseWith } from './parse.js';

/** Where an owner creates listings and lists their own. */
export const LISTINGS_PATH = '/listings';
export const LISTINGS_ROUTE = '/listings';

/** One listing, addressed by id — it has no stable public slug until 2.12. */
export function listingPath(id: string): string {
  return `/listings/${encodeURIComponent(id)}`;
}

export const LISTING_ROUTE = '/listings/:id';

/**
 * Publishing one (§8.3, slice 2.8a).
 *
 * **A sub-resource with its own verb rather than a `PATCH` carrying a status.**
 * A status field a caller may set is a field a caller may set to anything, and
 * every transition would then need its preconditions checked by whatever route
 * happened to receive it. Naming the transition makes the rules belong to it.
 *
 * `POST` rather than `PUT`: it is not idempotent in the HTTP sense of replacing
 * a representation, though the *transition* is idempotent (publishing twice is
 * not an error).
 *
 * **`DELETE` on this same path pauses (2.8b), and that is a departure from what
 * this docblock originally predicted.** It said pause and archive would become
 * "two more paths". Archive was then removed from the BRD entirely, and pause
 * turned out to be the exact inverse of the operation this path already names —
 * removing the publication. A `/pause` path beside `/publication` would have
 * been a second name for one resource, and the pair `POST`/`DELETE` says which
 * two operations are opposites in a way two nouns cannot.
 *
 * `POST` therefore serves **resume** as well as publish: to an owner they are
 * different words, but to the platform resuming *is* publishing, subject to the
 * same completeness gate and the same kill switch.
 */
export function listingPublicationPath(id: string): string {
  return `/listings/${encodeURIComponent(id)}/publication`;
}

export const LISTING_PUBLICATION_ROUTE = '/listings/:id/publication';

/**
 * Where any signed-in user reads the categories they could list in.
 *
 * Separate from `/admin/categories`, which requires the admin role and a second
 * factor. This returns the minimum an owner needs to choose one, and it exists
 * because a create form with nothing to choose from is a dead control.
 */
export const CATEGORY_OPTIONS_PATH = '/categories';
export const CATEGORY_OPTIONS_ROUTE = '/categories';

/**
 * Where an administrator decides what the platform permits of a listing
 * (§8.3, §9, ADR 0041, slice 2.8c-i).
 *
 * **Under `/admin`, not beside the owner's routes**, and the prefix is doing
 * real work rather than tidying. Every other listing path is owner-scoped and
 * answers 404 for somebody else's listing; this one is reached by role and
 * deliberately reaches listings that are not the caller's. Two authorisation
 * stories should not share a path prefix, because the next person adding a
 * route copies whichever neighbour they land on.
 *
 * `PUT` rather than `POST`: the decision replaces whatever the previous one was,
 * and re-sending the same decision is the same decision. Contrast
 * `listingPublicationPath`, where `POST`/`DELETE` name two opposite transitions.
 */
export function adminListingModerationPath(id: string): string {
  return `/admin/listings/${encodeURIComponent(id)}/moderation`;
}

export const ADMIN_LISTING_MODERATION_ROUTE = '/admin/listings/:id/moderation';

export const LISTING_TITLE_MIN_LENGTH = 3;
export const LISTING_TITLE_MAX_LENGTH = 100;
export const LISTING_DESCRIPTION_MAX_LENGTH = 2_000;

/**
 * What the listing is called, in a search result and on a card.
 *
 * Control and format characters are rejected for the reason `displayName` gives:
 * U+202E reverses the rendering of everything after it, which is how a title is
 * made to read as something it is not, and a newline breaks every list the title
 * appears in. This is a single-line field.
 */
export const listingTitleSchema = z
  .string()
  .trim()
  .min(
    LISTING_TITLE_MIN_LENGTH,
    `must be at least ${LISTING_TITLE_MIN_LENGTH} characters`,
  )
  .max(
    LISTING_TITLE_MAX_LENGTH,
    `must be at most ${LISTING_TITLE_MAX_LENGTH} characters`,
  )
  .refine((value) => !hasUnsafeCharacters(value), UNSAFE_CHARACTERS_MESSAGE);

/**
 * The description — **required to be present, allowed to be empty.**
 *
 * That distinction is the whole design of a draft. ADR 0025's rule stands: an
 * optional field is a silent default, and a caller that forgot it should get a
 * 400 rather than a quietly blanked description. But a *draft* legitimately has
 * nothing written yet, so the empty string is a real value rather than a missing
 * one. Publication is where non-empty becomes a requirement (§8.3, slice 2.8).
 *
 * Newlines are allowed — it is a paragraph field — so `\p{Cc}` cannot be
 * rejected wholesale the way it is on the title. Everything else in that class
 * still is, which is what `allowLineBreaks` means in `text.ts`.
 */
export const listingDescriptionSchema = z
  .string()
  .trim()
  .max(
    LISTING_DESCRIPTION_MAX_LENGTH,
    `must be at most ${String(LISTING_DESCRIPTION_MAX_LENGTH)} characters`,
  )
  .refine(
    (value) => !hasUnsafeCharacters(value, { allowLineBreaks: true }),
    UNSAFE_CHARACTERS_MESSAGE,
  );

/**
 * What it would cost to replace the item, and the reason it is bounded.
 *
 * §8.7.1 builds the damage excess from this — "the greater of a fixed floor or a
 * percentage of replacement value, plus a ceiling" — so a wrong number here
 * becomes a wrong amount of somebody's money held on a card. The commonest way
 * to get it wrong is entering pounds where pence are meant, which is a factor of
 * a hundred, so the range is wide enough to be uncontroversial and narrow enough
 * to catch that.
 *
 * **Platform-wide sanity bounds, not policy.** A per-category cap belongs in
 * category configuration beside the deposit bands §8.2 already promises, and
 * putting one here would hard-code a commercial limit in a validator.
 */
export const MIN_REPLACEMENT_VALUE_MINOR = 100;
export const MAX_REPLACEMENT_VALUE_MINOR = 10_000_000;

export const replacementValueSchema = boundedMoneySchema({
  minimum: MIN_REPLACEMENT_VALUE_MINOR,
  maximum: MAX_REPLACEMENT_VALUE_MINOR,
  minimumLabel: '£1',
  maximumLabel: '£100,000',
});

/**
 * Where a listing is in its life.
 *
 * **A closed vocabulary in code, as `riskLevel` and `transportRequirement` are.**
 * Adding a listing to a category is configuration; adding a *state* is a deploy,
 * because every state is a case that search, booking, payouts and the owner
 * dashboard each handle forever. ADR 0027's rule, third application.
 *
 * `PAUSED` arrived in slice 2.8b. A value nothing can produce is one every
 * consumer still has to handle, and the first person to see it in a switch
 * statement has no way to tell whether it is unimplemented or unused — so states
 * arrive with the code that writes them.
 *
 * **The moderation states are not here, and this docblock used to say they would
 * be** (ADR 0041). They are a second field, because this one answers *what the
 * owner wants* and moderation answers *what the platform permits*. Every value
 * below is written by the owner. Putting a moderator's decision among them would
 * mean a rejection overwriting an owner's intent, and reinstatement having to
 * guess what to restore.
 *
 * **There is no `ARCHIVED`, and its absence is a decision rather than a
 * deferral** (BRD amendment, 10 August 2026). Archive was specified in §8.3 and
 * removed: the only thing distinguishing it from pause was that it could not be
 * undone, and this platform does not ship an action a user cannot undo or trace.
 * Do not add it back as "pause, but permanent" — that is the thing that was
 * rejected. A listing an owner is finished with stays paused, and a listing
 * nothing refers to is deleted outright when its owner's account goes.
 */
export const LISTING_STATUSES = ['DRAFT', 'PUBLISHED', 'PAUSED'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const listingStatusSchema = z.enum(LISTING_STATUSES);

/**
 * What the platform permits, as distinct from what the owner wants (ADR 0041).
 *
 * A closed vocabulary in code for the same reason `LISTING_STATUSES` is: each
 * value is a case that search, the owner dashboard and Phase 9's queue handle
 * forever.
 *
 * - `APPROVED` — nothing is holding this back. **The default**, because §8.3
 *   makes moderation something that *flags*, not a gate every listing waits at.
 *   Requiring approval before anything could go live would be a review queue,
 *   which is Phase 9's, and would stop the platform dead until somebody staffed
 *   it.
 * - `UNDER_REVIEW` — somebody is looking. Not visible while they do.
 * - `REJECTED` — looked at and refused.
 *
 * **`UNDER_REVIEW` and `REJECTED` are deliberately different states**, though
 * both hide a listing, because they ask opposite things of an owner: wait, or
 * fix it and come back. A single "hidden" flag would guarantee the interface
 * eventually tells somebody the wrong one.
 */
export const MODERATION_STATES = ['APPROVED', 'UNDER_REVIEW', 'REJECTED'] as const;
export type ModerationState = (typeof MODERATION_STATES)[number];

export const moderationStateSchema = z.enum(MODERATION_STATES);

/** What a listing is in before anybody has looked at it (ADR 0041). */
export const DEFAULT_MODERATION_STATE: ModerationState = 'APPROVED';

/**
 * Whether a listing is visible to anybody but its owner.
 *
 * One function rather than `=== 'PUBLISHED'` written in five places, for the
 * reason `activatesSellerReporting` exists: the rule was one state, and when
 * `PAUSED` arrived every caller had to change at once or one of them would
 * silently keep the old meaning — which here would be *showing a listing its
 * owner has hidden*. That is precisely what happened in 2.8b: this function was
 * the only edit needed, and it is the whole argument for it existing.
 *
 * **It now takes both authorities** (ADR 0041): a listing is visible when its
 * owner has published it **and** the platform permits it. The `&&` is the whole
 * rule, so neither authority can override the other.
 *
 * **It still has no callers**, and that is worth saying plainly rather than
 * implying the compiler has been policing anything. 2.10's public projection and
 * Phase 3's search are the first two, and they are unwritten — which is exactly
 * why the second parameter was added now. Widening the signature after those
 * exist would be a retrofit across every reader; adding it while the only cost
 * is this file is the whole reason 2.8a created the seam early.
 *
 * **2.10's public projection and Phase 3's search must both read this**, never
 * compare either field themselves. A `where status = 'PUBLISHED'` is now a leak
 * rather than merely a duplication: it returns rejected listings.
 */
export function isPubliclyVisible(
  status: ListingStatus,
  moderation: ModerationState,
): boolean {
  return status === 'PUBLISHED' && moderation === 'APPROVED';
}

/**
 * Whether this moderation state is one an administrator must give a reason for.
 *
 * Every state that hides somebody's listing does. §9 requires administrative
 * actions to carry a reason, and ADR 0024 established that the person reads it —
 * a listing taken down with no explanation is the thing that makes people
 * conclude a platform is arbitrary.
 *
 * `APPROVED` needs none: it is the default, and reinstating somebody is not a
 * decision they need defending to them.
 */
export function moderationRequiresReason(state: ModerationState): boolean {
  return state !== 'APPROVED';
}

/**
 * The decision an administrator submits.
 *
 * **The reason is optional here and conditionally required by the service**,
 * which is a split worth explaining. A schema cannot express "required unless
 * the state is `APPROVED`" without becoming a discriminated union that produces
 * two unrelated error shapes for one form. So the shape check lives here and the
 * rule lives in `moderationRequiresReason`, next to the states it is about —
 * with the database as the last line (`moderation_hidden_has_a_reason`).
 */
export const moderationDecisionSchema = z.object({
  state: moderationStateSchema,
  /**
   * Trimmed, and empty becomes absent.
   *
   * A reason of `"   "` satisfies "a string is present" and satisfies nobody
   * reading it, which is exactly the check the database's `btrim` makes too.
   *
   * **Anything that is not absent meets the administrative floor**
   * (`MIN_ADMIN_REASON_LENGTH`), which this schema did not require when the
   * route was first written — it accepted `"no"`. Every other reason an
   * administrator gives on this platform clears the same bar, and this one is
   * read by more people than most of them: ADR 0024 has the subject reading a
   * suspension reason verbatim, and 2.8c-ii puts this one in front of the owner
   * whose listing was hidden. A floor cannot make a reason good, and it does
   * stop a mandatory field being satisfied by a keystroke.
   *
   * The two-step — absent *or* at least twelve characters — is why this is not
   * simply `adminReasonSchema`. Approving needs no reason at all, so an empty
   * box must mean "none given" rather than "twelve characters missing".
   */
  reason: z
    .string()
    .trim()
    .max(MAX_ADMIN_REASON_LENGTH)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .refine(
      (value) =>
        value === null ||
        value === undefined ||
        value.length >= MIN_ADMIN_REASON_LENGTH,
      { message: `must be at least ${String(MIN_ADMIN_REASON_LENGTH)} characters` },
    ),
});

export type ModerationDecisionInput = z.infer<typeof moderationDecisionSchema>;

export function parseModerationDecision(raw: unknown): ModerationDecisionInput {
  return parseWith(moderationDecisionSchema, 'The moderation decision', raw);
}

/**
 * What the route answers with: the decision, and deliberately not the listing.
 *
 * **A schema for two words, and it earns its keep by what it refuses.** The
 * controller answers `{ moderationState }` because `OwnerListing` carries the
 * collection address and §8.4.1 does not disclose that to a moderator — so the
 * thing this parser must catch is the day somebody "helpfully" returns the
 * record. A caller reading `body.moderationState` off an unvalidated response
 * would accept that silently and the address would travel; `strictObject`
 * fails, loudly, in the test that first sees it.
 *
 * The web app renders the state it gets back rather than the one it submitted,
 * which is the same reasoning `publishListing` re-reads the listing: an
 * interface that confirms what it *asked for* cannot report a decision the
 * platform recorded differently.
 */
export const moderationOutcomeSchema = z.strictObject({
  moderationState: moderationStateSchema,
});

export type ModerationOutcome = z.infer<typeof moderationOutcomeSchema>;

export function parseModerationOutcome(raw: unknown): ModerationOutcome {
  return parseWith(moderationOutcomeSchema, 'The moderation outcome', raw);
}

/**
 * A named change of listing state, as a caller may ask for it.
 *
 * The transitions are named rather than expressed as a target status a caller
 * supplies, for the reason `listingPublicationPath` gives: a status somebody may
 * set is a status somebody may set to anything, and every precondition would
 * then have to be re-checked by whichever route happened to receive it.
 */
export type ListingTransition = 'publish' | 'pause';

/**
 * Which states each transition may be applied from.
 *
 * **Every transition includes its own destination**, which is what makes them
 * idempotent: publishing a published listing and pausing a paused one both
 * succeed and change nothing. 2.8a settled that for publish and the reasoning is
 * unchanged — a client that retries a request whose response it never saw must
 * not be told it did something wrong.
 *
 * `publish` runs from `PAUSED` as well as `DRAFT`, because **resuming is
 * publishing**. It is not a third transition: it runs the same completeness gate
 * and the same platform-wide kill switch, and a separate `resume` that skipped
 * either would be a way back to public view that publish deliberately guards.
 *
 * A table rather than two hand-written conditionals, because 2.8c adds
 * moderation states to it and a table is the thing that makes the new rows
 * obvious.
 */
const TRANSITIONS: Readonly<Record<ListingTransition, readonly ListingStatus[]>> = {
  publish: ['DRAFT', 'PUBLISHED', 'PAUSED'],
  pause: ['PUBLISHED', 'PAUSED'],
};

/** Whether this transition is legal from this state. */
export function canTransition(
  transition: ListingTransition,
  from: ListingStatus,
): boolean {
  return TRANSITIONS[transition].includes(from);
}

/**
 * Why this transition cannot be made from this state, or null when it can.
 *
 * A sentence naming its own subject, per `contract-issues.ts` — this reaches an
 * owner verbatim, and "invalid transition PAUSE from DRAFT" is a sentence about
 * our state machine rather than about their listing.
 *
 * Only one pair is illegal today, and it earns a message rather than a bare
 * boolean because the two reasons a pause can fail are worth telling apart: a
 * draft has nothing to pause, which is permanent until it is published, while a
 * refusal from the kill switch is temporary and says so.
 */
export function transitionRefusal(
  transition: ListingTransition,
  from: ListingStatus,
): string | null {
  if (canTransition(transition, from)) return null;

  if (transition === 'pause') {
    return 'This listing is not published, so there is nothing to pause.';
  }

  return 'This listing cannot be published from its current state.';
}

/**
 * Creating a draft.
 *
 * The **category slug**, not its id: it is the category's identity (§8.17) and
 * the only part a form can sensibly carry. **The version is not supplied by the
 * caller** — the server pins whichever is current at the moment the draft is
 * written. A client-chosen version would let a stale form pin configuration that
 * was replaced while it sat open, which is the one thing the pin exists to
 * prevent.
 */
export const listingDraftSchema = z.object({
  categorySlug: categorySlugSchema,
  title: listingTitleSchema,
  description: listingDescriptionSchema,
  replacementValue: replacementValueSchema,
  /**
   * The version of the category the form was built from — **stated, not chosen.**
   *
   * The server still pins whichever version is current when it writes, exactly
   * as it did in 2.4a: a client-chosen pin is the stale pin the version exists
   * to prevent. This is the opposite direction. It says which schema these
   * answers were entered against, so that if the category was reconfigured while
   * the form sat open, the mismatch is *noticed* rather than surfacing as an
   * answer to a field that no longer exists.
   *
   * Required rather than optional. An absent version would have to be read as
   * "whatever is current", which is precisely the assumption that makes the race
   * invisible.
   */
  categoryVersionNumber: z.number().int().positive(),
  /**
   * The answers to that category's attributes, keyed by attribute key.
   *
   * **Unknown here, and validated elsewhere.** Which keys are legal and what
   * shape each value takes is category configuration, so it cannot live in a
   * static schema — `validateAttributeValues` does that work in the Catalogue
   * service against the schema on the version actually being pinned.
   *
   * **Required, and `{}` is a legitimate value.** ADR 0025's rule, for the third
   * time: an optional field is a silent default, and a caller that forgot the
   * answers should get a 400 rather than a listing that quietly has none.
   */
  attributes: z.record(z.string(), z.unknown()),
  /**
   * What is needed to collect and carry the item (§8.3, ADR 0031).
   *
   * **Required to be present, allowed to be null** — the same distinction the
   * description draws, and for the same reason. A draft legitimately has not
   * answered this yet; a caller that omitted the field entirely has forgotten
   * it, and should hear so rather than have "not answered" assumed for them.
   *
   * Which values are legal is *category* configuration, so it cannot be decided
   * here: this checks only that the value is in the platform's vocabulary at
   * all. Whether this category offers it is checked in the Catalogue service
   * against the options on the version being pinned, exactly as attribute
   * values are.
   */
  transportRequirement: transportRequirementSchema.nullable(),
  /**
   * Whether it takes two people to lift.
   *
   * **A separate field from the requirement above, deliberately** (ADR 0031).
   * The BRD's example list has "two-person lift" beside the vehicle sizes, but
   * they are different axes: an item can need a van *and* two people, and one
   * choice would force an owner to discard one of two true facts.
   *
   * **Not category configuration.** Whether a category should offer a trailer
   * varies; whether a given object takes two people to pick up does not. It is
   * asked of every listing, and it feeds §8.9's handover checklist regardless of
   * what the category configured.
   */
  requiresTwoPersonLift: z.boolean(),
  /**
   * Where the item is collected from (§8.3's "collection location").
   *
   * **Required to be present, allowed to be null** — the third field on this
   * shape to draw that distinction, and for the same reason. A draft
   * legitimately has not said where the thing lives yet; a caller that omitted
   * the field has forgotten it. Publication is where a location becomes
   * mandatory (2.8), because a listing nobody can collect is not one anybody can
   * book.
   *
   * **What happens to it afterwards is the whole of slice 2.5.** The full
   * postcode and the street lines are private: they reach the renter only once a
   * booking authorises collection (§8.4.1). What is published is the outward
   * code and the town, derived on write and stored separately, so a public query
   * selects columns that have never held the rest. The **imprecise point** §8.3
   * asks for — a coordinate displaced by a persisted offset of at least 500 m —
   * arrives in 2.5b with the geocoder; there are no coordinates in the system
   * yet, and nothing renders a map.
   */
  collectionLocation: postalAddressSchema.nullable(),
  /**
   * What it costs to rent (§8.5.2, slice 2.7b).
   *
   * **Required to be present, with every rate inside it allowed to be null** —
   * the same distinction the three fields above draw, one level down. A draft
   * legitimately has not been priced; a caller that omitted the object has
   * forgotten it.
   *
   * The rates are the owner's commercial decision and nothing here second-
   * guesses them. What is refused is only what cannot be interpreted: a weekend
   * or weekly rate with no daily rate beside it, because the others are
   * alternatives to the daily rate rather than replacements for it.
   *
   * **Publication is where a price becomes mandatory (2.8)**, for the reason a
   * location does: a listing nothing can price is not one anybody can book.
   */
  rates: listingRateCardSchema,
});

export type ListingDraftInput = z.infer<typeof listingDraftSchema>;

/**
 * The listing's collection address, as its **owner** reads it back.
 *
 * They typed it, so they see it — the same rule `MyProfile` follows. This is the
 * only listing projection that carries the precise half, and 2.10's public one
 * carries `CoarseLocation` instead. Two types rather than one with nullable
 * fields, because an optional `postcode?: string` compiles whether or not the
 * API remembered to strip it.
 */
export type ListingCollectionLocation = PostalAddress;

export function parseListingDraft(raw: unknown): ListingDraftInput {
  return parseWith(listingDraftSchema, 'The listing', raw);
}

/**
 * A listing as its owner sees it.
 *
 * `categoryVersionNumber` is present because it is the honest answer to "which
 * rules is this listing being read under", and from 2.8 it is what tells an
 * owner their draft was written against configuration that has since changed.
 * The owner id is *not* here: this shape is only ever served to the owner, so
 * echoing their own id back adds nothing and would be one more field to strip
 * when the public projection arrives in 2.10.
 */
export interface OwnerListing {
  readonly id: string;
  readonly categorySlug: string;
  readonly categoryName: string;
  readonly categoryVersionNumber: number;
  /**
   * The attribute schema **as pinned**, not as the category stands today.
   *
   * It travels with the listing because a value on its own is unreadable: `25`
   * means nothing without knowing it is a weight in kilograms at one decimal
   * place, and `cordless` means nothing without the label somebody chose it by.
   * Sending the current schema instead would render last month's answers under
   * this month's labels, which is the one thing pinning a version exists to
   * prevent.
   */
  readonly categoryAttributes: readonly CategoryAttribute[];
  readonly title: string;
  readonly description: string;
  readonly replacementValue: z.infer<typeof moneySchema>;
  /** Keyed by attribute key. An unanswered attribute is absent, never null. */
  readonly attributes: ListingAttributeValues;
  /**
   * What it takes to collect the item, or null on a draft that has not said.
   *
   * Read against the options on the **pinned** version, like everything else
   * here: a category that has since withdrawn an option does not make an
   * existing listing unreadable, it just means nobody new can choose it.
   */
  readonly transportRequirement: TransportRequirement | null;
  readonly requiresTwoPersonLift: boolean;
  /**
   * Where it is collected from, in full, or null on a draft that has not said.
   *
   * In full **because this shape is only ever served to the owner**, who typed
   * it. The public projection in 2.10 gets the outward code and the town and
   * nothing else, and it is a different type for exactly that reason.
   */
  readonly collectionLocation: ListingCollectionLocation | null;
  /**
   * Whether that address has been resolved to a point yet (slice 2.5b).
   *
   * **A boolean, never the coordinates.** BRD §8.4.1 keeps the true point out of
   * every response, and the published one is a Phase 3 concern that this
   * projection has no use for. What an owner needs from it is one fact: their
   * listing cannot be found by anybody searching nearby until this is true, and
   * slice 2.8 will refuse to publish it.
   *
   * False is ordinary rather than alarming — the geocoder may not recognise a
   * new postcode, or may have been unreachable when the listing was saved.
   * Saving again tries once more.
   */
  readonly isLocated: boolean;
  /** What it costs to rent. Every rate null on a draft nobody has priced. */
  readonly rates: ListingRateCard;
  /**
   * The inclusive daily price §3.4.4 requires, or null when the listing has no
   * daily rate.
   *
   * **Computed by the API, never by whatever renders it.** §6.1 puts rounding in
   * the pricing service and nowhere else, and a component handed a rate and a
   * fee percentage would be a second place a price is worked out — which is how
   * two surfaces come to disagree about what something costs. It is also how
   * drip pricing gets built by accident: the bare rate is right there, and
   * showing it is one careless line.
   *
   * Null means "show no price", never "free".
   */
  readonly inclusiveDailyPrice: InclusiveDailyPrice | null;
  readonly status: ListingStatus;
  /**
   * What the platform permits, beside what the owner set (ADR 0041, slice 2.8c-ii).
   *
   * **Beside `status` and never folded into it**, which is the decision ADR 0041
   * exists for: `status` is written only by the owner and this only by somebody
   * else, so a refusal cannot overwrite an intent it would then have to guess at.
   * The consequence for anything rendering this shape is that **neither field
   * answers "can anybody see this" on its own** — `isPubliclyVisible` takes both,
   * and it is the only thing that should be asked.
   *
   * Until this slice the owner's projection carried `status` alone, so the
   * platform could hide a listing while the only page its owner can open went on
   * saying it was published and bookable.
   */
  readonly moderationState: ModerationState;
  /**
   * Why, in the moderator's own words, or null when nothing is holding it back.
   *
   * **Shown to the owner verbatim** (ADR 0024's rule for a suspension: the subject
   * reads what the administrator wrote). The moderation form promises exactly that
   * to whoever types it, so paraphrasing it here would make that promise false.
   *
   * **The moderator's identity is deliberately absent.** The reason is owed to the
   * owner; the name of the person who wrote it is not — the same line drawn for a
   * suspended account, where the subject reads the reason and never the
   * administrator.
   */
  readonly moderationReason: string | null;
  /**
   * Whether the platform is accepting publications at all right now (slice H3b).
   *
   * **A platform-wide fact on a per-listing shape, and that is deliberate.** The
   * question this projection answers is *"what can I do with this listing right
   * now"*, and the answer already depends on the listing's own state — `status`,
   * `isLocated` — and now also on the `listing.publication` kill switch
   * (ADR 0036). An owner who can see every reason their listing is not ready and
   * cannot see the one reason the button will refuse anyway is being told a
   * half-truth by omission.
   *
   * **Not a `PublicationBlocker`**, and the difference is the same one H3a drew
   * on the server: a blocker is something *this listing* is missing and its owner
   * can fix. This is neither about the listing nor fixable by them, and putting
   * it in the blocker list would send somebody hunting for a field that is
   * already correct.
   *
   * **It is a courtesy, never the control.** A page rendered ten seconds before
   * somebody threw the switch still shows `true`, and the API still refuses with
   * a 503 — which is why the check exists on both sides and why removing the
   * server-side one would be a security change rather than a tidy-up.
   */
  readonly publicationAvailable: boolean;
  /** ISO 8601 UTC. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The response check on a stored answer.
 *
 * Deliberately shape-only — that a value is a string, a number or a list of
 * strings. Whether it is a *legal* answer was settled against the pinned schema
 * when it was written, and re-deciding that on the way out would mean a schema
 * change could make an existing listing unreadable rather than merely outdated.
 */
const attributeValueSchema = z.union([z.string(), z.number(), z.array(z.string())]);

const ownerListingSchema = z.object({
  id: z.string().uuid(),
  categorySlug: z.string(),
  categoryName: z.string(),
  categoryVersionNumber: z.number().int().positive(),
  categoryAttributes: categoryAttributesSchema,
  title: z.string(),
  description: z.string(),
  replacementValue: moneySchema,
  attributes: z.record(z.string(), attributeValueSchema),
  transportRequirement: transportRequirementSchema.nullable(),
  requiresTwoPersonLift: z.boolean(),
  // The response shape, not the input one. The input normalises the postcode
  // and defaults `line2`; a response check that transformed would rewrite what
  // the API actually sent, which is the one thing this check exists to detect.
  collectionLocation: postalAddressResponseSchema.nullable(),
  isLocated: z.boolean(),
  rates: listingRateCardSchema,
  inclusiveDailyPrice: inclusiveDailyPriceSchema.nullable(),
  status: listingStatusSchema,
  /**
   * What the platform permits, beside what the owner wanted (ADR 0041, 2.8c-ii).
   *
   * **The owner's own projection carries this, and until now it did not** — the
   * state has existed since 2.8c-i and an owner had no way to learn it, so a
   * listing could be hidden by a moderator while its page told them it was
   * published and bookable. Two independent authorities, one of them invisible,
   * is the most confusing state this product can be in.
   *
   * Required rather than optional, like `status`: a projection that can omit it
   * is one where "absent" and "approved" are the same value on the wire, and the
   * page could not tell a listing nobody has objected to from one whose state
   * failed to serialise.
   */
  moderationState: moderationStateSchema,
  /**
   * The moderator's own words, **shown to the owner verbatim**.
   *
   * ADR 0024 settled this shape for suspension — the subject reads the
   * administrator's reason as written — and the moderation form already promises
   * it, telling whoever types it to *"write what you would say to them"*. A
   * reason collected under that promise and then paraphrased, or withheld, would
   * make the promise a lie.
   *
   * **The moderator's identity is deliberately not here.** The reason is owed to
   * the owner; the name of the person who typed it is not, which is the same line
   * `/admin/users` draws for a suspended account.
   *
   * Null when the state is `APPROVED`, and null is also what a listing nobody has
   * ever looked at carries — the two are indistinguishable here on purpose,
   * because §8.3 makes moderation something that flags rather than a queue every
   * listing waits in.
   */
  moderationReason: z.string().nullable(),
  publicationAvailable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function parseOwnerListing(raw: unknown): OwnerListing {
  return parseWith(ownerListingSchema, 'The listing response', raw);
}

/**
 * A category as somebody choosing one sees it.
 *
 * Deliberately not `AdminCategory`. That shape carries the risk level, the
 * reportable-activity flag and the whole attribute schema — administrative
 * configuration that an owner picking "Outdoor and gardening" from a list has no
 * business receiving. Two shapes rather than one with optional fields, for the
 * reason `profiles.ts` sets out: an optional field compiles whether or not the
 * API remembered to strip it.
 *
 * The attribute schema is here from slice 2.4b, because the form has fields to
 * render from it — that is the Phase 2 exit gate, and it is the whole reason
 * this endpoint returns more than a name. The risk level and the
 * reportable-activity flag stay out: they are how *we* administer a category,
 * not what an owner needs to describe a lawnmower.
 */
export interface CategoryOption {
  readonly slug: string;
  readonly name: string;
  /**
   * In render order, and it is the *current* schema — which is correct here and
   * would be wrong on `OwnerListing`. A form being filled in now is filling in
   * the configuration in force now; a listing saved last month is not.
   */
  readonly attributes: readonly CategoryAttribute[];
  /**
   * Which transport requirements this category offers, with their weight
   * thresholds — the current selection, for the same reason the attributes are
   * current: a form being filled in now is filling in the configuration in
   * force now.
   *
   * The thresholds travel because the suggestion is computed in the browser, as
   * the weight is typed. They are not secret — they are a hint about how heavy a
   * thing has to be before it needs a van, which is what the form is about to
   * tell the owner anyway.
   */
  readonly transportOptions: readonly CategoryTransportOption[];
  /**
   * Which version the above came from, so the draft can say what it was built
   * against and the server can notice if it has moved since.
   */
  readonly versionNumber: number;
}

const categoryOptionListSchema = z.object({
  categories: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      attributes: categoryAttributesSchema,
      transportOptions: categoryTransportOptionsSchema,
      versionNumber: z.number().int().positive(),
    }),
  ),
});

export function parseCategoryOptions(raw: unknown): {
  readonly categories: readonly CategoryOption[];
} {
  return parseWith(categoryOptionListSchema, 'The category list', raw);
}
