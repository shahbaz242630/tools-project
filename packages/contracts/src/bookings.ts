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

export function bookingAcceptPath(id: string): string {
  return `/bookings/${id}/accept`;
}

export const BOOKING_ACCEPT_ROUTE = '/bookings/:bookingId/accept';

export function bookingDeclinePath(id: string): string {
  return `/bookings/${id}/decline`;
}

export const BOOKING_DECLINE_ROUTE = '/bookings/:bookingId/decline';

/**
 * The requests against one listing, as its owner reads them (slice 4.6).
 *
 * **Nested under the listing, unlike every other booking route.** The two above
 * answer about one booking whose id the caller already had; this asks *what is
 * waiting on me for this item*, which is a question about the listing. It is also
 * the only owner-scoped read in this module.
 */
export function listingRequestsPath(id: string): string {
  return `/listings/${id}/requests`;
}

export const LISTING_REQUESTS_ROUTE = '/listings/:id/requests';

/**
 * Where scheduled work is set off (slice 4.7a, ADR 0048).
 *
 * **Under `/internal/` because that prefix is the audience, not a version.** Every
 * other route in this API answers to a person holding a session; this one answers to
 * a machine holding a shared secret, and the two need to be distinguishable at a
 * glance — in a route table, in a log line, and in the WAF rule that will eventually
 * refuse this path at the edge outright. It is deliberately not `/bookings/expire`,
 * which would sit among the routes an owner calls.
 *
 * **No path parameter and no body.** A sweep takes no arguments: *which* requests
 * have lapsed is a question only the database can answer, and a caller that could
 * name them could name the wrong ones.
 */
export const EXPIRE_REQUESTS_ROUTE = '/internal/bookings/expire-requests';

/**
 * What a sweep did, as the caller is told it (slice 4.7a).
 *
 * **A count and ids, never the bookings.** The trigger is a machine with no user
 * and no scope, so anything richer would be handing an unscoped caller the terms of
 * somebody's hire. The ids are ours, meaningless alone, and they are what makes a
 * worker's log line traceable to rows.
 *
 * `strictObject`, as every projection in this module is: a field added on the server
 * and forgotten on the client fails loudly rather than being dropped in transit.
 */
export const expirySweepSchema = z.strictObject({
  expired: z.number().int().nonnegative(),
  /*
   * `min(1)` rather than `uuid()`, matching `bookingSchema` and
   * `listingRequestSchema` above. The module types an id as a non-empty string
   * throughout so a fake can use a readable one — a projection that demanded a uuid
   * would be a contract only the database could satisfy, and the integration tests
   * boot the real routing over in-memory storage.
   */
  bookingIds: z.array(z.string().min(1)),
  /** The batch bound was reached, so the caller should sweep again sooner. */
  reachedLimit: z.boolean(),
});

export type ExpirySweep = z.infer<typeof expirySweepSchema>;

export function parseExpirySweep(value: unknown): ExpirySweep {
  return parseWith(expirySweepSchema, 'The sweep', value);
}

/**
 * What happened to a booking (§6.2's *event type*).
 *
 * **A closed union in code rather than a database enum**, the call
 * `bookings.state` and `listings.status` both make: §7's vocabulary is the kind of
 * thing a phase discovers a new member of, and a Postgres enum needs a migration
 * to gain one.
 *
 * **4.6 added exactly one member, and the restraint is the point.** An acceptance
 * and an owner's decline are both `state-changed`: `fromState` and `toState`
 * already say which, and a `'declined'` type would only repeat `toState` in a
 * second vocabulary that could disagree with it.
 *
 * **`auto-declined` earns its place because nothing else can carry it.** §7.1
 * requires an auto-declined renter to be *"notified with the reason"*, and an
 * auto-decline is `REQUESTED — DECLINED` exactly like an owner's decline — the only
 * difference is why. That difference is stored in `metadata`, and **`bookingEvent
 * Schema` deliberately does not project metadata**, because it also holds facts
 * about the other party. So without a distinct type the renter would read *"your
 * request was declined"* when the truth is *"somebody else's acceptance took the
 * dates"* — a meaningfully different thing to be told, and the one §7.1 names.
 *
 * 4.7 adds expiry, and it should ask the same question before adding a member.
 */
export const BOOKING_EVENT_TYPES = [
  'requested',
  'state-changed',
  'auto-declined',
] as const;

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

/**
 * One request, as the **owner** deciding on it reads it (BRD §8.6, §7.1, slice
 * 4.6).
 *
 * **A different projection from `bookingSchema`, not a subset of it.** The two
 * answer different questions: that one is *what did I agree to*, read by either
 * party about a booking that exists; this one is *what am I being asked, and what
 * would saying yes cost me*. The overlap is real and the audiences are not, which
 * is what makes one shape with optional fields the wrong economy.
 *
 * **The renter is not named, and that is deliberate.** An owner deciding whether
 * to hire out a drill is deciding about dates and a price, not about a person —
 * and §8.4.1's whole posture is that identity arrives with commitment rather than
 * before it. Phase 6 opens a conversation once there is a booking; nothing here
 * needs a name, so nothing here carries one.
 *
 * **`itemCharge` is the owner's own money and is labelled as such, and there is
 * deliberately no payout figure.** §3.4 deducts the owner's commission from the
 * payout, and neither the commission arithmetic nor the payout exists until Phase
 * 5. Showing the renter's inclusive total to an owner would read as what they
 * receive, which would be a false sentence about money — the exact class of defect
 * the Phase 0–3 audit found three of.
 */
export const listingRequestSchema = z.strictObject({
  id: z.string().min(1),
  startDate: calendarDateSchema,
  /** Inclusive, as the renter asked for it. */
  endDate: calendarDateSchema,
  days: z.number().int().positive(),
  /** What the hire earns at the owner's own rates, before the platform's cut. */
  itemCharge: moneySchema,
  /** When this request expires unanswered (§8.6), as an ISO instant. */
  requestExpiresAt: z.string().min(1),
  /**
   * The other requests this one would auto-decline if accepted (§7.1).
   *
   * **§7.1 requires this and it is easy to read past**: *"Owners must be shown,
   * before accepting, that competing requests exist and will be declined."* A
   * count rather than a list, because the owner is owed the consequence of their
   * click and not a roster of strangers' dates.
   */
  conflictCount: z.number().int().nonnegative(),
});

export type ListingRequest = z.infer<typeof listingRequestSchema>;

export const listingRequestsSchema = z.strictObject({
  requests: z.array(listingRequestSchema),
});

export type ListingRequests = z.infer<typeof listingRequestsSchema>;

export function parseListingRequests(raw: unknown): ListingRequests {
  return parseWith(listingRequestsSchema, 'The requests', raw);
}
