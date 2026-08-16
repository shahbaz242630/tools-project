/**
 * What the calendar will accept (slice 4.3b).
 *
 * **None of these is in the BRD, and that is stated rather than implied.** §8.5
 * asks for a calendar of unavailable periods and says nothing about how far
 * ahead or how long. These are guardrails on a form — the same kind of judgement
 * `catalogue/limits.ts` records — and each exists because of a specific way a
 * date field goes wrong, not because a rule somewhere demanded a number.
 *
 * **They are constants rather than configuration**, and the invariant about
 * hard-coding is worth answering rather than skirting: configuration is what
 * *might change without a deploy*, and these are the bounds of a text input
 * nobody has ever asked to tune. If an owner ever meets one for a real reason,
 * the answer is to change the number here in a slice that says why — not to put
 * a form in front of an administrator for it.
 *
 * **All three are enforced in the service, not in the schema**, because two of
 * them need to know what today is. A zod schema that reads the clock is one
 * whose tests pass or fail depending on when they are run.
 */

/**
 * How long a single declared period may be.
 *
 * A year and a day, so that "the whole of next year" is expressible and a
 * mis-keyed year is not. The failure this catches is `2027-08-20` typed as
 * `2207-08-20`: it is not obviously wrong on screen, it blocks a listing for
 * two centuries, and nothing else in the system would ever mention it again.
 *
 * **Longer than §8.5.3's 88-day rental cap, deliberately.** That cap is about a
 * hire the Consumer Credit Act would regulate; this is an owner saying their
 * mower is in the shed for the winter. Reusing the number would tie an
 * unrelated legal limit to a diary entry, and the day counsel moves one the
 * other would move with it for no reason.
 */
export const MAX_BLOCK_DAYS = 366;

/**
 * How far ahead a period may start.
 *
 * Two years. Beyond that a declaration is not about an item somebody is
 * currently renting out, and the same typo the length bound catches can arrive
 * as a short block in 2207 — which that bound would let through.
 */
export const MAX_BLOCK_HORIZON_DAYS = 730;
