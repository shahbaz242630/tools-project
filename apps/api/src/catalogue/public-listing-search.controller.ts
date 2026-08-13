import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import {
  PUBLIC_LISTING_SEARCH_ROUTE,
  parseListingSearchQuery,
} from '@platform/contracts';
import type {
  PublicListingSearchResults,
  PublicListingSummary,
} from '@platform/contracts';
import { inclusiveDailyPrice } from '../pricing/daily-price.js';
import { LISTINGS_SERVICE } from './catalogue.tokens.js';
import type { ListingsService } from './listings.service.js';
import type { NearbyListingView } from './listings.service.js';

/**
 * Listings near a postcode, for anybody (slice 3.1a).
 *
 * **A second unguarded controller rather than a route on the first**, and the
 * reason is the one `PublicListingsController` gives inverted: an unguarded
 * route among guarded ones reads as an oversight, so unguarded routes get their
 * own class — but two unguarded *routes* in one class would make the next
 * addition to that class a decision nobody notices making. One public surface
 * per file keeps the count visible.
 *
 * **This is the most exposed thing in the system.** The listing page can be
 * enumerated only through the UUID space; this returns a *collection*, from an
 * origin the caller chooses, and there is no rate limiting anywhere
 * (`SECURITY.md`). The honest statement of today's mitigation is that no domain
 * points at us yet. It is the first endpoint that gets a limit the moment the
 * WAF exists, and that is written down in the phase handoff rather than left to
 * be rediscovered.
 *
 * **What keeps it safe is not this class**: it is that `ListingProximity`
 * measures from the fuzzed point (ADR 0032), returns buckets rather than metres,
 * and yields ids rather than rows. This class chooses no fields of its own —
 * the same sentence `PublicListingsController` carries, and load-bearing for the
 * same reason.
 */
@Controller()
export class PublicListingSearchController {
  constructor(@Inject(LISTINGS_SERVICE) private readonly listings: ListingsService) {}

  @Get(PUBLIC_LISTING_SEARCH_ROUTE)
  async search(
    @Query() query: Record<string, unknown>,
  ): Promise<PublicListingSearchResults> {
    /*
     * **Parsed rather than trusted, and a failure here is a 400.** A malformed
     * postcode and a radius outside §8.4's five values are both things the
     * caller can correct, and answering "no results" to either would be telling
     * somebody their area is empty when in fact we never looked.
     *
     * The radius vocabulary being closed is a privacy control rather than
     * validation tidiness — see `SEARCH_RADII_MILES`.
     */
    let request;
    try {
      request = parseListingSearchQuery(query);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'The search request is not valid',
      );
    }

    const found = await this.listings.searchNearby(
      request.postcode,
      request.radiusMiles,
    );

    /*
     * **An unplaceable origin is an empty page, not an error**, and the two are
     * collapsed here rather than in the service on purpose.
     *
     * A *valid* postcode the geocoder does not recognise, and a geocoder that is
     * briefly unreachable, are both "we could not search from there". Neither is
     * the caller's fault and neither is worth a 5xx: the postcode was well
     * formed, so a 400 would be wrong, and a 500 would turn a third party's
     * outage into ours.
     *
     * The service still distinguishes them — it returns null — so **slice 3.1b
     * can say something more useful on the page** than "nothing found" without
     * changing anything below this line.
     */
    if (found === null) {
      return { results: [], truncated: false, radiusMiles: request.radiusMiles };
    }

    return {
      results: found.results.map(toSummary),
      truncated: found.truncated,
      radiusMiles: request.radiusMiles,
    };
  }
}

/**
 * One result, as the wire carries it.
 *
 * **The price is computed here rather than stored**, exactly as
 * `toPublicListing` and `toOwnerListing` do it: §6.1 puts rounding in the
 * pricing service and nowhere else, and the policy used is the category's
 * *current* one (ADR 0042) because §3.4.4 wants the card's price to be today's.
 *
 * §3.4.4 names listing **cards** specifically, which is what these are, so the
 * inclusive total is the only price on this shape — the bare daily rate is not
 * one line away from being rendered instead, it is absent.
 */
function toSummary({
  listing,
  ownerStatus,
  distance,
}: NearbyListingView): PublicListingSummary {
  const price = inclusiveDailyPrice(listing.rates, listing.currentFeePolicy);

  /* c8 ignore next 5 -- unreachable: publication refuses a listing with no
     daily rate (§8.3, slice 2.8a), and a search returns only publicly visible
     listings. Guarded rather than asserted, because the alternative is a null
     reaching a card that renders a price. */
  if (price === null) {
    throw new Error(
      `Listing ${listing.id} is published with no daily rate, which publication should have refused`,
    );
  }

  return {
    id: listing.id,
    title: listing.title,
    categoryName: listing.categoryName,
    // The two publishable columns, assembled into the type whose whole purpose
    // is to be un-narrowable further (§8.4.1). There is no branch here that
    // could reach for a postcode: the record has none.
    location: { outwardCode: listing.outwardCode, town: listing.town },
    inclusiveDailyPrice: price,
    // Already coarse when it crossed the proximity boundary (ADR 0044). Nothing
    // here rounds, because nothing here has anything precise to round.
    distance,
    ownerStatus,
  };
}
