import {
  TRANSPORT_REQUIREMENT_LABELS,
  offersTransportRequirement,
  validateAttributeValues,
} from '@platform/contracts';
import type {
  AttributeValueIssue,
  ExportedListings,
  ListingCollectionLocation,
  TransportRequirement,
} from '@platform/contracts';
import { Time } from '@platform/core';
import type { Actor } from '../audit/audit-log.js';
import type { ListingLocator } from './listing-locator.js';
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

  /** The categories an owner may list in, with the fields each one asks for. */
  categoryOptions(): Promise<readonly CategoryOptionRecord[]> {
    return this.categories.listOptions();
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
  async exportFor(userId: string): Promise<ExportedListings> {
    const listings = await this.store.listOwnedBy(userId);

    return listings.map((listing) => ({
      id: listing.id,
      title: listing.title,
      createdAt: Time.toIsoUtc(listing.createdAt),
      collectionLocation: listing.collectionLocation,
    }));
  }

  /**
   * Remove everything precise this module holds about where somebody is.
   *
   * **It erases locations, not listings**, and the difference is the decision.
   * A listing has to outlive its owner's account deletion — from Phase 4 a
   * booking references it, and a rental history missing one side is not a
   * history — while a front door must not. So the `listing_locations` row goes
   * and the listing stays, collapsed to the outward code and town it was always
   * published at. A postal district covering thousands of homes is not what
   * §10.1 asks us to remove.
   *
   * **Whether a deleted owner's listing should still be *visible* is not settled
   * here.** That is archival, it belongs with the lifecycle work in slice 2.8,
   * and it must be settled before any real user data exists. Today nothing is
   * publishable at all, so the question has no observable consequence yet — which
   * is exactly the kind of thing that gets forgotten.
   *
   * **Unaudited, deliberately, and it is the one place that reads oddly.**
   * `ProfilesService.eraseFor` writes a `profile.erased` entry. There is no
   * equivalent here because the audit entry for the deletion itself is written
   * by Identity, and a second line saying "and the listing addresses went too"
   * would record a consequence rather than an action — with a target id for
   * every listing, in a trail retained six years, about rows that still exist.
   * If 2.8 makes archival a real state change, *that* is an action and deserves
   * its own entry.
   */
  async eraseFor(actor: Actor): Promise<void> {
    await this.store.eraseLocationsFor(actor.userId);
  }
}
