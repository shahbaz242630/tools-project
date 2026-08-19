/**
 * The owner's calendar, on the wire (BRD §8.5, slice 4.3b).
 *
 * **Every date here is a calendar date, never an instant, and that is the whole
 * design of this file.** The database stores a half-open `[startAt, endAt)` pair
 * of `timestamptz`; an owner picks two days off a calendar. Between those two
 * facts sits a timezone conversion, and the rule is that **it happens on the
 * server, once, in the platform's timezone**.
 *
 * The alternative — shipping instants and letting the page render them — puts
 * the conversion in the browser, where the timezone is whatever the device says
 * it is. That is not hypothetical: the machine this was written on geolocates to
 * Dubai, so a Bristol owner's block would have drawn a day late for as long as
 * anybody was travelling. It is also the mistake that is invisible in review,
 * because it is right for everybody testing from London seven months a year.
 *
 * So: **`YYYY-MM-DD` in, `YYYY-MM-DD` out, and no `Date` crosses this
 * boundary.**
 *
 * **`endDate` is inclusive**, which is deliberately *not* how it is stored. A
 * person who says "the 20th to the 22nd" means three days including the 22nd,
 * and a wire format that made them say "to the 23rd" would be exporting the
 * database's half-open convention to the one audience least equipped to reason
 * about it. The service converts.
 */

import { z } from 'zod';
import { Time } from '@platform/core';
import { hasUnsafeCharacters, UNSAFE_CHARACTERS_MESSAGE } from './text.js';
import { parseWith } from './parse.js';

/**
 * One listing's calendar — read a month of it, or add a period to it.
 *
 * **A sub-resource of the listing rather than a top-level `/availability`.**
 * Every question here is about one listing, ownership is checked against that
 * listing, and a flat collection would need the id as a parameter anyway — with
 * the difference that forgetting it would be a route returning everybody's
 * calendar rather than a compile error.
 */
export function listingAvailabilityPath(id: string): string {
  return `/listings/${encodeURIComponent(id)}/availability`;
}

export const LISTING_AVAILABILITY_ROUTE = '/listings/:id/availability';

/**
 * One declared period, addressed by its own id.
 *
 * **Nested under the listing even though the block id is unique on its own**,
 * and that is the security half of the path rather than tidiness: the store's
 * `unblock` takes the listing too, so a block id lifted from somebody else's
 * calendar cannot be deleted by aiming it at this route. A flat
 * `/availability/:blockId` would make the ownership check something the handler
 * has to remember rather than something the path already carries.
 */
export function listingAvailabilityBlockPath(id: string, blockId: string): string {
  return `${listingAvailabilityPath(id)}/${encodeURIComponent(blockId)}`;
}

export const LISTING_AVAILABILITY_BLOCK_ROUTE = '/listings/:id/availability/:blockId';

/**
 * The owner's private note on a period.
 *
 * Short on purpose. It is a label on a calendar cell — "away", "servicing",
 * "lent to my brother" — and anything longer is a conversation, which is
 * Phase 6's. **It never leaves the owner's own surface**: a renter is told a
 * period is unavailable and never why.
 */
export const MAX_BLOCK_REASON_LENGTH = 200;

/**
 * A calendar date, exactly as `YYYY-MM-DD`.
 *
 * **Validated by the same function that later converts it** (`startOfLocalDay`),
 * rather than by a regular expression that agrees with it by eye. A regex admits
 * `2026-02-30`, and a date the contract accepted but the conversion throws on is
 * a 500 on a route somebody reached by typing into a form.
 */
export const calendarDateSchema = z
  .string()
  .trim()
  .refine(isCalendarDate, { message: 'must be a date, as YYYY-MM-DD' });

function isCalendarDate(value: string): boolean {
  try {
    Time.startOfLocalDay(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A month of the calendar, as `YYYY-MM`.
 *
 * Its own schema rather than a loosened date, because the two are asked for in
 * different places and a month that quietly accepted a full date would put
 * `?month=2026-08-20` in circulation as a link — which renders August and looks
 * exactly like it worked.
 */
export const calendarMonthSchema = z
  .string()
  .trim()
  .refine((value) => /^\d{4}-\d{2}$/.test(value) && isCalendarDate(`${value}-01`), {
    message: 'must be a month, as YYYY-MM',
  });

/**
 * What an owner submits to declare a period unavailable.
 *
 * **The only rule here is ordering**, and everything else a block must satisfy —
 * that it has not already finished, that it is not decades away, that it is not
 * absurdly long — lives in the service. Those three need to know what today is,
 * and a schema that reads the clock is one whose tests pass or fail depending on
 * when they run. The split is the one `moderationDecisionSchema` documents: the
 * shape is here, the policy is beside the thing it is a policy about.
 */
export const availabilityBlockRequestSchema = z
  .object({
    startDate: calendarDateSchema,
    /** Inclusive — the last day that is blocked. See the module docblock. */
    endDate: calendarDateSchema,
    /**
     * Trimmed, and empty becomes absent — `moderationDecisionSchema`'s
     * treatment, for its reason: a note of `"   "` satisfies "a string is
     * present" and satisfies nobody reading it a month later.
     *
     * **No minimum length.** An administrative reason has a floor because
     * somebody else reads it and is owed an explanation; this one is the owner
     * talking to themselves, and "MOT" is a perfectly good note.
     */
    reason: z
      .string()
      .trim()
      .max(MAX_BLOCK_REASON_LENGTH)
      .refine((value) => !hasUnsafeCharacters(value), UNSAFE_CHARACTERS_MESSAGE)
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .optional()
      .transform((value) => value ?? null),
  })
  .refine((block) => block.endDate >= block.startDate, {
    // String comparison is date comparison for `YYYY-MM-DD`, which is the one
    // useful property of the format and the reason it is the format.
    message: 'the last day cannot fall before the first',
    path: ['endDate'],
  });

export type AvailabilityBlockRequest = z.infer<typeof availabilityBlockRequestSchema>;

export function parseAvailabilityBlockRequest(raw: unknown): AvailabilityBlockRequest {
  return parseWith(availabilityBlockRequestSchema, 'The period to block', raw);
}

/**
 * One declared period, as the owner reads it back.
 *
 * `strictObject`, so the day something adds `startAt` to this projection the
 * parser fails in a test rather than the instant reaching a page that would
 * render it in the browser's timezone.
 */
export const availabilityBlockSchema = z.strictObject({
  id: z.string().min(1),
  startDate: calendarDateSchema,
  /** Inclusive, as submitted. */
  endDate: calendarDateSchema,
  reason: z.string().nullable(),
});

export type AvailabilityBlock = z.infer<typeof availabilityBlockSchema>;

/**
 * A period a booking holds (BRD §8.5, slice 4.8c).
 *
 * **Dates and an id, and deliberately nothing about the person.** §8.4.1's
 * posture is that identity arrives with commitment rather than before it, and
 * `listingRequestSchema` already refuses to name a renter on the surface where an
 * owner is *deciding*. A calendar is a question about time; putting a name on it
 * would disclose more from a grid of shaded squares than from the request itself.
 *
 * **No money either.** What a hire earns is on the owner's booking list (4.8b),
 * beside the sentence that keeps it from being read as a payout. A figure on a
 * calendar cell would have nowhere to carry that qualification.
 *
 * **The id is here for the page's keys and nothing else today.** There is no
 * per-booking page to link to; 4.8b's list is where a booking is read. It is
 * carried rather than omitted because a period with no identity cannot be
 * rendered as a stable list, and inventing one in the browser is how two renders
 * disagree.
 */
export const bookedPeriodSchema = z.strictObject({
  id: z.string().min(1),
  startDate: calendarDateSchema,
  /** Inclusive, exactly as a block's is. */
  endDate: calendarDateSchema,
});

export type BookedPeriod = z.infer<typeof bookedPeriodSchema>;

/**
 * A month of one listing's calendar.
 *
 * **The blocks are the ones that *touch* the month, not the ones contained by
 * it**, so a fortnight running from 28 July appears on August's page with its
 * real dates. A page that only received contained blocks would draw the first
 * days of the month as free while the API refused bookings for them. The booked
 * periods are read the same way, for the same reason.
 *
 * **`bookings` arrived in 4.8c and completes §8.5's three concepts** — available,
 * unavailable, booked. Until then the page carried a sentence saying bookings
 * were not built, which stopped being true when 4.6a shipped and stayed on the
 * page until this slice.
 *
 * **Only §8.5.1's nine calendar-occupying states appear here, and `REQUESTED` is
 * emphatically not one of them.** §7.1 makes a pending request non-blocking on
 * purpose: several renters may ask for the same dates and the first acceptance
 * takes them. Drawing one as booked would tell an owner a date was gone when
 * anybody could still book it — and would make the calendar disagree with the
 * request path about the same day.
 */
export const listingAvailabilitySchema = z.strictObject({
  month: calendarMonthSchema,
  blocks: z.array(availabilityBlockSchema),
  bookings: z.array(bookedPeriodSchema),
});

export type ListingAvailability = z.infer<typeof listingAvailabilitySchema>;

export function parseListingAvailability(raw: unknown): ListingAvailability {
  return parseWith(listingAvailabilitySchema, 'The availability calendar', raw);
}

export function parseAvailabilityBlock(raw: unknown): AvailabilityBlock {
  return parseWith(availabilityBlockSchema, 'The blocked period', raw);
}

/** The month a date falls in, as `YYYY-MM`. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** The first day of a month, as `YYYY-MM-DD` — the form the date helpers take. */
export function firstDayOf(month: string): string {
  return `${month}-01`;
}
