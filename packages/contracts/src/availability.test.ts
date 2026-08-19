import { describe, expect, it } from 'vitest';
import {
  ContractViolationError,
  LISTING_AVAILABILITY_BLOCK_ROUTE,
  LISTING_AVAILABILITY_ROUTE,
  MAX_BLOCK_REASON_LENGTH,
  firstDayOf,
  listingAvailabilityBlockPath,
  listingAvailabilityPath,
  monthOf,
  parseAvailabilityBlock,
  parseAvailabilityBlockRequest,
  parseListingAvailability,
} from './index.js';

const A_BLOCK = { startDate: '2026-08-20', endDate: '2026-08-22', reason: 'Away' };

describe('paths', () => {
  it('nests the calendar under its listing', () => {
    expect(listingAvailabilityPath('abc')).toBe('/listings/abc/availability');
    expect(listingAvailabilityBlockPath('abc', 'def')).toBe(
      '/listings/abc/availability/def',
    );
  });

  it('encodes ids rather than interpolating them', () => {
    // An id arrives from a URL and goes back into one. `../` in the middle of a
    // path is how a delete gets aimed somewhere it was never meant to reach.
    expect(listingAvailabilityBlockPath('a/b', '../x')).toBe(
      '/listings/a%2Fb/availability/..%2Fx',
    );
  });

  it('matches the route templates the controller registers', () => {
    // The pair that is easy to let drift: a path builder the web app calls and a
    // route template Nest registers, spelled in two places.
    expect(listingAvailabilityPath('abc')).toBe(
      LISTING_AVAILABILITY_ROUTE.replace(':id', 'abc'),
    );
    expect(listingAvailabilityBlockPath('abc', 'def')).toBe(
      LISTING_AVAILABILITY_BLOCK_ROUTE.replace(':id', 'abc').replace(':blockId', 'def'),
    );
  });
});

describe('parseAvailabilityBlockRequest', () => {
  it('accepts a period and keeps the note', () => {
    expect(parseAvailabilityBlockRequest(A_BLOCK)).toEqual({
      startDate: '2026-08-20',
      endDate: '2026-08-22',
      reason: 'Away',
    });
  });

  it('accepts a single day', () => {
    const parsed = parseAvailabilityBlockRequest({
      startDate: '2026-08-20',
      endDate: '2026-08-20',
    });
    expect(parsed.endDate).toBe(parsed.startDate);
  });

  it('refuses a period that ends before it starts', () => {
    expect(() =>
      parseAvailabilityBlockRequest({ startDate: '2026-08-22', endDate: '2026-08-20' }),
    ).toThrow(ContractViolationError);
  });

  it('refuses a date that is not one', () => {
    for (const startDate of [
      '2026-02-30',
      '2026-8-1',
      '20 August 2026',
      '2026-08',
      '',
    ]) {
      expect(() =>
        parseAvailabilityBlockRequest({ startDate, endDate: '2026-08-22' }),
      ).toThrow(ContractViolationError);
    }
  });

  it('names the field that was wrong', () => {
    // "The period to block did not match" is not actionable; the field is.
    try {
      parseAvailabilityBlockRequest({ startDate: '2026-08-22', endDate: '2026-08-20' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractViolationError);
      expect((error as ContractViolationError).issues.join()).toContain('endDate');
    }
  });

  it('treats an absent, empty or blank note as no note', () => {
    for (const reason of [undefined, null, '', '   ']) {
      expect(parseAvailabilityBlockRequest({ ...A_BLOCK, reason }).reason).toBeNull();
    }
  });

  it('trims a note and refuses one that is too long', () => {
    expect(
      parseAvailabilityBlockRequest({ ...A_BLOCK, reason: '  MOT  ' }).reason,
    ).toBe('MOT');
    expect(() =>
      parseAvailabilityBlockRequest({
        ...A_BLOCK,
        reason: 'x'.repeat(MAX_BLOCK_REASON_LENGTH + 1),
      }),
    ).toThrow(ContractViolationError);
  });

  it('refuses control and direction-changing characters in a note', () => {
    // The same guard every other free-text field carries. This one is read back
    // only by its author, which is a reason to keep the check rather than to
    // drop it: nothing downstream would notice.
    expect(() =>
      parseAvailabilityBlockRequest({ ...A_BLOCK, reason: 'Away‮txt' }),
    ).toThrow(ContractViolationError);
  });
});

describe('parseListingAvailability', () => {
  it('accepts a month and its blocks', () => {
    const parsed = parseListingAvailability({
      month: '2026-08',
      blocks: [
        { id: 'b1', startDate: '2026-07-28', endDate: '2026-08-03', reason: null },
      ],
      bookings: [],
    });
    expect(parsed.blocks).toHaveLength(1);
    // A block starting in July on August's page: what "touches the month" means.
    expect(parsed.blocks[0]?.startDate).toBe('2026-07-28');
  });

  it('accepts a month with nothing in it', () => {
    expect(
      parseListingAvailability({ month: '2026-08', blocks: [], bookings: [] }).blocks,
    ).toEqual([]);
  });

  it('refuses a month that is a date', () => {
    expect(() => parseListingAvailability({ month: '2026-08-20', blocks: [] })).toThrow(
      ContractViolationError,
    );
  });

  it('refuses an instant anywhere in a block', () => {
    /*
     * **The check this file exists for.** `strictObject` is what fails the day
     * somebody adds `startAt` to the projection — which would reach a page that
     * renders it in the browser's timezone, drawing a Bristol owner's calendar a
     * day out for anybody reading it from further east.
     */
    expect(() =>
      parseListingAvailability({
        month: '2026-08',
        blocks: [
          {
            id: 'b1',
            startDate: '2026-08-20',
            endDate: '2026-08-22',
            reason: null,
            startAt: '2026-08-19T23:00:00.000Z',
          },
        ],
      }),
    ).toThrow(ContractViolationError);
  });

  it('refuses a block with no id', () => {
    // The id is what the remove control aims at. An empty one renders a button
    // that deletes nothing and reports success.
    expect(() =>
      parseAvailabilityBlock({
        id: '',
        startDate: '2026-08-20',
        endDate: '2026-08-22',
        reason: null,
      }),
    ).toThrow(ContractViolationError);
  });
});

describe('month helpers', () => {
  it('reads the month off a date and the first day off a month', () => {
    expect(monthOf('2026-08-20')).toBe('2026-08');
    expect(firstDayOf('2026-08')).toBe('2026-08-01');
    expect(monthOf(firstDayOf('2026-12'))).toBe('2026-12');
  });
});

describe('the booked layer (slice 4.8c)', () => {
  const A_MONTH = {
    month: '2026-08',
    blocks: [],
    bookings: [{ id: 'booking-1', startDate: '2026-08-10', endDate: '2026-08-12' }],
  };

  it('accepts the projection the API sends', () => {
    expect(() => parseListingAvailability(A_MONTH)).not.toThrow();
  });

  it('requires the layer to be present, even when it is empty', () => {
    /*
     * **Required rather than optional**, so a server that stopped sending it
     * fails here instead of drawing every booked day as free — which is exactly
     * what the page did between 4.6a and this slice.
     */
    expect(() => parseListingAvailability({ month: '2026-08', blocks: [] })).toThrow();
  });

  it('carries no renter and no money', () => {
    // §8.4.1: identity arrives with commitment. A grid of shaded squares must
    // not disclose more than the request itself does.
    const parsed = parseListingAvailability(A_MONTH);

    expect(parsed.bookings[0]).not.toHaveProperty('renterId');
    expect(parsed.bookings[0]).not.toHaveProperty('total');
    expect(parsed.bookings[0]).not.toHaveProperty('itemCharge');
  });

  it('refuses a renter smuggled onto a period', () => {
    // `strictObject`. The failure is loud rather than a field quietly rendered.
    expect(() =>
      parseListingAvailability({
        ...A_MONTH,
        bookings: [{ ...A_MONTH.bookings[0], renterId: 'user-1' }],
      }),
    ).toThrow();
  });

  it('refuses an instant where a date belongs', () => {
    expect(() =>
      parseListingAvailability({
        ...A_MONTH,
        bookings: [{ ...A_MONTH.bookings[0], startDate: '2026-08-10T23:00:00Z' }],
      }),
    ).toThrow();
  });
});
