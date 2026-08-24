import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import {
  PUBLIC_LISTING_SEARCH_ROUTE,
  SEARCH_CATEGORY_MESSAGE,
  parseListingSearchQuery,
} from '@platform/contracts';
import type {
  PublicListingSearchResults,
  PublicListingSummary,
} from '@platform/contracts';
import { inclusiveDailyPrice } from '../pricing/daily-price.js';
import { UnknownCategoryError } from './listing-store.js';
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
     * validation tidiness — see `SEARCH_RADII_MILES` — and **the page cap is an
     * availability control** rather than a product limit: an uncapped offset on
     * this route is a caller choosing how much work we do. See
     * `MAX_SEARCH_PAGE`, which is why a page beyond it is refused here rather
     * than clamped into range.
     */
    let request;
    try {
      request = parseListingSearchQuery(query);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'The search request is not valid',
      );
    }

    let found;
    try {
      found = await this.listings.searchNearby(request);
    } catch (error) {
      /*
       * **A 400, where the same error is a 404 on the write path** (slice 3.2a),
       * and the difference is the caller rather than the fact.
       *
       * `OwnerListingsController` answers 404 because an owner chose that
       * category from a list we rendered, and it stopped existing between the
       * form loading and the save — nothing they typed is wrong and the fix is
       * to choose again. Here the slug arrived in a URL as a *filter*, alongside
       * a radius and a page number that are refused with 400 for naming values
       * we do not serve. This is that same refusal: the request describes a
       * search that does not exist.
       *
       * **The alternative — an empty page — is the one wrong answer available.**
       * It tells somebody there is nothing near them in a category we have never
       * had, which is indistinguishable from a genuinely quiet area and would be
       * counted as one.
       */
      if (error instanceof UnknownCategoryError) {
        throw new BadRequestException(`Category ${SEARCH_CATEGORY_MESSAGE}`);
      }
      throw error;
    }

    /*
     * **An unplaceable origin is an empty page, not an error — but it says so.**
     *
     * A *valid* postcode the geocoder does not recognise, and a geocoder that is
     * briefly unreachable, are both "we could not search from there". Neither is
     * the caller's fault and neither is worth a 5xx: the postcode was well
     * formed, so a 400 would be wrong, and a 500 would turn a third party's
     * outage into ours. That half of slice 3.1a's decision stands.
     *
     * **What did not stand is the other half.** This comment used to promise
     * that the service *"still distinguishes them — it returns null — so slice
     * 3.1b can say something more useful on the page"*. 3.1b never did, and the
     * distinction died here: `{ results: [] }` is byte-identical to a genuinely
     * quiet area, so `browse-results.tsx` answered a postcodes.io outage with
     * *"There is nothing listed near you yet. We are just getting started"* — a
     * confident claim about the whole catalogue, made while we had not looked at
     * any of it. Two audits called it the most consequential silent failure in
     * the product, and it was confirmed in a browser on staging.
     *
     * `originStatus` is that promise, kept. The status code, the shape and every
     * existing field are unchanged — a caller reading `results` is unaffected —
     * and the one new field is what lets the page tell a searcher we could not
     * look rather than that there is nothing to find.
     */
    if (found === null) {
      return {
        results: [],
        truncated: false,
        radiusMiles: request.radiusMiles,
        page: request.page,
        category: request.category,
        keyword: request.keyword,
        dates: request.dates,
        originStatus: 'unplaceable',
      };
    }

    /*
     * **The radius, the page, the category and the keyword are echoed from the
     * request, not from the result.** All four were defaulted if absent, and a
     * response that did not say which values it used reads as an answer to a
     * different question — a five-mile search looking like a national one, page
     * one looking like all of them, or an unfiltered search looking like a
     * filtered one that found nothing.
     *
     * **The keyword is echoed *trimmed*, which is what the parse produced and
     * what actually ran** (slice 3.3a). Echoing the raw parameter instead would
     * let the page display one thing while the database was asked another — a
     * small difference that becomes a large one the moment somebody reports that
     * a search "found nothing" and the URL they send does not describe the query
     * that ran.
     *
     * **The category is echoed as the searcher's slug**, not as the id it was
     * resolved to. The id never leaves the server: it is an internal identifier
     * with no place in a public response, and the slug is what every URL, link
     * and canonical (§8.17) is built from.
     *
     * **`placed` is stated rather than left to be inferred from a non-empty
     * list**, which is the same instinct as echoing the radius: a reader that
     * has to derive what happened from the data will eventually derive it
     * wrongly, and here the wrong derivation is the defect this field exists to
     * close. A search that placed the origin and found nothing is `placed` with
     * no results, and that combination has to be expressible.
     */
    return {
      results: found.results.map(toSummary),
      truncated: found.truncated,
      radiusMiles: request.radiusMiles,
      page: request.page,
      category: request.category,
      keyword: request.keyword,
      // Echoed from the request like the four above, and for the same reason:
      // a dated search that came back empty must not read as "nothing near you".
      dates: request.dates,
      originStatus: 'placed',
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
  thumbnail,
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
    /*
     * **Already the thumbnail rendition and already signed** (slice 2.6b-ii).
     * The store resolved which of the two renditions a card may have — the
     * record it returns has no display key to reach for — and the service
     * signed it after the visibility checks. Null where the listing has no
     * photograph, which is most of them.
     */
    thumbnail,
    ownerStatus,
  };
}
