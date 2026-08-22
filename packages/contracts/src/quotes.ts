/**
 * A priced, expiring offer for a period (BRD §8.5.2, §6.2, slice 4.4b).
 *
 * **What a quote is for.** §8.5.2 requires a firm total before anybody commits:
 * *"a listing page must collect both [dates and postcode] before displaying a
 * committed price"*. The listing page's `from £x/day` is the *indicative* figure
 * the same section permits; this is the committed one, and unlike the indicative
 * figure it is persisted, so it can be reproduced and audited.
 *
 * **Dates on the wire, never instants — except the expiry.** Slice 4.3b settled
 * that a date a person chose becomes an instant in exactly one place, on the
 * server, in the platform's timezone; `YYYY-MM-DD` crosses every wire because a
 * conversion in the browser happens in whatever zone the device is in, and that
 * is wrong for seven months a year in a way no reviewer sees. `expiresAt` is the
 * deliberate exception and is not the same kind of thing: it is a *moment* we
 * chose, not a day somebody typed, and a renter needs to know when the price
 * stops holding. Anything rendering it must format it in a stated timezone
 * rather than the device's.
 *
 * **`endDate` is inclusive here and exclusive in the column**, exactly as
 * `availabilityBlockRequestSchema` has it: "the 20th to the 22nd" is three days
 * ending at the start of the 23rd, which is what lets a hire follow another with
 * no gap.
 */

import { z } from 'zod';
import { postcodeSchema } from './address.js';
import { calendarDateSchema } from './availability.js';
import { moneySchema } from './money.js';
import { appliedExcessOrNoneSchema } from './pricing.js';
import { parseWith } from './parse.js';

export function listingQuotesPath(id: string): string {
  return `/listings/${id}/quotes`;
}

export const LISTING_QUOTES_ROUTE = '/listings/:id/quotes';

export function quotePath(quoteId: string): string {
  return `/quotes/${quoteId}`;
}

/**
 * **Not nested under the listing**, unlike the route that creates it. A quote id
 * identifies one row on its own, and a nested read would take a listing id it
 * would then have to check against the stored one — a second scope to keep
 * consistent, where the renter scope is the one that actually protects anything.
 */
export const QUOTE_ROUTE = '/quotes/:quoteId';

/**
 * How long a quote holds its price: **30 minutes**.
 *
 * **Engineering judgement, not BRD text.** §8.5.2 requires *an* expiry and does
 * not say what it should be — the same shape as the three bounds in
 * `booking/limits.ts`, and named here with the reasoning beside it so changing
 * it is a decision somebody makes rather than a number somebody edits.
 *
 * Two things bound it from either side. Too long and the offer outlives its
 * inputs: a fee change applies to every listing at once with no per-listing step
 * (ADR 0042), an owner may block the dates, and another renter may take them —
 * so a quote from this morning can be a price we cannot honour and dates we
 * cannot supply. Too short and it expires while somebody is reading it, which
 * turns a considered decision into a race.
 *
 * Thirty minutes is long enough to fetch a bank card and short enough that
 * nothing material moves underneath it. It is not a promise about availability:
 * a quote reserves nothing (§7.1), and 4.5's request is what asks for the dates.
 */
export const QUOTE_VALIDITY_MINUTES = 30;

/**
 * The rate units a quote can be built from, and how many days each covers.
 *
 * **These are the owner's own rates and nothing else** — the platform sets no
 * discount curve (product owner, 16 August 2026). A unit is a thing an owner
 * priced; a quote is the cheapest combination of them that covers the hire.
 *
 * **Hourly is deliberately absent**, for the reason `pricing.ts` gives at
 * length: in a peer-to-peer model the renter drives to a stranger's house, so
 * the round trip exceeds the rental and nothing in the launch category is hired
 * by the hour.
 */
export const RENTAL_UNITS = ['day', 'weekend', 'week'] as const;

export type RentalUnit = (typeof RENTAL_UNITS)[number];

/**
 * **A weekend is three days, not two.** §8.5.2 names it separately from a
 * two-day daily charge precisely because it is not one, and
 * `ListingRateCard.weekend` calls it *"Friday to Sunday as one charge, which is
 * how most domestic tool hire actually happens"*. Three days is what that
 * sentence describes.
 */
export const RENTAL_UNIT_DAYS: Readonly<Record<RentalUnit, number>> = {
  day: 1,
  weekend: 3,
  week: 7,
};

/**
 * The weekday a weekend rate may start on — Friday, in `Time.weekdayOf`'s
 * ISO numbering where 1 is Monday.
 *
 * **Why the rate is anchored to a day at all**, when the daily and weekly rates
 * are not: those two are quantities and this one is an occasion. An owner
 * setting a weekend price is pricing *the weekend* — the two nights their drill
 * is idle anyway — and applying it to a Tuesday would be charging weekend
 * economics for a working day the owner never agreed to discount.
 */
export const WEEKEND_START_WEEKDAY = 5;

/**
 * One row of the quote's arithmetic, and the reason the price is explainable.
 *
 * §6.2 puts *line items* on the `Quote` entity. They are what turn a total into
 * a sentence somebody can be told — *"two weeks and a day"* — which is the
 * property the pricing rule was chosen for: a renter who asks why ten days costs
 * what it does gets an answer that names the owner's own prices.
 */
export const quoteLineItemSchema = z.strictObject({
  unit: z.enum(RENTAL_UNITS),
  count: z.number().int().positive(),
  /** What the owner charges for one of these. */
  unitPrice: moneySchema,
  /** `unitPrice × count`, computed once by the pricing service (§6.1). */
  subtotal: moneySchema,
});

export type QuoteLineItem = z.infer<typeof quoteLineItemSchema>;

/**
 * The line items as read back out of a `jsonb` column.
 *
 * **A named parser rather than a cast**, which is the treatment every JSON column
 * in this schema gets: Postgres guarantees the value is JSON and nothing about
 * its shape. The `subject` is the caller's, so a drifted row names itself —
 * *"the line items on quote …"* is a message somebody can act on where "invalid
 * input" is not.
 */
export const quoteLineItemsSchema = z.array(quoteLineItemSchema).min(1);

export function parseQuoteLineItems(
  raw: unknown,
  subject = 'The line items',
): readonly QuoteLineItem[] {
  return parseWith(quoteLineItemsSchema, subject, raw);
}

/**
 * What a renter asks for.
 *
 * **The postcode is required, and §8.5.2 is why**: *"A quote is a function of
 * listing, dates **and renter postcode** — not dates alone… A quote produced
 * without a postcode is incomplete and must not be presented as a firm total."*
 *
 * **It does not change the price today, and that is worth stating plainly.** The
 * three things §8.5.2 says location determines — reachability, whether owner
 * delivery is available and at what charge, and location-dependent fee
 * configuration under §8.2 — none of them exist as configuration yet. It is
 * required and stored anyway, because it is what makes the quote reproducible
 * and because the day any of those three arrives, this is the field it reads.
 * Collecting it later would mean re-quoting every price already given.
 *
 * **Only the ordering rule lives here.** Whether the period is too long, already
 * past, or unavailable are all decided where the clock and the calendar are —
 * the split `availabilityBlockRequestSchema` documents.
 */
export const quoteRequestSchema = z
  .object({
    startDate: calendarDateSchema,
    /** Inclusive — the last day of the hire. */
    endDate: calendarDateSchema,
    postcode: postcodeSchema,
  })
  .refine((request) => request.endDate >= request.startDate, {
    // String comparison is date comparison for `YYYY-MM-DD`.
    message: 'the last day cannot fall before the first',
    path: ['endDate'],
  });

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export function parseQuoteRequest(raw: unknown): QuoteRequest {
  return parseWith(quoteRequestSchema, 'The dates and postcode', raw);
}

/**
 * The quote as the renter reads it back.
 *
 * `strictObject`, so the day something adds `startAt` to this projection a test
 * fails rather than an instant reaching a page that would render it in the
 * browser's timezone.
 *
 * **Four things §8.5.2 lists are deliberately absent, and none of them is
 * zero.** The damage-security amount needs deposit bands, which
 * `category_versions` does not carry yet; the protection fee is Phase 10; taxes
 * do not apply to the launch category; and a delivery charge needs a priced
 * delivery service, where transport options today only describe how an item can
 * be collected. **A zero line would assert "no deposit" and "no tax", which are
 * claims this platform is not in a position to make** — the same call the
 * unconfigured fee policy makes by being visibly unconfigured rather than
 * plausibly free.
 *
 * **`total` is the headline and the only figure that may be shown largest**
 * (§3.4.4). The breakdown sits beside it because that section permits a base
 * price shown *alongside* an inclusive total, never instead of one.
 */
export const rentalQuoteSchema = z.strictObject({
  id: z.string().min(1),
  listingId: z.string().min(1),
  startDate: calendarDateSchema,
  /** Inclusive, as asked for. */
  endDate: calendarDateSchema,
  /** Local calendar days, counted the way equipment hire is priced (ADR 0003). */
  days: z.number().int().positive(),
  postcode: z.string(),
  lineItems: z.array(quoteLineItemSchema).min(1),
  /** What the owner is charging for the hire, before the platform's fee. */
  itemCharge: moneySchema,
  /**
   * The renter's mandatory fee (§3.4.4), after the category's minimum platform
   * fee has been applied.
   *
   * The owner's commission is deliberately not here: §3.4 deducts it from the
   * owner's payout, so the renter never pays it and it has no place in a figure
   * governed by a price-transparency rule.
   */
  renterFee: moneySchema,
  /** Whether the category's fee floor bound rather than the percentage. */
  minimumFeeApplied: z.boolean(),
  /**
   * What will be held against the renter's card at collection, or null where
   * this item's category requires no damage security (§8.7.2, slice 5.5b-ii).
   *
   * **Fixed by this quote, not merely displayed on it.** §8.7.2 requires the
   * values *"shown to both parties before booking"* and that *"bookings retain
   * the values current at creation"* — and the amount depends on the listing's
   * replacement value, which its owner may edit between the quote and the
   * request. Storing it here is what makes the figure the renter was shown the
   * figure their booking carries.
   *
   * **Never added to `total`.** §3.4.4 requires refundable security shown
   * separately from the headline; it is not a fee and no arithmetic on this page
   * may treat it as one.
   */
  appliedExcess: appliedExcessOrNoneSchema,
  /** `itemCharge + renterFee`. The headline. */
  total: moneySchema,
  /**
   * When the price stops holding, as an ISO instant in UTC.
   *
   * The one instant on this projection — see the module docblock for why it is
   * allowed to be one, and why whatever renders it must state a timezone.
   */
  expiresAt: z.string().min(1),
});

export type RentalQuote = z.infer<typeof rentalQuoteSchema>;

export function parseRentalQuote(raw: unknown): RentalQuote {
  return parseWith(rentalQuoteSchema, 'The quote', raw);
}
