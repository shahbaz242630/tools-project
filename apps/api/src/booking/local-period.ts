import { Time } from '@platform/core';

/**
 * The one place a pair of calendar dates becomes a pair of instants (slice
 * 4.3b, extracted in 4.4b).
 *
 * **Slice 4.3b settled that this conversion happens once, on the server, in the
 * platform's timezone.** It lived inside `AvailabilityService.block` while that
 * was the only caller. The quote engine is the second caller and the date filter
 * in 4.9 will be the third, so it moves here — because "once" has to mean one
 * function, not three functions that agree by eye. Two conversions is how a
 * calendar and a booking path come to disagree about which day a period ends,
 * and the disagreement is invisible for seven months of the year, because in
 * winter the platform's timezone and UTC are the same thing.
 *
 * **`endDate` is inclusive and the returned `endAt` is not.** "The 20th to the
 * 22nd" is three days ending at the start of the 23rd, which is what makes a
 * hire able to follow a block with no gap, and what `overlaps()` in
 * `prisma-availability-store.ts` and the `period` trigger both compare.
 *
 * **`new Date('2026-08-20')` is midnight UTC and is the bug** this function
 * exists to make unnecessary — an hour adrift from midnight in London for seven
 * months of the year, and only for some readers.
 */

export interface LocalPeriod {
  /** The first moment of the first day, in the platform's timezone. */
  readonly startAt: Date;
  /** The first moment of the day *after* the last day. Exclusive. */
  readonly endAt: Date;
}

export function periodFromLocalDates(
  startDate: string,
  endDateInclusive: string,
): LocalPeriod {
  return {
    startAt: Time.startOfLocalDay(startDate),
    endAt: Time.startOfLocalDay(Time.addLocalDays(endDateInclusive, 1)),
  };
}
