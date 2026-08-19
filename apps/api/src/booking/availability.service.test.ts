import { Time } from '@platform/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { AvailabilityService, BlockRefusedError } from './availability.service.js';
import { MAX_BLOCK_DAYS, MAX_BLOCK_HORIZON_DAYS } from './limits.js';
import {
  InMemoryAvailabilityStore,
  InMemoryBookingStore,
  InMemoryListingOwnership,
} from './testing/fakes.js';

/**
 * The owner's calendar (slice 4.3b).
 *
 * **Most of this file is about one conversion**: an owner says "the 20th to the
 * 22nd" and the database stores `[20 Aug 00:00 London, 23 Aug 00:00 London)`.
 * Everything that can go wrong with a calendar goes wrong there — a day short at
 * one end, an hour out for seven months of the year, or a period that changes
 * length when the clocks do.
 */

const ADA = 'user-ada';
const BOB = 'user-bob';
const MOWER = 'listing-mower';

/**
 * A fixed clock, so "in the past" and "too far ahead" are provable.
 *
 * Early enough that every period below is in the future unless it is meant not
 * to be — a fixture that trips one of the service's own refusals fails in a way
 * that looks like a defect in the rule rather than in the arrangement.
 */
const TODAY = '2026-07-01';
const now = (): Date => Time.startOfLocalDay(TODAY);

let blocks: InMemoryAvailabilityStore;
let bookings: InMemoryBookingStore;
let ownership: InMemoryListingOwnership;
let availability: AvailabilityService;

beforeEach(() => {
  bookings = new InMemoryBookingStore();
  blocks = new InMemoryAvailabilityStore(bookings);
  ownership = new InMemoryListingOwnership().give(MOWER, ADA);
  availability = new AvailabilityService(blocks, ownership, now);
});

describe('block', () => {
  it('stores the period a person meant, in local midnights', async () => {
    const created = await availability.block(MOWER, ADA, {
      startDate: '2026-08-20',
      endDate: '2026-08-22',
      reason: 'Away',
    });

    expect(created).not.toBeNull();

    /*
     * **The half-open pair, read off the store rather than off the response.**
     * The response speaks dates and would agree with itself whatever was
     * written; this is the only assertion in the file that sees what actually
     * lands in the column the overlap arithmetic reads.
     *
     * 23:00Z on the 19th is midnight in London during BST. Midnight UTC — what
     * `new Date('2026-08-20')` produces — would be an hour late and would put
     * the first hour of the 20th outside the block.
     */
    const stored = await blocks.listBlocks(
      MOWER,
      Time.startOfLocalDay('2026-01-01'),
      Time.startOfLocalDay('2027-01-01'),
    );
    expect(stored).toHaveLength(1);
    expect(Time.toIsoUtc(stored[0]!.startAt)).toBe('2026-08-19T23:00:00.000Z');
    expect(Time.toIsoUtc(stored[0]!.endAt)).toBe('2026-08-22T23:00:00.000Z');
  });

  it('reads back the same inclusive dates it was given', async () => {
    const created = await availability.block(MOWER, ADA, {
      startDate: '2026-08-20',
      endDate: '2026-08-22',
      reason: null,
    });

    expect(created?.startDate).toBe('2026-08-20');
    // The 22nd, not the 23rd. An owner who is told their block ends a day later
    // than they typed does not trust the calendar again.
    expect(created?.endDate).toBe('2026-08-22');
  });

  it('blocks a single day', async () => {
    const created = await availability.block(MOWER, ADA, {
      startDate: '2026-08-20',
      endDate: '2026-08-20',
      reason: null,
    });

    expect(created?.startDate).toBe('2026-08-20');
    expect(created?.endDate).toBe('2026-08-20');
    // One day occupied, not zero: an empty range would sit in the table looking
    // like it blocked something while overlapping nothing.
    expect(await blocks.reasonUnavailable(MOWER, ...dayOf('2026-08-20'))).toBe(
      'blocked',
    );
    expect(await blocks.reasonUnavailable(MOWER, ...dayOf('2026-08-21'))).toBeNull();
  });

  it('does not occupy the day after the last one', async () => {
    // The `[)` bound, from the outside: a renter collecting on the 23rd does not
    // clash with a block that ends on the 22nd. Back-to-back is the commonest
    // shape in hire, so getting this wrong loses a day of every rental.
    await availability.block(MOWER, ADA, {
      startDate: '2026-08-20',
      endDate: '2026-08-22',
      reason: null,
    });

    expect(await blocks.reasonUnavailable(MOWER, ...dayOf('2026-08-22'))).toBe(
      'blocked',
    );
    expect(await blocks.reasonUnavailable(MOWER, ...dayOf('2026-08-23'))).toBeNull();
  });

  it('keeps a period the same number of days across a clock change', async () => {
    /*
     * **The 25-hour day.** 24, 25 and 26 October is three days on a calendar and
     * 73 hours on a clock. Anything computing the period as `days * 24h` would
     * end this block an hour early — during the last hour of the 26th, which is
     * exactly when somebody would be collecting.
     */
    await availability.block(MOWER, ADA, {
      startDate: '2026-10-24',
      endDate: '2026-10-26',
      reason: null,
    });

    const [stored] = await blocks.listBlocks(
      MOWER,
      Time.startOfLocalDay('2026-10-01'),
      Time.startOfLocalDay('2026-11-01'),
    );
    const hours = (stored!.endAt.getTime() - stored!.startAt.getTime()) / 3_600_000;

    expect(hours).toBe(73);
    expect(await blocks.reasonUnavailable(MOWER, ...dayOf('2026-10-26'))).toBe(
      'blocked',
    );
    expect(await blocks.reasonUnavailable(MOWER, ...dayOf('2026-10-27'))).toBeNull();
  });

  it('keeps the note, and keeps its absence', async () => {
    const noted = await availability.block(MOWER, ADA, {
      startDate: '2026-08-20',
      endDate: '2026-08-20',
      reason: 'MOT',
    });
    const bare = await availability.block(MOWER, ADA, {
      startDate: '2026-09-20',
      endDate: '2026-09-20',
      reason: null,
    });

    expect(noted?.reason).toBe('MOT');
    expect(bare?.reason).toBeNull();
  });

  it('accepts overlapping periods rather than arguing about them', async () => {
    // An owner who blocks a fortnight and then a week inside it has said the
    // same thing twice. Refusing the second would be a form error about nothing.
    await availability.block(MOWER, ADA, {
      startDate: '2026-08-20',
      endDate: '2026-09-02',
      reason: 'Away',
    });
    const second = await availability.block(MOWER, ADA, {
      startDate: '2026-08-24',
      endDate: '2026-08-26',
      reason: 'Still away',
    });

    expect(second).not.toBeNull();
  });

  it('accepts a period that started in the past and has not finished', async () => {
    // Realising on Wednesday that the mower has been away since Monday is the
    // right thing to do, not an error.
    const created = await availability.block(MOWER, ADA, {
      startDate: '2026-06-25',
      endDate: '2026-07-03',
      reason: null,
    });

    expect(created).not.toBeNull();
  });

  it('accepts a period that ends today', async () => {
    // The boundary of the "already finished" refusal, which is off by one in the
    // unfriendly direction if written as `<=`.
    const created = await availability.block(MOWER, ADA, {
      startDate: TODAY,
      endDate: TODAY,
      reason: null,
    });

    expect(created).not.toBeNull();
  });

  it('refuses a period that has already finished', async () => {
    await expect(
      availability.block(MOWER, ADA, {
        startDate: '2026-06-01',
        endDate: '2026-06-15',
        reason: null,
      }),
    ).rejects.toThrow(BlockRefusedError);
  });

  it('refuses a period that ended yesterday', async () => {
    // The other side of the boundary from "ends today", which is accepted.
    await expect(
      availability.block(MOWER, ADA, {
        startDate: Time.addLocalDays(TODAY, -3),
        endDate: Time.addLocalDays(TODAY, -1),
        reason: null,
      }),
    ).rejects.toThrow(BlockRefusedError);
  });

  it('refuses a start beyond the two-year horizon, and accepts one on it', async () => {
    const edge = Time.addLocalDays(TODAY, MAX_BLOCK_HORIZON_DAYS);
    const beyond = Time.addLocalDays(TODAY, MAX_BLOCK_HORIZON_DAYS + 1);

    await expect(
      availability.block(MOWER, ADA, { startDate: edge, endDate: edge, reason: null }),
    ).resolves.not.toBeNull();

    await expect(
      availability.block(MOWER, ADA, {
        startDate: beyond,
        endDate: beyond,
        reason: null,
      }),
    ).rejects.toThrow(BlockRefusedError);
  });

  it('refuses a period longer than the maximum, and accepts one exactly at it', async () => {
    // What the horizon check alone would let through: `2207-08-20` typed for
    // `2027-08-20` is caught by the horizon, but a mis-keyed *end* year inside
    // it is caught only here.
    const start = '2026-09-01';
    const exact = Time.addLocalDays(start, MAX_BLOCK_DAYS - 1);
    const tooLong = Time.addLocalDays(start, MAX_BLOCK_DAYS);

    await expect(
      availability.block(MOWER, ADA, {
        startDate: start,
        endDate: exact,
        reason: null,
      }),
    ).resolves.not.toBeNull();

    await expect(
      availability.block(MOWER, ADA, {
        startDate: start,
        endDate: tooLong,
        reason: null,
      }),
    ).rejects.toThrow(BlockRefusedError);
  });

  it('says what is wrong in words, not in a code', async () => {
    // The controller renders `refusal` verbatim, so this sentence is what an
    // owner reads. A test on the class alone would let it become "invalid".
    await expect(
      availability.block(MOWER, ADA, {
        startDate: '2026-06-01',
        endDate: '2026-06-15',
        reason: null,
      }),
    ).rejects.toThrow(/already finished/);
  });

  it('refuses somebody else’s listing without storing anything', async () => {
    const created = await availability.block(MOWER, BOB, {
      startDate: '2026-08-20',
      endDate: '2026-08-22',
      reason: null,
    });

    expect(created).toBeNull();
    // Null is not enough on its own: a service that wrote first and checked
    // afterwards would return null here and still have blocked Ada's mower.
    expect(
      await blocks.listBlocks(
        MOWER,
        Time.startOfLocalDay('2026-01-01'),
        Time.startOfLocalDay('2027-01-01'),
      ),
    ).toHaveLength(0);
  });

  it('refuses a listing that does not exist, the same way', async () => {
    // Indistinguishable from "not yours" by design — the route answers 404 to
    // both, so a stranger cannot learn that a listing exists.
    expect(
      await availability.block('listing-nobody', ADA, {
        startDate: '2026-08-20',
        endDate: '2026-08-22',
        reason: null,
      }),
    ).toBeNull();
  });
});

describe('readMonth', () => {
  beforeEach(async () => {
    await availability.block(MOWER, ADA, {
      startDate: '2026-07-28',
      endDate: '2026-08-03',
      reason: 'Away',
    });
    await availability.block(MOWER, ADA, {
      startDate: '2026-08-20',
      endDate: '2026-08-22',
      reason: null,
    });
    await availability.block(MOWER, ADA, {
      startDate: '2026-09-05',
      endDate: '2026-09-06',
      reason: null,
    });
  });

  it('returns the blocks that touch the month, with their real dates', async () => {
    const august = await availability.readMonth(MOWER, ADA, '2026-08');

    expect(august?.month).toBe('2026-08');
    expect(august?.blocks.map((block) => block.startDate)).toEqual([
      // The July block is part of what August looks like. A calendar drawing
      // only contained periods would show the 1st to the 3rd as free while the
      // request path refused them.
      '2026-07-28',
      '2026-08-20',
    ]);
    expect(august?.blocks[0]?.endDate).toBe('2026-08-03');
  });

  it('does not reach into the month after', async () => {
    const august = await availability.readMonth(MOWER, ADA, '2026-08');
    expect(august?.blocks.map((block) => block.startDate)).not.toContain('2026-09-05');
  });

  it('puts a block starting on the 1st in exactly one month', async () => {
    // The boundary the half-open window exists for: midnight on the 1st belongs
    // to the new month, not to both and not to neither.
    await availability.block(MOWER, ADA, {
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      reason: null,
    });

    const september = await availability.readMonth(MOWER, ADA, '2026-09');
    const october = await availability.readMonth(MOWER, ADA, '2026-10');

    expect(september?.blocks.map((block) => block.startDate)).not.toContain(
      '2026-10-01',
    );
    expect(october?.blocks.map((block) => block.startDate)).toContain('2026-10-01');
  });

  it('crosses a year end', async () => {
    await availability.block(MOWER, ADA, {
      startDate: '2026-12-30',
      endDate: '2027-01-02',
      reason: null,
    });

    expect(
      (await availability.readMonth(MOWER, ADA, '2027-01'))?.blocks.map(
        (b) => b.endDate,
      ),
    ).toEqual(['2027-01-02']);
  });

  it('defaults to the current month, in the platform’s timezone', async () => {
    // **Resolved here rather than by the controller**, which holds no clock —
    // and it was the controller's until an integration test found the default
    // could not be pinned to a date. The caller deciding what "now" means is the
    // mistake this whole file exists to prevent.
    const current = await availability.readMonth(MOWER, ADA);

    expect(current?.month).toBe('2026-07');
  });

  it('returns an empty month rather than nothing at all', async () => {
    // Empty is a real answer — the listing is free all month. Null means "not
    // yours", and a page that could not tell them apart would show a refusal.
    const quiet = await availability.readMonth(MOWER, ADA, '2026-11');

    // Both layers present and both empty, from 4.8c. A month with nothing in it
    // still answers all three of §8.5's concepts.
    expect(quiet).toEqual({ month: '2026-11', blocks: [], bookings: [] });
  });

  it('refuses somebody else’s calendar', async () => {
    expect(await availability.readMonth(MOWER, BOB, '2026-08')).toBeNull();
  });
});

describe('unblock', () => {
  let blockId: string;

  beforeEach(async () => {
    const created = await availability.block(MOWER, ADA, {
      startDate: '2026-08-20',
      endDate: '2026-08-22',
      reason: null,
    });
    blockId = created!.id;
  });

  it('removes the period and frees the dates', async () => {
    expect(await availability.unblock(MOWER, ADA, blockId)).toBe(true);
    expect(await blocks.reasonUnavailable(MOWER, ...dayOf('2026-08-21'))).toBeNull();
  });

  it('is false the second time rather than throwing', async () => {
    await availability.unblock(MOWER, ADA, blockId);
    expect(await availability.unblock(MOWER, ADA, blockId)).toBe(false);
  });

  it('refuses somebody else’s block and leaves it in place', async () => {
    /*
     * **The reason the ownership check is not redundant with the store's listing
     * scope.** That scope stops a block being deleted through the wrong
     * *listing*; this stops it being deleted by the wrong *person*, who needs
     * only the two ids — and both of them travel in URLs.
     */
    expect(await availability.unblock(MOWER, BOB, blockId)).toBe(false);
    expect(await blocks.reasonUnavailable(MOWER, ...dayOf('2026-08-21'))).toBe(
      'blocked',
    );
  });

  it('is false for a block id that belongs to another listing', async () => {
    ownership.give('listing-drill', ADA);
    expect(await availability.unblock('listing-drill', ADA, blockId)).toBe(false);
    expect(await blocks.reasonUnavailable(MOWER, ...dayOf('2026-08-21'))).toBe(
      'blocked',
    );
  });
});

/** The instants a single local day spans, for asking the store about it. */
function dayOf(date: string): [Date, Date] {
  return [Time.startOfLocalDay(date), Time.startOfLocalDay(Time.addLocalDays(date, 1))];
}

describe('the booked layer (BRD section 8.5, slice 4.8c)', () => {
  /*
   * §8.5 names three concepts — available, unavailable and booked — and 4.3b
   * delivered two. What this file pins is the rule that makes the third safe: a
   * request nobody has answered is **not** booked. §7.1 keeps `REQUESTED` out of
   * §8.5.1's nine calendar-occupying states on purpose, so a calendar that shaded
   * one would disagree with the request path about the same day.
   */

  /** A booking over a named period, put straight into the store. */
  function given(
    state: 'ACCEPTED' | 'REQUESTED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED',
    from: string,
    toExclusive: string,
  ) {
    bookings.holds(MOWER, {
      state,
      startAt: Time.startOfLocalDay(from),
      endAt: Time.startOfLocalDay(toExclusive),
    });
  }

  it('draws a booking that holds the calendar', async () => {
    given('ACCEPTED', '2026-08-10', '2026-08-13');

    const month = await availability.readMonth(MOWER, ADA, '2026-08');

    // The inclusive end, as a block's is: a hire to the 12th ends at the start
    // of the 13th, which is what lets another begin that day.
    expect(month?.bookings).toEqual([
      { id: 'booking-1', startDate: '2026-08-10', endDate: '2026-08-12' },
    ]);
  });

  it('does not draw a request nobody has answered', async () => {
    /*
     * **The rule this slice turns on.** §7.1 makes `REQUESTED` non-blocking so
     * several renters may ask for the same dates and the first acceptance takes
     * them. Shading one would tell an owner a day was gone while the request
     * path would still book it.
     */
    given('REQUESTED', '2026-08-10', '2026-08-13');

    const month = await availability.readMonth(MOWER, ADA, '2026-08');

    expect(month?.bookings).toEqual([]);
  });

  it('does not draw a booking that went away', async () => {
    // Declined, expired and cancelled are all outside the nine. Keeping them
    // would shade dates nobody holds.
    given('DECLINED', '2026-08-05', '2026-08-07');
    given('EXPIRED', '2026-08-10', '2026-08-13');
    given('CANCELLED', '2026-08-20', '2026-08-22');

    const month = await availability.readMonth(MOWER, ADA, '2026-08');

    expect(month?.bookings).toEqual([]);
  });

  it('draws a booking that began in the previous month', async () => {
    // `listBlocks`' rule applied to the second layer: a hire beginning on
    // 28 July is part of what August looks like, and a calendar drawing only
    // contained periods would show its first days free.
    given('ACCEPTED', '2026-07-28', '2026-08-03');

    const month = await availability.readMonth(MOWER, ADA, '2026-08');

    expect(month?.bookings[0]?.startDate).toBe('2026-07-28');
    expect(month?.bookings[0]?.endDate).toBe('2026-08-02');
  });

  it('reads an empty layer when nothing is booked', async () => {
    const month = await availability.readMonth(MOWER, ADA, '2026-08');

    expect(month?.bookings).toEqual([]);
  });

  it('says nothing at all about a listing that is not this owner’s', async () => {
    // The ownership check is unchanged and still runs first. The booked layer
    // must not become a way to read somebody else's calendar.
    given('ACCEPTED', '2026-08-10', '2026-08-13');

    expect(await availability.readMonth(MOWER, BOB, '2026-08')).toBe(null);
  });

  it('draws both layers at once without either swallowing the other', async () => {
    await availability.block(MOWER, ADA, {
      startDate: '2026-08-20',
      endDate: '2026-08-22',
      reason: null,
    });
    given('ACCEPTED', '2026-08-10', '2026-08-13');

    const month = await availability.readMonth(MOWER, ADA, '2026-08');

    expect(month?.blocks).toHaveLength(1);
    expect(month?.bookings).toHaveLength(1);
  });
});
