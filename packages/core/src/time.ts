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
 * Parse Unix milliseconds into an instant.
 *
 * Exists because providers speak epochs where our own contracts speak ISO 8601:
 * Clerk timestamps every session field this way, so without this each caller
 * would reach for `new Date(ms)` — which the lint rule bans, correctly, since
 * that is also how `new Date(seconds)` slips in and lands a timestamp in 1970.
 *
 * **Rejects a value that is not a finite integer**, including `NaN`, which is
 * what `Number(undefined)` produces when a field a provider promised is absent.
 * The alternative is an Invalid Date that propagates silently and surfaces as
 * `NaN` somewhere unrelated — the same failure `fromIsoUtc` throws to prevent.
 *
 * Seconds are not accepted and cannot be detected reliably: 1_700_000_000 is a
 * plausible epoch in either unit, twenty-four thousand years apart. Callers
 * convert, and say which unit they were handed where they do it.
 */
export function fromEpochMs(milliseconds: number): Date {
  if (!Number.isFinite(milliseconds) || !Number.isInteger(milliseconds)) {
    throw new TimeError(`Not a valid epoch in milliseconds: ${milliseconds}`);
  }

  const parsed = DateTime.fromMillis(milliseconds, { zone: 'utc' });
  if (!parsed.isValid) {
    throw new TimeError(`Not a valid epoch in milliseconds: ${milliseconds}`);
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

/**
 * The instant a local calendar date begins (slice 4.3b).
 *
 * **The inverse of `toLocalDateString`, and the direction that had been
 * missing.** Everything above turns an instant into a date; nothing turned a
 * date a person chose into an instant, so every caller wanting one would have
 * reached for `new Date('2026-08-20')` — which `fromIsoUtc` exists to prevent,
 * and which is wrong here in a second way: it is midnight *UTC*, an hour adrift
 * from midnight in London for seven months of the year.
 *
 * **Why this is a primitive rather than three lines in the booking module.** A
 * date is what an owner picks and an instant is what the database stores, so
 * the conversion sits on the boundary every date-shaped feature in Phase 4
 * crosses — availability now, quotes and rental periods next. Written once, it
 * is one thing to get right across a BST transition; written per module it is
 * one thing to get wrong per module.
 *
 * **Strict about the format on purpose.** `DateTime.fromISO` accepts `2026-08`
 * and reads it as the first of the month, so a truncated value would silently
 * become a real date three weeks from the one intended. `fromFormat` refuses
 * that, and refuses `2026-02-30` with it.
 */
export function startOfLocalDay(
  date: string,
  timeZone: string = PLATFORM_TIMEZONE,
): Date {
  const parsed = DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: timeZone });
  if (!parsed.isValid) {
    throw new TimeError(`Not a valid calendar date: ${date}`);
  }
  // `startOf('day')` rather than trusting the parse, because on a day the clocks
  // go forward in a zone that skips midnight itself, 00:00 does not exist and
  // luxon resolves it forwards. Asking for the start of the day is the question
  // we actually mean, and it has an answer on every day in every zone.
  return parsed.startOf('day').toJSDate();
}

/**
 * Whole calendar days added to a local date, as a local date (slice 4.3b).
 *
 * **Civil arithmetic on a date, not on an instant** — no timezone is taken and
 * none is needed, because *"the day after the 20th"* is the 21st everywhere.
 * That is the distinction from `addRentalDays`, which moves an instant and
 * preserves its wall-clock time. Use this where the answer is a date on a
 * calendar; use that where the answer is a moment somebody has to be somewhere.
 *
 * The half-open period a block occupies is the first caller: an owner who says
 * *"the 20th to the 22nd"* means three days, which ends at the start of the
 * 23rd.
 */
export function addLocalDays(date: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new TimeError(`Days must be a whole number, received ${days}`);
  }
  return shiftLocalDate(date, { days });
}

/**
 * Whole calendar months added to a local date, as a local date (slice 4.3b).
 *
 * For moving between months on a calendar — *"the month before this one"* — and
 * deliberately not for anything with a deadline in it. Luxon clamps a day that
 * the target month does not have, so 31 January plus one month is 28 February;
 * every caller here works from the first of a month, where there is nothing to
 * clamp.
 */
export function addLocalMonths(date: string, months: number): string {
  if (!Number.isInteger(months)) {
    throw new TimeError(`Months must be a whole number, received ${months}`);
  }
  return shiftLocalDate(date, { months });
}

/**
 * Which day of the week a local date falls on — 1 is Monday, 7 is Sunday
 * (slice 4.3b).
 *
 * **A civil fact about a date, so no timezone is taken.** 20 August 2026 is a
 * Thursday everywhere. The alternative a calendar component would otherwise
 * reach for is `new Date(date).getDay()`, which is wrong twice over: it reads
 * the string as midnight UTC and then reports the weekday in whatever zone the
 * machine rendering the page is in — so a date near either end of the month can
 * come out a day adrift, and it would do so only for readers in some timezones.
 *
 * **Monday-first, as ISO 8601 has it**, which is also how a British calendar is
 * drawn. It is the numbering a grid offset is computed from, so getting the
 * convention from the standard rather than from JavaScript's Sunday-first
 * `getDay` is what stops the first week being shifted by one.
 */
export function weekdayOf(date: string): number {
  const parsed = DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: 'utc' });
  if (!parsed.isValid) {
    throw new TimeError(`Not a valid calendar date: ${date}`);
  }
  return parsed.weekday;
}

/** One parse, one format, shared by the two shifts above. */
function shiftLocalDate(date: string, by: { days?: number; months?: number }): string {
  const parsed = DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: 'utc' });
  if (!parsed.isValid) {
    throw new TimeError(`Not a valid calendar date: ${date}`);
  }
  const shifted = parsed.plus(by).toISODate();
  /* c8 ignore next */
  if (shifted === null) throw new TimeError('Could not derive local date');
  return shifted;
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

/**
 * A local calendar date as a person reads it, e.g. "20 Aug 2026" (slice 4.3b).
 *
 * **Takes the date string, not an instant**, which is what separates it from
 * `formatLocal` above. That one renders a moment — a due time, a saved-at
 * stamp — and must say which day it was in the platform's timezone. This
 * renders a day that was never a moment: an owner's block runs from a date to a
 * date, and turning it into an instant to print it would be inventing a time of
 * day in order to throw it away.
 *
 * Here rather than in a component so that one function formats a date across
 * the whole product. A component doing it with an array of month names is how
 * two surfaces come to spell August differently.
 */
export function formatLocalDate(date: string, locale = 'en-GB'): string {
  const parsed = DateTime.fromFormat(date, 'yyyy-MM-dd', { zone: 'utc' });
  if (!parsed.isValid) {
    throw new TimeError(`Not a valid calendar date: ${date}`);
  }
  return parsed.setLocale(locale).toFormat('d LLL yyyy');
}

/**
 * A month as a person reads it, e.g. "August 2026" (slice 4.3b).
 *
 * The heading of a calendar. Spelled in full where a date is abbreviated,
 * because it appears once at the top rather than in a list.
 */
export function formatLocalMonth(month: string, locale = 'en-GB'): string {
  const parsed = DateTime.fromFormat(`${month}-01`, 'yyyy-MM-dd', { zone: 'utc' });
  if (!parsed.isValid) {
    throw new TimeError(`Not a valid month: ${month}`);
  }
  return parsed.setLocale(locale).toFormat('LLLL yyyy');
}

/** True when `instant` falls inside [start, end). Half-open by design. */
export function isWithin(instant: Date, start: Date, end: Date): boolean {
  const t = instant.getTime();
  return t >= start.getTime() && t < end.getTime();
}
