/**
 * Making a booking, and the history a booking accumulates (BRD §8.6, §6.2, §7,
 * slice 4.5a).
 *
 * **The vocabulary of *states* is in `booking.ts` beside the state machine.** This
 * file is about the two things 4.5a adds: what a renter submits to make a request,
 * and what either party reads back.
 *
 * **Dates on the wire, never instants** — 4.3b's rule, and `strictObject`
 * projections are what keep it true. The two exceptions here are both moments
 * rather than days somebody chose: `requestExpiresAt` and an event's `at`.
 */

import { z } from 'zod';
import { bookingStateSchema } from './booking.js';
import { calendarDateSchema } from './availability.js';
import { moneySchema } from './money.js';
import { parseWith } from './parse.js';
import { quoteLineItemSchema } from './quotes.js';

export const BOOKINGS_ROUTE = '/bookings';

export function bookingPath(id: string): string {
  return `/bookings/${id}`;
}

export const BOOKING_ROUTE = '/bookings/:bookingId';

/**
 * What happened to a booking (§6.2's *event type*).
 *
 * **A closed union in code rather than a database enum**, the call
 * `bookings.state` and `listings.status` both make: §7's vocabulary is the kind of
 * thing a phase discovers a new member of, and a Postgres enum needs a migration
 * to gain one.
 *
 * **Only two members today, and that is honest rather than unfinished.** 4.5a can
 * create a request and nothing else — 4.6 adds acceptance, decline and §7.1's
 * auto-decline, 4.7 adds expiry. Adding those names now would put unreachable
 * values in a vocabulary that everything downstream must handle.
 */
export const BOOKING_EVENT_TYPES = ['requested', 'state-changed'] as const;

export type BookingEventType = (typeof BOOKING_EVENT_TYPES)[number];

export const bookingEventTypeSchema = z.enum(BOOKING_EVENT_TYPES);

/**
 * What a renter submits to request a booking.
 *
 * **A quote id and nothing else.** The dates, the postcode, the price and the
 * configuration version are all on the quote already — asking for them again would
 * be asking a client to restate facts the server holds, and any disagreement
 * between the two would have to be resolved by trusting one of them. §8.5.2 makes
 * the quote the artefact a price lives on; this makes it the artefact a booking is
 * made from.
 *
 * **So there is deliberately no way to book without a quote.** That is what
 * guarantees a booking's money was shown to somebody before it was agreed, which
 * is §3.4.4's whole point.
 */
export const bookingRequestSchema = z.object({
  quoteId: z.string().min(1),
});

export type BookingRequest = z.infer<typeof bookingRequestSchema>;

export function parseBookingRequest(raw: unknown): BookingRequest {
  return parseWith(bookingRequestSchema, 'The request', raw);
}

/**
 * One thing that happened, as a party to the booking reads it.
 *
 * **No actor id and no metadata.** Both are stored (§6.2) and neither belongs on
 * a projection read by a member: an actor id is another person's identifier, and
 * the metadata is where a refusal reason or a conflicting booking's id lives —
 * facts about somebody else's business. What a party is owed is *what happened and
 * when*, which is what this carries.
 */
export const bookingEventSchema = z.strictObject({
  type: bookingEventTypeSchema,
  fromState: bookingStateSchema.nullable(),
  toState: bookingStateSchema.nullable(),
  /** ISO 8601 UTC. A moment, not a day somebody chose. */
  at: z.string().min(1),
});

export type BookingEvent = z.infer<typeof bookingEventSchema>;

/**
 * A booking as either party reads it.
 *
 * **Every money and item field is the copy taken when the booking was made**, not
 * a join through the listing (§8.2, and the product owner's *"if the booking is
 * done, it should show in history, all details"*). That is what lets this render
 * after the listing has been retitled, repriced, paused or erased.
 *
 * **`listingId` is here and the owner's identity is not.** A renter needs the link
 * back to what they hired; who owns it is Phase 6's conversation and Phase 5's
 * payout, and neither is a fact this projection owes anybody.
 */
export const bookingSchema = z.strictObject({
  id: z.string().min(1),
  listingId: z.string().min(1),
  state: bookingStateSchema,
  startDate: calendarDateSchema,
  /** Inclusive, as the renter asked for it. */
  endDate: calendarDateSchema,
  days: z.number().int().positive(),
  /** What was hired, in the words on the listing at the time. */
  itemTitle: z.string().min(1),
  categoryName: z.string().min(1),
  itemCharge: moneySchema,
  renterFee: moneySchema,
  total: moneySchema,
  lineItems: z.array(quoteLineItemSchema).min(1),
  /**
   * When an unanswered request expires, as an ISO instant (§8.6).
   *
   * Carried on every booking rather than only on a requested one, because it
   * records what the deadline *was* — and a booking that was accepted in time is
   * more legible with the deadline it beat than without it.
   */
  requestExpiresAt: z.string().min(1),
  /** Oldest first, which is how a history reads. */
  events: z.array(bookingEventSchema).min(1),
});

export type Booking = z.infer<typeof bookingSchema>;

export function parseBooking(raw: unknown): Booking {
  return parseWith(bookingSchema, 'The booking', raw);
}
