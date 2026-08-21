/**
 * Whether the worker is doing the thing it exists to do (slice H6).
 *
 * ## The gap this closes, which slice 4.7b left open and said so
 *
 * The container probe reads a file whose freshness proves a real Redis round trip.
 * That catches a wedged event loop, an unreachable broker and a crash loop — and it
 * does **not** catch the failure 4.7b introduced: `upsertJobScheduler` failing while
 * Redis is perfectly healthy. The worker then answers every round trip, refreshes the
 * file, reads healthy, and **never sweeps again**. §8.6's deadline quietly stops
 * meaning anything.
 *
 * So the signal becomes two questions rather than one: *did Redis answer*, and *is
 * our schedule registered*.
 *
 * ## Why this is a named function and not three lines in `main.ts`
 *
 * `main.ts` is the composition root, kept thin and **excluded from coverage** — so
 * anything with a rule in it is unreachable by a test while it lives there. This is
 * the shape `drain.ts` already established for exactly the same reason, and its
 * docblock makes the argument better than this one could: the rule gets a name and a
 * test, because inverting it is invisible.
 *
 * ## What it is deliberately not
 *
 * **Not a check that the sweep has *run* recently.** That would be the better
 * signal and it needs somewhere to remember the last run — a Redis key, or the
 * metric this slice adds — and it turns a liveness probe into a lag alarm. The
 * honest boundary for a probe is *"is this process configured to work"*; whether the
 * work is keeping up is a question for a Prometheus rule against
 * `queue_job_duration_seconds`, once there are alert rules at all.
 */

/** The subset of a scheduler entry this needs. Narrow, so it is testable. */
export interface RegisteredSchedule {
  readonly key: string;
}

/**
 * Is the schedule we registered present among the ones Redis holds?
 *
 * **Matched on the key we own, not on the list being non-empty.** A non-empty check
 * would pass on somebody else's schedule — and more usefully, it would pass on a
 * *stale* schedule left behind by a renamed id, which is precisely the mistake
 * `queues.ts` warns about when it says changing `EXPIRE_REQUESTS_SCHEDULER` creates a
 * second schedule rather than renaming the first. This is what would notice.
 */
export function scheduleIsRegistered(
  schedules: readonly RegisteredSchedule[],
  expectedKey: string,
): boolean {
  return schedules.some((schedule) => schedule.key === expectedKey);
}

/**
 * Are **all** the schedules we registered present? (slice 5.4b)
 *
 * **Added when a second schedule arrived, and the plural is the point.** The health
 * check previously asked about one key by name. With two schedules, asking about
 * only the first would leave the worker reporting healthy while the reconciliation
 * sweep silently never ran — which is the exact failure `scheduleIsRegistered` was
 * written to catch, one schedule along.
 *
 * **Every key, not any key.** A worker holding one of two schedules is not half
 * healthy; it is a worker that has stopped doing something it is supposed to do.
 */
export function allSchedulesRegistered(
  schedules: readonly RegisteredSchedule[],
  expectedKeys: readonly string[],
): boolean {
  return expectedKeys.every((key) => scheduleIsRegistered(schedules, key));
}
