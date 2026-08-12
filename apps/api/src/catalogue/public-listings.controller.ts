import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { PUBLIC_LISTING_ROUTE } from '@platform/contracts';
import type { PublicListing } from '@platform/contracts';
import { inclusiveDailyPrice } from '../pricing/daily-price.js';
import { LISTINGS_SERVICE } from './catalogue.tokens.js';
import type { ListingsService } from './listings.service.js';
import type { PublicListingView } from './listings.service.js';

/**
 * One listing, as anyone may see it (slice 2.10).
 *
 * **Deliberately not guarded, and deliberately in its own controller** — the
 * shape `PublicProfileController` established and the reason it exists. Every
 * other controller in this module carries `@UseGuards(AuthGuard)` at class
 * level, so an unguarded *route* hidden among guarded ones would read as an
 * oversight, while an unguarded *controller* has to be created on purpose. That
 * is the whole argument for a second file holding one method.
 *
 * **Assume everything this returns is scraped and indexed the day it ships.**
 * What keeps that safe is not this class: it is `publicListingSchema`, which has
 * no address beyond a postal district, and `ListingStore.findPublished`, whose
 * query does not join `listing_locations` at all. **This class chooses no fields
 * of its own** — the same sentence `PublicProfileController` carries, and it is
 * load-bearing. A controller that assembled a projection would be the place a
 * field gets added because a page wanted it.
 *
 * **It is the first route in the system a signed-out person can reach that
 * returns anything a user wrote.** Rate limiting does not exist yet anywhere
 * (`SECURITY.md`), and this widens what that costs: until the WAF and the limits
 * land with the domain, this route can be enumerated. The ids are UUIDs, so it
 * cannot be walked by counting — but it is worth knowing that the mitigation
 * today is the id space rather than anything we built.
 */
@Controller()
export class PublicListingsController {
  constructor(@Inject(LISTINGS_SERVICE) private readonly listings: ListingsService) {}

  @Get(PUBLIC_LISTING_ROUTE)
  async find(@Param('id') id: string): Promise<PublicListing> {
    const view = await this.listings.findPublic(id);

    /*
     * **One answer for four different situations**: no such listing, a draft, a
     * listing its owner paused, and one a moderator rejected. Distinguishing any
     * of them would tell a stranger that a listing exists and that somebody
     * decided to hide it — and "404 unless it is published" is the only version
     * of this route that cannot be used to audit our moderation decisions from
     * the outside.
     *
     * **Five situations from 2.13**, and the fifth is the interesting one: an
     * owner who has changed their profile to say they list as a business. Their
     * listings stop being public immediately, because a disclosure that can go
     * stale is worse than none — see `ListingsService.findPublic`.
     *
     * The service returns null for all of them, so there is nothing to get
     * wrong here. That is the design rather than a convenience.
     */
    if (view === null) throw new NotFoundException();

    return toPublicListing(view);
  }
}

/**
 * The record as the wire carries it.
 *
 * **The price is computed here rather than stored**, exactly as
 * `toOwnerListing` does it: §6.1 puts rounding in the pricing service and
 * nowhere else, and the fee policy this uses is the category's *current* one
 * (ADR 0042) because §3.4.4 wants the window price to be today's price.
 *
 * **`inclusiveDailyPrice` returns null for an unpriced listing and that cannot
 * happen here** — publication refuses a listing with no daily rate — so the
 * throw below is a type narrowing over a state the completeness rules already
 * exclude. It throws rather than returning null because a *published* listing
 * with no price is a broken invariant rather than a 404: answering "not found"
 * would hide it, and this is the sort of thing that should page somebody.
 */
function toPublicListing({ listing, ownerStatus }: PublicListingView): PublicListing {
  const price = inclusiveDailyPrice(listing.rates, listing.currentFeePolicy);

  /* c8 ignore next 5 -- unreachable: publication refuses a listing with no
     daily rate (§8.3, slice 2.8a), so a publicly visible listing always has
     one. Guarded rather than asserted, because the alternative is a null
     reaching a page that renders a price. */
  if (price === null) {
    throw new Error(
      `Listing ${listing.id} is published with no daily rate, which publication should have refused`,
    );
  }

  return {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    categorySlug: listing.categorySlug,
    categoryName: listing.categoryName,
    categoryAttributes: listing.categoryAttributes,
    attributes: listing.attributes,
    transportRequirement: listing.transportRequirement,
    requiresTwoPersonLift: listing.requiresTwoPersonLift,
    // The two publishable columns, assembled into the type whose whole purpose
    // is to be un-narrowable further (§8.4.1). There is no branch here that
    // could accidentally reach for a postcode: the record has none.
    location: { outwardCode: listing.outwardCode, town: listing.town },
    inclusiveDailyPrice: price,
    rates: listing.rates,
    /*
     * **The consumer-law disclosure BRD §8.3 asks for** (slice 2.13). A renter
     * has materially stronger rights against a trader than against a private
     * individual, so they are entitled to know which before they book.
     *
     * Always `private_owner` today, because `findPublic` refuses to return
     * anything else — and carried on the wire rather than assumed by the page
     * precisely so that stops being a thing anybody has to remember.
     */
    ownerStatus,
  };
}
