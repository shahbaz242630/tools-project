/**
 * Time primitive.
 *
 * BRD §6.1: timestamps are stored in UTC. Rental-period calculation and all
 * user-facing rendering use the booking's IANA timezone — `Europe/London` at
 * launch. Daily rates, due times and late fees must stay correct across
 * British Summer Time transitions.
 *
 * The rule that makes that work: rental duration is counted in **local
 * calendar days**, never in elapsed milliseconds. A spring-forward day is 23
 * hours long and an autumn day is 25; billing either as a fraction of a day
 * would over- or under-charge twice a year.
 */

import { DateTime } from 'luxon';

/** Default booking timezone. Stored per booking so it can vary later. */
export const PLATFORM_TIMEZONE = 'Europe/London';

export class TimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeError';
  }
}

function toDateTime(instant: Date, timeZone: string): DateTime {
  if (Number.isNaN(instant.getTime())) {
    throw new TimeError('Received an invalid Date');
  }
  const dt = DateTime.fromJSDate(instant, { zone: timeZone });
  if (!dt.isValid) {
    throw new TimeError(`Invalid timezone or instant: ${dt.invalidReason}`);
  }
  return dt;
}

/** Current instant. Always UTC — the only clock the system reads. */
export function nowUtc(): Date {
  return new Date();
}

/** ISO 8601 string in UTC, for storage and logging. */
export function toIsoUtc(instant: Date): string {
  const iso = toDateTime(instant, 'utc').toISO();
  /* c8 ignore next */
  if (iso === null) throw new TimeError('Could not serialise instant');
  return iso;
}

/**
 * Rental duration in local calendar days.
 *
 * Counted as the difference between the local calendar date of collection and
 * the local calendar date of return, matching how equipment hire is priced —
 * collect on the 27th, return on the 3rd is 7 days. Same-day returns count as
 * one day, so a rental is never billed as zero.
 */
export function rentalDayCount(
  start: Date,
  end: Date,
  timeZone: string = PLATFORM_TIMEZONE,
): number {
  const startLocal = toDateTime(start, timeZone).startOf('day');
  const endLocal = toDateTime(end, timeZone).startOf('day');

  if (endLocal < startLocal) {
    throw new TimeError('Rental end date cannot fall before the start date');
  }

  const days = endLocal.diff(startLocal, 'days').days;
  return Math.max(1, Math.round(days));
}

/**
 * Add whole rental days to a start instant, preserving local wall-clock time.
 *
 * Preserving wall clock is deliberate: a rental collected at 09:00 is due back
 * at 09:00, whether or not the clocks changed in between. Adding 24-hour
 * blocks would shift the due time by an hour twice a year.
 */
export function addRentalDays(
  start: Date,
  days: number,
  timeZone: string = PLATFORM_TIMEZONE,
): Date {
  if (!Number.isInteger(days)) {
    throw new TimeError(`Rental days must be a whole number, received ${days}`);
  }
  return toDateTime(start, timeZone).plus({ days }).toJSDate();
}

/** True when the local day containing `instant` is not 24 hours long. */
export function isDstTransitionDay(
  instant: Date,
  timeZone: string = PLATFORM_TIMEZONE,
): boolean {
  const dayStart = toDateTime(instant, timeZone).startOf('day');
  const nextDayStart = dayStart.plus({ days: 1 });
  return nextDayStart.diff(dayStart, 'hours').hours !== 24;
}

/** Local calendar date as `YYYY-MM-DD`. Used for grouping and display. */
export function toLocalDateString(
  instant: Date,
  timeZone: string = PLATFORM_TIMEZONE,
): string {
  const date = toDateTime(instant, timeZone).toISODate();
  /* c8 ignore next */
  if (date === null) throw new TimeError('Could not derive local date');
  return date;
}

/** Human-readable local rendering, e.g. "27 Jul 2026, 09:00". */
export function formatLocal(
  instant: Date,
  timeZone: string = PLATFORM_TIMEZONE,
  locale = 'en-GB',
): string {
  return toDateTime(instant, timeZone).setLocale(locale).toFormat('d LLL yyyy, HH:mm');
}

/** True when `instant` falls inside [start, end). Half-open by design. */
export function isWithin(instant: Date, start: Date, end: Date): boolean {
  const t = instant.getTime();
  return t >= start.getTime() && t < end.getTime();
}
