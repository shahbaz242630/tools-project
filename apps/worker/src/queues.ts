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
