import { describe, expect, it } from 'vitest';
import {
  BOOKINGS_ROUTE,
  BOOKING_EVENT_TYPES,
  BOOKING_ROUTE,
  bookingPath,
  parseBooking,
  parseBookingRequest,
} from './bookings.js';

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
  });
});

describe('the event vocabulary', () => {
  it('names only what can happen today', () => {
    // Two members, deliberately: 4.5a can create a request and nothing else.
    // Adding 4.6's names now would put unreachable values in a vocabulary every
    // consumer must handle.
    expect(BOOKING_EVENT_TYPES).toEqual(['requested', 'state-changed']);
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
