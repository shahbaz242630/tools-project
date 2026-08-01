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

/**
 * Parse an ISO 8601 string into an instant.
 *
 * The inverse of `toIsoUtc`, and the reason it exists here rather than as a
 * `new Date(...)` at each call site: `new Date('2026-07-15')` is read as UTC
 * while `new Date('2026-07-15T09:00')` is read as *local* time, so two strings
 * that look equally explicit resolve differently depending on where the process
 * runs. Luxon rejects the ambiguity instead of guessing.
 *
 * Throws rather than returning an Invalid Date, which propagates silently and
 * surfaces as `NaN` somewhere unrelated.
 */
export function fromIsoUtc(iso: string): Date {
  const parsed = DateTime.fromISO(iso, { zone: 'utc' });
  if (!parsed.isValid) {
    throw new TimeError(`Not a valid ISO 8601 instant: ${iso}`);
  }
  return parsed.toJSDate();
}

/**
 * Add elapsed hours to an instant.
 *
 * **Deliberately not calendar arithmetic**, and that is the whole distinction
 * from `addRentalDays`. A rental day is a local calendar day, so it is 23 or 25
 * hours long across a BST transition (ADR 0003). This is the opposite: a
 * deadline measured in elapsed time, where the answer must not depend on the
 * clocks having changed. An administrator given 24 hours to approve something
 * gets 24 hours in March as in June.
 *
 * Use it for windows, timeouts and expiries. Never for a rental period.
 */
export function addHours(instant: Date, hours: number): Date {
  return toDateTime(instant, 'utc').plus({ hours }).toJSDate();
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
