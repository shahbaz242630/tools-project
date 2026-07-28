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
