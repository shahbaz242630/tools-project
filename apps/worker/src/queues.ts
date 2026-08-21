/**
 * Queue and job names.
 *
 * Named in one place because these strings are persisted in Redis: a queue name
 * changed in code does not rename the queue that already holds jobs, so a typo
 * or a rename silently strands work rather than failing loudly.
 */

export const MAINTENANCE_QUEUE = 'maintenance';

export const HEARTBEAT_JOB = 'heartbeat';

export interface HeartbeatPayload {
  /** Which component asked for the heartbeat — `api`, `cron`, a human. */
  readonly source: string;
}

/**
 * The scheduled sweep that expires unanswered booking requests (slice 4.7b).
 *
 * **The job name and the scheduler id are separate strings and both are here**,
 * because both are persisted in Redis: the name is what the processor routes on,
 * and the id is what `upsertJobScheduler` updates rather than duplicates. Changing
 * either in code does not rename what Redis already holds — a renamed scheduler id
 * leaves the old schedule running forever beside the new one, which is worse than a
 * typo in a queue name because both then fire.
 */
export const EXPIRE_REQUESTS_JOB = 'expire-requests';

export const EXPIRE_REQUESTS_SCHEDULER = 'expire-requests-every-15-minutes';

/**
 * How often the sweep runs.
 *
 * **Engineering judgement, and the bound that decides it is configuration.** §8.6's
 * request deadline is versioned per category, and slice 4.5a's migration bounds it
 * with a `CHECK` between **1 hour** and two weeks. So the shortest deadline an
 * administrator can configure is an hour, and a fifteen-minute sweep keeps
 * worst-case staleness at a quarter of it. Tying this to the *configured* deadline
 * was considered and rejected: the schedule would then change when somebody edited
 * a category, which is a lot of moving parts to save nine ticks an hour.
 *
 * **The cost of a tick is close to nothing.** A sweep that finds nothing logs at
 * `debug` and runs one indexed query, so this is not a number that needs tuning
 * downwards for cost — and there is no upstream to rate-limit, because the API is
 * ours.
 */
export const EXPIRE_REQUESTS_EVERY_MS = 15 * 60 * 1_000;

/**
 * The payload — deliberately empty, and typed so it stays that way.
 *
 * A sweep takes no arguments: *which* requests have lapsed is a question only the
 * database can answer, and a job that could name them could name the wrong ones.
 * `Record<string, never>` rather than `void` because the envelope wraps a payload
 * and an absent one would have to be special-cased at both ends.
 */
export type ExpireRequestsPayload = Record<string, never>;

/**
 * The scheduled sweep that re-reads stale payment attempts (slice 5.4b).
 *
 * **A second scheduler id, and the warning above applies with more force.** Both
 * strings are persisted in Redis; a renamed scheduler id leaves the old schedule
 * running forever *beside* the new one. With one schedule that meant two sweeps a
 * tick — harmless, because the work is idempotent, and invisible, because both
 * succeed. With two schedules there is now also a way to point the wrong id at the
 * wrong job, which fails loudly rather than quietly and is the better failure.
 */
export const RECONCILE_PAYMENTS_JOB = 'reconcile-payments';

export const RECONCILE_PAYMENTS_SCHEDULER = 'reconcile-payments-every-30-minutes';

/**
 * How often the reconciliation sweep runs.
 *
 * **Thirty minutes, against the API sweep's fifteen, and the difference is
 * deliberate.** Each attempt this examines costs a **provider round trip**, where an
 * expiry sweep costs one indexed query — so the two are not the same kind of tick
 * and should not share a number just because they share a shape.
 *
 * **It is not the staleness threshold.** `ReconciliationService.STALE_AFTER_MINUTES`
 * decides what is worth chasing (15 minutes); this decides how often we look.
 * Conflating them is how a job that runs hourly ends up only ever examining things
 * an hour old.
 *
 * **§14 calls this job daily and thirty minutes is far more often.** Daily is the
 * *reconciliation* cadence — the accounting comparison against a provider's
 * statement, which is a later slice. This is the recovery of individual stuck
 * attempts, where a day is the difference between a renter refreshing a page and a
 * renter giving up.
 */
export const RECONCILE_PAYMENTS_EVERY_MS = 30 * 60 * 1_000;

/** Empty for the reason `ExpireRequestsPayload` is: a sweep takes no arguments. */
export type ReconcilePaymentsPayload = Record<string, never>;
