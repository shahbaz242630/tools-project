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
 * Where a renter pays for a booking their owner accepted (§8.7, slice 5.2c).
 *
 * **A verb under the booking, like accepting and declining**, and for the same
 * reason: it is something one party does to one booking, not a resource anybody
 * lists. It is deliberately not `/payments/…` — a payment is Payments' concept,
 * and what a renter is doing is paying for *this hire*.
 *
 * **No body.** What is owed was fixed when the booking was made (§8.2) and is on
 * its row; a client that could send an amount could send the wrong one, and every
 * page that displayed a total would become a place the price could be argued
 * with. §8.7 is explicit that charges are calculated server-side only.
 */
export function bookingPayPath(id: string): string {
  return `/bookings/${id}/pay`;
}

export const BOOKING_PAY_ROUTE = '/bookings/:bookingId/pay';

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
 * Whether this booking can be paid for right now, and if not, why (slice 5.2d).
 *
 * **It exists so a page never has to guess.** CLAUDE.md forbids dead controls:
 * every button either calls real behaviour or is visibly unavailable. The only
 * way for a renter's page to know which one a pay button is would otherwise be to
 * read `booking.payment`'s flag state — and the sole route exposing that is
 * admin-gated behind ADR 0021's second factor. So the booking answers instead,
 * and the browser never learns that a flag exists.
 *
 * **A discriminated union rather than a boolean with an optional sentence**,
 * which is the deliberate difference from `bookingPaymentSchema` below. That one
 * has four statuses and documents which fields accompany which; this has two
 * cases, and the invalid combination — *unavailable, with no explanation* — is
 * precisely the defect this field was added to prevent. Making it unrepresentable
 * costs one line and removes the possibility.
 *
 * **The sentence is the same one the route refuses with.** Both come from
 * `payability.ts` in the API, because a page that explained the refusal
 * differently from the 422 would be telling a renter two stories about one
 * booking.
 */
export const bookingPayabilitySchema = z.discriminatedUnion('payable', [
  z.strictObject({ payable: z.literal(true) }),
  z.strictObject({ payable: z.literal(false), reason: z.string().min(1) }),
]);

export type BookingPayability = z.infer<typeof bookingPayabilitySchema>;

/**
 * One booking as the party looking at it reads it, with whether they may pay
 * (slice 5.2d).
 *
 * **The detail projection, and the only one carrying payability.** `bookingSchema`
 * is also what create, accept and decline return; extending *it* would put a
 * feature-flag read and a suspension check on three routes for an answer none of
 * them uses. Confining it here is the two-projection rule `audit/` already
 * follows.
 *
 * **Built from `bookingSchema.shape` rather than restating fourteen fields**, so
 * a field added to a booking cannot be forgotten here — the alternative is two
 * lists that drift, and the drift is silent because both parse.
 */
export const bookingDetailSchema = z.strictObject({
  ...bookingSchema.shape,
  payability: bookingPayabilitySchema,
});

export type BookingDetail = z.infer<typeof bookingDetailSchema>;

export function parseBookingDetail(raw: unknown): BookingDetail {
  return parseWith(bookingDetailSchema, 'The booking', raw);
}

/**
 * What the payer must do next, when a card payment cannot finish in one step
 * (slice 5.2c).
 *
 * **This is the one field in the whole API that crosses to the browser to be
 * consumed by somebody else's code.** Strong Customer Authentication means a UK
 * card payment usually needs a 3-D Secure challenge, and the provider's own
 * browser library is what runs it — so the token has to reach the page.
 *
 * **It is a short-lived bearer value and nothing may treat it as more.** Nothing
 * stores it, nothing logs it, nothing puts it in a metric label, and no page
 * parses it: the moment something reads its contents we have a provider's format
 * in our code, which ADR 0051 exists to prevent.
 *
 * **`kind` is named rather than implied**, so adding a redirect-based flow later
 * is a compile error at every reader instead of a surprise on somebody's phone.
 */
export const payerActionSchema = z.strictObject({
  kind: z.literal('confirm_in_browser'),
  token: z.string().min(1),
});

export type PayerAction = z.infer<typeof payerActionSchema>;

/**
 * Where a payment attempt got to, as the renter who made it is told.
 *
 * **Four statuses, and the first two differ in exactly one way that matters**:
 * `pending_payer_action` comes with a token and something for the payer to do,
 * `processing` means wait. Both leave the booking in `AWAITING_PAYMENT`.
 */
export const PAYMENT_STATUSES = [
  'pending_payer_action',
  'processing',
  'succeeded',
  'failed',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/**
 * What happened when the renter pressed pay (slice 5.2c).
 *
 * **A sentence on failure and never a reason code.** Payments categorises a
 * failure for its own reconciliation — declined, authentication failed, provider
 * error — and a renter can act on none of the differences: all three mean *try
 * again, or use another card*. Projecting the category would put a vocabulary on
 * the wire that nothing needs and everything would afterwards have to keep.
 *
 * **The booking comes back with it**, rather than the client inferring a state
 * from the payment: §7 is the authority on what a booking is, and a page that
 * derived `RESERVED` from `succeeded` would be a second implementation of the
 * state machine living in a browser.
 */
export const bookingPaymentSchema = z.strictObject({
  booking: bookingSchema,
  payment: z.strictObject({
    status: paymentStatusSchema,
    /** Present only when the status is `pending_payer_action`. */
    payerAction: payerActionSchema.optional(),
    /** Present only when the status is `failed`. */
    failureMessage: z.string().min(1).optional(),
  }),
});

export type BookingPayment = z.infer<typeof bookingPaymentSchema>;

export function parseBookingPayment(raw: unknown): BookingPayment {
  return parseWith(bookingPaymentSchema, 'The payment', raw);
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

/**
 * Where each party reads the bookings they are part of (§14's *booking
 * dashboards for both parties*, slice 4.8a).
 *
 * **Two routes rather than one with a `?role=`, and it is a security decision
 * before it is a design one.** A role parameter is a scope the *caller* chooses.
 * Every scoped read in this system takes its scope from the session and puts it
 * in the query — `GET /listings` is the owner's own, and `findForParty` puts the
 * party comparison in the `where` precisely so no line afterwards can be deleted.
 * A route that branched on a parameter would be the first place a caller named
 * their own scope, and the failure mode if that branch is ever wrong is one
 * person reading another's bookings.
 *
 * **They are also two different projections, not one shape with optional
 * fields** — the argument `listingRequestSchema` already makes at length. A
 * single response would have to either hand the owner the renter's inclusive
 * total, which reads as what they receive and is a false sentence about money, or
 * withhold the total from the renter, who is owed it under §3.4.4.
 *
 * **`/owner/` names an audience, as `/public/`, `/admin/` and `/internal/` do.**
 * ADR 0048's reasoning: a prefix that says who a route is for is one a log line,
 * a route table and an eventual edge rule can all read at a glance. The
 * alternatives considered — `/bookings/received` and `/listings/bookings` — both
 * depend on the router preferring a static segment to a parametric one, which is
 * true of Fastify and is a dependency a reader has to already know about.
 *
 * **The renter's list is `GET /bookings`, the bare collection**, which in this
 * codebase already means *mine, as the session names me*. It is the sibling of
 * the `POST` that creates one.
 *
 * **One name per route, and `_ROUTE` is it.** This was `OWNER_BOOKINGS_PATH`
 * and `OWNER_BOOKINGS_ROUTE`, two exported constants holding the same literal
 * on adjacent lines — the web app dialled one, the API registered the other,
 * and a test pinned each to `'/owner/bookings'` separately. That did stop them
 * diverging, but by watching two names rather than by having one. Four other
 * routes carried the same pair. The distinction they suggested is not real:
 * `_ROUTE` may hold a `:param` template and `_PATH` a concrete URL, but for a
 * route with no parameter those are the same string, and `BOOKINGS_ROUTE`
 * above never had a twin. A parameterised route gets a builder function
 * instead — {@link bookingPath} — which is where the two ideas genuinely part.
 */
export const OWNER_BOOKINGS_ROUTE = '/owner/bookings';

/**
 * One booking in the renter's own list.
 *
 * **A summary rather than `bookingSchema`, and the omissions are the point.**
 * The line items and the event history are what a *record* of one hire is, and
 * they are a click away on `GET /bookings/:bookingId`. Putting them on every row
 * of a list would ship an unbounded nested array per booking to render a line of
 * text.
 *
 * **The inclusive `total` and no breakdown.** §3.4.4 requires the figure a renter
 * is shown to include mandatory fees wherever a price appears, and a list of
 * hires is such a place; the split into charge and fee belongs beside the detail
 * that explains it.
 *
 * **`requestExpiresAt` is carried on every row, not only a requested one**, for
 * `bookingSchema`'s reason: it records what the deadline *was*, and a booking
 * that beat it is more legible with it than without.
 */
export const bookingSummarySchema = z.strictObject({
  id: z.string().min(1),
  listingId: z.string().min(1),
  state: bookingStateSchema,
  startDate: calendarDateSchema,
  /** Inclusive, as the renter asked for it. */
  endDate: calendarDateSchema,
  days: z.number().int().positive(),
  itemTitle: z.string().min(1),
  categoryName: z.string().min(1),
  /** Inclusive of mandatory fees (§3.4.4). */
  total: moneySchema,
  /** When this expired unanswered, or would have (§8.6). ISO 8601 UTC. */
  requestExpiresAt: z.string().min(1),
});

export type BookingSummary = z.infer<typeof bookingSummarySchema>;

/**
 * The renter's bookings, newest first.
 *
 * **`truncated` rather than silence**, which is H2's rule and §10.1's: a list cut
 * short without saying so is one somebody reads as their whole record, and the
 * person who hits the bound is by definition the one with most to look at.
 */
export const bookingSummariesSchema = z.strictObject({
  bookings: z.array(bookingSummarySchema),
  truncated: z.boolean(),
});

export type BookingSummaries = z.infer<typeof bookingSummariesSchema>;

export function parseBookingSummaries(raw: unknown): BookingSummaries {
  return parseWith(bookingSummariesSchema, 'The bookings', raw);
}

/**
 * One booking in the owner's list, across all of their listings.
 *
 * **`itemCharge` and deliberately no payout**, which is the wording 4.6b settled
 * and this reuses rather than reinvents: it is what the hire earns at the owner's
 * own rates, before the platform's cut. §3.4 deducts commission from a payout and
 * neither the arithmetic nor the payout exists until Phase 5, so a figure here
 * that read as *what I receive* would be false.
 *
 * **The renter is not named.** `listingRequestSchema` argues it for a request, and
 * nothing changes on acceptance: identity arriving with commitment is a decision
 * with no mechanism behind it yet, Phase 6 owns the conversation, and a name is
 * additive later where removing one is not.
 *
 * **`itemTitle` is here where the request projection omits it**, and the reason is
 * the scope: `listingRequestSchema` is already nested under one listing, so the
 * page knows what the item is. This list spans every listing an owner has, and a
 * row without the item's name would be a date range belonging to nothing.
 */
export const ownerBookingSummarySchema = z.strictObject({
  id: z.string().min(1),
  listingId: z.string().min(1),
  state: bookingStateSchema,
  startDate: calendarDateSchema,
  /** Inclusive, as the renter asked for it. */
  endDate: calendarDateSchema,
  days: z.number().int().positive(),
  itemTitle: z.string().min(1),
  /** What the hire earns at the owner's own rates, before the platform's cut. */
  itemCharge: moneySchema,
  /** When this expired unanswered, or would have (§8.6). ISO 8601 UTC. */
  requestExpiresAt: z.string().min(1),
});

export type OwnerBookingSummary = z.infer<typeof ownerBookingSummarySchema>;

/** The bookings on this owner's listings, newest first. */
export const ownerBookingsSchema = z.strictObject({
  bookings: z.array(ownerBookingSummarySchema),
  truncated: z.boolean(),
});

export type OwnerBookings = z.infer<typeof ownerBookingsSchema>;

export function parseOwnerBookings(raw: unknown): OwnerBookings {
  return parseWith(ownerBookingsSchema, 'The bookings', raw);
}
