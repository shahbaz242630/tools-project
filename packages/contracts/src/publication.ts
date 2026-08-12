/**
 * What a listing needs before a stranger may see it (BRD §8.3, slice 2.8a).
 *
 * **This file exists because §8.3 makes a draft deliberately permissive.**
 * Owners "create draft listings and save progress", so almost every field on a
 * listing is allowed to be absent — which means completeness is not a storage
 * rule and cannot be a database constraint. It is a rule about one transition,
 * and this is where it lives.
 *
 * Five slices deferred a requirement to "the publication rule", each for a good
 * reason, and this is where they all come due:
 *
 * - **2.4b**: `required` attributes are not enforced on a draft.
 * - **2.4c-i**: what a category offering *no* transport options means.
 * - **2.5b**: geocoding is best effort, so a listing can have an address and no
 *   point.
 * - **2.7b**: a draft need not be priced.
 * - **§8.3 itself**: a draft may have no description.
 *
 * **Its own module rather than a method on the service**, because 2.9's owner
 * dashboard needs the same answer without performing the transition — "what is
 * still missing" is what a dashboard shows, and a rule reachable only by
 * attempting to publish would have to be duplicated there.
 */

import { z } from 'zod';
import { parseWith } from './parse.js';
import type { CategoryAttribute } from './catalogue.js';
import type { OwnerStatus } from './profiles.js';
import type { ListingAttributeValues } from './attribute-values.js';
import type { ListingRateCard } from './pricing.js';
import type { CategoryTransportOption, TransportRequirement } from './transport.js';

/**
 * Everything the rules read, and nothing else.
 *
 * A narrow shape rather than the whole listing record, so that this module
 * cannot start depending on fields it has no business reading — a coordinate, an
 * owner id, or the encrypted street lines. What it needs is what a publication
 * decision is about.
 */
export interface PublicationCandidate {
  readonly description: string;
  readonly attributes: ListingAttributeValues;
  /** The schema **as pinned**, not the category's current one (ADR 0029). */
  readonly categoryAttributes: readonly CategoryAttribute[];
  /** The options the **pinned** version offers. Empty is legitimate. */
  readonly categoryTransportOptions: readonly CategoryTransportOption[];
  readonly transportRequirement: TransportRequirement | null;
  readonly rates: ListingRateCard;
  /**
   * Whether an address has been given at all.
   *
   * **Separate from `isLocated`, because they fail for different reasons and an
   * owner can only act on one of them.** No address means answer the question;
   * an address that would not geocode means check the postcode and save again.
   * Collapsing them produces "we could not place this address on a map" about a
   * listing that has no address — which is what this said until somebody pressed
   * the button and read it.
   */
  readonly hasCollectionLocation: boolean;
  /** Whether the address resolved to a point. Never the coordinates (§8.4.1). */
  readonly isLocated: boolean;
  /**
   * How the **owner** lists — themselves or as a business — or null if they have
   * not said (BRD §8.3, slice 2.13, ADR 0043).
   *
   * **The only field on this shape that is not a fact about the listing**, and
   * that is worth flagging rather than hiding. Everything else here is
   * something the owner types into the listing form; this is a property of the
   * person, read through a port, and the same value gates every listing they
   * have. It is here because publication is where a legal disclosure has to be
   * settled — a listing must not go in front of a renter without one — and
   * because the caller already assembles this object at exactly that moment.
   */
  readonly ownerStatus: OwnerStatus | null;
}

/**
 * One unmet requirement, named so the interface can point at the control.
 *
 * `field` is for whatever renders errors beside inputs; `message` is a sentence
 * that names its own subject, so it reads correctly alone — the convention
 * `contract-issues.ts` enforces after the same defect was found four times.
 */
export interface PublicationBlocker {
  readonly field: string;
  readonly message: string;
}

/**
 * Every reason this listing cannot be published, or an empty list.
 *
 * **Every reason, not the first.** An owner who fixes one thing, saves, and is
 * told about the next is being walked through four round trips for a form they
 * can see all of — the same small insult that made the address fields worth
 * echoing back in 2.5a. The interface can then show one message per control.
 *
 * The order is the order the fields appear on the form, so a list of blockers
 * reads top to bottom rather than in the order somebody happened to write the
 * checks.
 */
export function publicationBlockers(
  listing: PublicationCandidate,
): readonly PublicationBlocker[] {
  const blockers: PublicationBlocker[] = [];

  if (listing.description.trim() === '') {
    blockers.push({
      field: 'description',
      message: 'A description is needed before this listing can be published.',
    });
  }

  /*
   * The `required` flag, finally enforced (2.4b deferred it here).
   *
   * **Read against the pinned schema**, which is what `categoryAttributes`
   * carries — ADR 0029. Checking against the category's current schema would
   * make a reconfiguration retroactively unpublishable, or worse, publishable:
   * an attribute that became required last week is not one this listing was ever
   * asked for.
   *
   * An unanswered attribute is *absent* rather than null (2.4b), so presence is
   * the whole test. An empty string is treated as unanswered too: a `text`
   * attribute somebody cleared is not an answer, and storing `''` for it would
   * be a second representation of "not said".
   */
  for (const attribute of listing.categoryAttributes) {
    if (!attribute.required) continue;

    const value = listing.attributes[attribute.key];
    const answered =
      value !== undefined &&
      value !== '' &&
      !(Array.isArray(value) && value.length === 0);

    if (!answered) {
      blockers.push({
        field: `attributes.${attribute.key}`,
        message: `${attribute.label} is needed before this listing can be published.`,
      });
    }
  }

  /*
   * The question 2.4c-i deferred: what does a category offering **no** transport
   * options mean for publication?
   *
   * It means the requirement is not required. A category configured before
   * slice 2.4c-i offers nothing, so its listings *cannot* state how the item is
   * collected — and demanding one would make every listing in that category
   * permanently unpublishable through a rule its owner has no way to satisfy.
   *
   * Where the category does offer options, one must be chosen: §8.3 exists
   * because an item that will not fit the renter's car produces a failed
   * handover, and a published listing silent about that is the failure it was
   * written to prevent.
   */
  if (
    listing.categoryTransportOptions.length > 0 &&
    listing.transportRequirement === null
  ) {
    blockers.push({
      field: 'transportRequirement',
      message:
        'How the item is collected is needed before this listing can be published.',
    });
  }

  /*
   * 2.7b's rule. Nothing can price a listing with no daily rate, so nobody can
   * book it — and §3.4.4 requires a total price wherever it is shown, which is
   * not a figure that exists here.
   */
  if (listing.rates.daily === null) {
    blockers.push({
      field: 'rates.daily',
      message: 'A daily rate is needed before this listing can be published.',
    });
  }

  /*
   * 2.5b's rule, and the least obvious of the five.
   *
   * Geocoding is best effort: a provider outage or an unrecognised new postcode
   * leaves a listing with a perfectly good address and no coordinates. That is a
   * legitimate draft. Published, it is a listing **no search can ever return** —
   * worse than not existing, because the owner believes it is live and nobody
   * can explain the silence.
   *
   * The fix is to save it again, which retries the geocoder. The message says so
   * rather than describing a coordinate, because "we could not find your
   * postcode on a map" is what happened and "no coordinates" is not something an
   * owner can act on.
   */
  /*
   * **Two messages from one field, because the two cases need opposite things
   * from the reader** — the shape `hasCollectionLocation` and `isLocated`
   * already use, one field along.
   *
   * Not answered: go and answer it, and the listing publishes.
   * Answered "business": there is nothing to fix on this listing at all, and
   * saying "not ready yet" without saying why would send somebody hunting
   * through their own form for a field that is already correct.
   *
   * **A blocker rather than its own error**, unlike the platform-wide publishing
   * switch. From the owner's point of view this genuinely is a reason their
   * listing cannot go live, it is stable rather than temporary, and it belongs
   * in the list beside everything else they need to resolve. The switch got its
   * own status because it is about the platform and says nothing about them.
   */
  if (listing.ownerStatus === null) {
    blockers.push({
      field: 'ownerStatus',
      message:
        'Your profile has to say whether you are listing as a private ' +
        'individual or as a business before anything can be published. Renters ' +
        'have different rights depending on which, so they have to be told.',
    });
  } else if (listing.ownerStatus === 'professional_trader') {
    blockers.push({
      field: 'ownerStatus',
      message:
        'Your profile says you list as a business. We only accept listings ' +
        'from private individuals at the moment, so this cannot be published — ' +
        'nothing is wrong with the listing itself.',
    });
  }

  if (!listing.hasCollectionLocation) {
    blockers.push({
      field: 'collectionLocation',
      message:
        'Where the item is collected from is needed before this listing can be ' +
        'published, because nobody can come and fetch a thing that is nowhere.',
    });
  } else if (!listing.isLocated) {
    blockers.push({
      field: 'collectionLocation',
      message:
        'We could not place this address on a map, so nobody searching nearby ' +
        'would find it. Check the postcode and save again.',
    });
  }

  return blockers;
}

/** Whether this listing could be published right now. */
export function isPublishable(listing: PublicationCandidate): boolean {
  return publicationBlockers(listing).length === 0;
}

/**
 * The wire shape of a refusal, for the route that answers 422.
 *
 * A **422 rather than a 400**: the request is well formed and the caller is
 * asking for something coherent. What is wrong is the *state of the listing*,
 * which is not something a different request body would fix — and telling the
 * two apart matters to a client deciding whether to show a field error or a
 * "here is what is left to do" list.
 */
export const publicationBlockerSchema = z.object({
  field: z.string(),
  message: z.string(),
});

export const publicationRefusalSchema = z.object({
  message: z.string(),
  blockers: z.array(publicationBlockerSchema),
});

/**
 * The blockers out of a 422 body.
 *
 * Here rather than in the web app so the shape is read by the same schema that
 * wrote it, and so no consumer needs its own copy of zod to understand a
 * response this package defines.
 *
 * Throws on a body it cannot read, and the caller decides what that means —
 * `parseWith`'s contract everywhere else in this package. A publish button
 * showing "something is missing" is a better failure than a page that crashes,
 * but that judgement belongs to the interface rather than to the parser.
 */
export function parsePublicationRefusal(raw: unknown): {
  readonly message: string;
  readonly blockers: readonly PublicationBlocker[];
} {
  return parseWith(publicationRefusalSchema, 'The publication refusal', raw);
}
