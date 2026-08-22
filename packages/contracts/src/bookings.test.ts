import { describe, expect, it } from 'vitest';
import {
  BOOKINGS_ROUTE,
  BOOKING_ACCEPT_ROUTE,
  BOOKING_DECLINE_ROUTE,
  BOOKING_PAY_ROUTE,
  BOOKING_EVENT_TYPES,
  BOOKING_ROUTE,
  LISTING_REQUESTS_ROUTE,
  bookingAcceptPath,
  bookingPayPath,
  bookingDeclinePath,
  bookingPath,
  OWNER_BOOKINGS_ROUTE,
  listingRequestsPath,
  bookingDetailSchema,
  bookingSchema,
  parseBooking,
  parseBookingDetail,
  parseBookingRequest,
  parseBookingSummaries,
  parseOwnerBookings,
} from './bookings.js';
import { ContractViolationError } from './parse.js';

const gbp = (amount: number) => ({ amount, currency: 'GBP' as const });

const A_BOOKING = {
  id: 'booking-1',
  listingId: 'listing-1',
  state: 'REQUESTED',
  startDate: '2026-08-21',
  endDate: '2026-08-23',
  days: 3,
  itemTitle: 'Petrol hedge trimmer',
  categoryName: 'Outdoor and gardening',
  itemCharge: gbp(5_400),
  renterFee: gbp(432),
  total: gbp(5_832),
  appliedExcess: { amount: gbp(7_500), boundBy: 'floor' as const },
  lineItems: [{ unit: 'day', count: 3, unitPrice: gbp(1_800), subtotal: gbp(5_400) }],
  requestExpiresAt: '2026-08-22T09:00:00.000Z',
  events: [
    {
      type: 'requested',
      fromState: null,
      toState: 'REQUESTED',
      at: '2026-08-20T09:00:00.000Z',
    },
  ],
};

describe('the booking routes', () => {
  it('builds the path the route declares', () => {
    expect(bookingPath('booking-1')).toBe('/bookings/booking-1');
    expect(BOOKING_ROUTE).toBe('/bookings/:bookingId');
    expect(BOOKINGS_ROUTE).toBe('/bookings');
    expect(bookingAcceptPath('booking-1')).toBe('/bookings/booking-1/accept');
    expect(BOOKING_ACCEPT_ROUTE).toBe('/bookings/:bookingId/accept');
    expect(bookingDeclinePath('booking-1')).toBe('/bookings/booking-1/decline');
    expect(BOOKING_DECLINE_ROUTE).toBe('/bookings/:bookingId/decline');
    expect(bookingPayPath('booking-1')).toBe('/bookings/booking-1/pay');
    expect(BOOKING_PAY_ROUTE).toBe('/bookings/:bookingId/pay');
    expect(listingRequestsPath('listing-1')).toBe('/listings/listing-1/requests');
    expect(LISTING_REQUESTS_ROUTE).toBe('/listings/:id/requests');
  });
});

describe('the event vocabulary', () => {
  it('names only what can happen today', () => {
    /*
     * **Three members from 4.6, and the third had to be argued for.** An
     * acceptance and an owner's decline are both `state-changed` — `fromState`
     * and `toState` already say which, and a `'declined'` member would repeat
     * `toState` in a second vocabulary that could disagree with it.
     *
     * `auto-declined` exists because **nothing else can carry it**: an
     * auto-decline is `REQUESTED — DECLINED` exactly like an owner's decline, the
     * difference lives in `metadata`, and `bookingEventSchema` deliberately does
     * not project metadata to a party. Without the type the losing renter would
     * read *"declined"* where §7.1 requires them to be told it was a conflict.
     *
     * 4.7's expiry should ask the same question before adding a fourth.
     */
    expect(BOOKING_EVENT_TYPES).toEqual([
      'requested',
      'state-changed',
      'auto-declined',
    ]);
  });
});

describe('parseBookingRequest', () => {
  it('takes a quote id and nothing else', () => {
    expect(parseBookingRequest({ quoteId: 'quote-1' })).toEqual({ quoteId: 'quote-1' });
  });

  it('refuses a request with no quote', () => {
    // There is deliberately no way to book without one: it is what guarantees the
    // money was shown to somebody before it was agreed (§3.4.4).
    expect(() => parseBookingRequest({})).toThrow();
    expect(() => parseBookingRequest({ quoteId: '' })).toThrow();
  });
});

describe('parseBooking', () => {
  it('accepts the projection the API sends', () => {
    expect(() => parseBooking(A_BOOKING)).not.toThrow();
  });

  it('refuses an unexpected field, so an instant cannot reach a page', () => {
    expect(() =>
      parseBooking({ ...A_BOOKING, startAt: '2026-08-20T23:00:00Z' }),
    ).toThrow();
  });

  it('refuses a booking with no history, because §6.2 makes it part of one', () => {
    expect(() => parseBooking({ ...A_BOOKING, events: [] })).toThrow();
  });

  it('accepts a first event with no state to come from', () => {
    // `fromState: null` is the creation event and is legitimate — the booking was
    // never in `DRAFT`.
    const parsed = parseBooking(A_BOOKING);

    expect(parsed.events[0]?.fromState).toBe(null);
    expect(parsed.events[0]?.toState).toBe('REQUESTED');
  });

  it('refuses an event type nothing writes', () => {
    expect(() =>
      parseBooking({
        ...A_BOOKING,
        events: [{ type: 'vanished', fromState: null, toState: null, at: 'now' }],
      }),
    ).toThrow();
  });

  it('refuses a state that is not one of §7’s', () => {
    expect(() => parseBooking({ ...A_BOOKING, state: 'PENDING' })).toThrow();
  });

  it('carries no actor and no metadata, which are stored but not shown', () => {
    // An actor id is another person's identifier and the metadata holds facts
    // about somebody else's business. Both are on the record and neither is here.
    const parsed = parseBooking(A_BOOKING);

    expect(parsed.events[0]).not.toHaveProperty('actorId');
    expect(parsed.events[0]).not.toHaveProperty('metadata');
  });
});

const A_SUMMARY = {
  id: 'booking-1',
  listingId: 'listing-1',
  state: 'ACCEPTED',
  startDate: '2026-08-21',
  endDate: '2026-08-23',
  days: 3,
  itemTitle: 'Petrol hedge trimmer',
  categoryName: 'Outdoor and gardening',
  total: gbp(5_832),
  requestExpiresAt: '2026-08-22T09:00:00.000Z',
};

const AN_OWNER_SUMMARY = {
  id: 'booking-1',
  listingId: 'listing-1',
  state: 'ACCEPTED',
  startDate: '2026-08-21',
  endDate: '2026-08-23',
  days: 3,
  itemTitle: 'Petrol hedge trimmer',
  itemCharge: gbp(5_400),
  requestExpiresAt: '2026-08-22T09:00:00.000Z',
};

describe('the dashboard routes', () => {
  it('names its audience in the path, as /public/ and /admin/ do', () => {
    expect(OWNER_BOOKINGS_ROUTE).toBe('/owner/bookings');
  });

  it('keeps the owner route clear of the /bookings/:bookingId pattern', () => {
    // The alternatives — /bookings/received, /listings/bookings — would both be
    // matched only because Fastify prefers a static segment to a parametric one.
    // Nothing here depends on that.
    expect(OWNER_BOOKINGS_ROUTE.startsWith(BOOKINGS_ROUTE)).toBe(false);
  });
});

describe('parseBookingSummaries', () => {
  it('accepts the projection the API sends', () => {
    expect(() =>
      parseBookingSummaries({ bookings: [A_SUMMARY], truncated: false }),
    ).not.toThrow();
  });

  it('accepts an empty list, which is what somebody with no bookings reads', () => {
    expect(parseBookingSummaries({ bookings: [], truncated: false })).toEqual({
      bookings: [],
      truncated: false,
    });
  });

  it('refuses a list that does not say whether it was cut short', () => {
    // H2's rule and §10.1's: a truncated list that stays silent is one somebody
    // reads as their whole record.
    expect(() => parseBookingSummaries({ bookings: [A_SUMMARY] })).toThrow();
  });

  it('refuses an unexpected field, so an instant cannot reach a page', () => {
    expect(() =>
      parseBookingSummaries({
        bookings: [{ ...A_SUMMARY, startAt: '2026-08-20T23:00:00Z' }],
        truncated: false,
      }),
    ).toThrow();
  });

  it('carries no line items and no history, which the detail read owns', () => {
    const parsed = parseBookingSummaries({ bookings: [A_SUMMARY], truncated: false });

    expect(parsed.bookings[0]).not.toHaveProperty('lineItems');
    expect(parsed.bookings[0]).not.toHaveProperty('events');
  });

  it('refuses a state that is not one of §7’s', () => {
    expect(() =>
      parseBookingSummaries({
        bookings: [{ ...A_SUMMARY, state: 'PENDING' }],
        truncated: false,
      }),
    ).toThrow();
  });
});

describe('parseOwnerBookings', () => {
  it('accepts the projection the API sends', () => {
    expect(() =>
      parseOwnerBookings({ bookings: [AN_OWNER_SUMMARY], truncated: false }),
    ).not.toThrow();
  });

  it('states the owner’s own charge and no payout', () => {
    // §3.4's commission arithmetic is Phase 5. A figure here presented as what
    // the owner receives would be a false sentence about money.
    const parsed = parseOwnerBookings({
      bookings: [AN_OWNER_SUMMARY],
      truncated: false,
    });

    expect(parsed.bookings[0]?.itemCharge).toEqual(gbp(5_400));
    expect(parsed.bookings[0]).not.toHaveProperty('payout');
    expect(parsed.bookings[0]).not.toHaveProperty('total');
    expect(parsed.bookings[0]).not.toHaveProperty('renterFee');
  });

  it('does not name the renter', () => {
    // §8.4.1's posture: identity arrives with commitment, and there is no
    // mechanism for it yet. Additive later; unremovable once shipped.
    const parsed = parseOwnerBookings({
      bookings: [AN_OWNER_SUMMARY],
      truncated: false,
    });

    expect(parsed.bookings[0]).not.toHaveProperty('renterId');
    expect(parsed.bookings[0]).not.toHaveProperty('renterName');
  });

  it('refuses the renter’s inclusive total appearing on the owner’s row', () => {
    expect(() =>
      parseOwnerBookings({
        bookings: [{ ...AN_OWNER_SUMMARY, total: gbp(5_832) }],
        truncated: false,
      }),
    ).toThrow();
  });

  it('refuses a list that does not say whether it was cut short', () => {
    expect(() => parseOwnerBookings({ bookings: [AN_OWNER_SUMMARY] })).toThrow();
  });
});

/**
 * The detail projection and its payability (slice 5.2d).
 *
 * **What this schema is for is preventing an unexplained dead control.** A page
 * has no other way to know whether a pay button would work — the flag is behind
 * an admin-gated route — so the shape has to make *unavailable with no reason*
 * impossible rather than merely discouraged.
 */
describe('bookingDetailSchema', () => {
  const detail = {
    ...A_BOOKING,
    payability: { payable: true },
    // Both parties read this projection, and every sentence addressed to "you"
    // depends on which (slice 5.5b-ii).
    viewer: 'renter',
  };

  it('is the booking plus whether the reader may pay', () => {
    expect(parseBookingDetail(detail)).toEqual(detail);
  });

  /**
   * **Built from `bookingSchema.shape`, so the two cannot drift.** A field added
   * to a booking appears here without anybody remembering to add it — the
   * alternative is two lists that both parse while describing different things.
   */
  it('carries every field a booking has', () => {
    expect(Object.keys(bookingDetailSchema.shape)).toEqual([
      ...Object.keys(bookingSchema.shape),
      'payability',
      'viewer',
    ]);
  });

  it('refuses an unavailable payment with no reason', () => {
    // The whole point of the union: a control with no explanation beside it is
    // the defect this field exists to remove.
    expect(() =>
      parseBookingDetail({ ...detail, payability: { payable: false } }),
    ).toThrow(ContractViolationError);
  });

  it('refuses an available payment carrying a reason', () => {
    // Nothing to explain when the button works, and a stray sentence would end
    // up rendered beside it.
    expect(() =>
      parseBookingDetail({
        ...detail,
        payability: { payable: true, reason: 'why?' },
      }),
    ).toThrow(ContractViolationError);
  });

  it('refuses an empty reason', () => {
    expect(() =>
      parseBookingDetail({ ...detail, payability: { payable: false, reason: '' } }),
    ).toThrow(ContractViolationError);
  });

  it('refuses a booking with no payability at all', () => {
    // That payload is the collection projection arriving on the detail route.
    expect(() => parseBookingDetail(A_BOOKING)).toThrow(ContractViolationError);
  });
});
