import { createRecordingLogger } from '@platform/observability/testing';
import { Queue } from 'bullmq';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPIRE_REQUESTS_EVERY_MS,
  EXPIRE_REQUESTS_JOB,
  EXPIRE_REQUESTS_SCHEDULER,
  MAINTENANCE_QUEUE,
  RECONCILE_PAYMENTS_EVERY_MS,
  RECONCILE_PAYMENTS_JOB,
  RECONCILE_PAYMENTS_SCHEDULER,
} from './queues.js';
import { createScheduler } from './scheduler.js';
import type { Scheduler } from './scheduler.js';

/**
 * The repeatable schedule against a real Redis (slice 4.7b).
 *
 * **A job scheduler is entirely Redis state** — a delayed job, a scheduler key, and
 * the bookkeeping that mints the next one — so a fake would test the fake. What only
 * a real broker can show is the property this slice actually depends on:
 * **registering twice leaves one schedule, not two.** Every deploy restarts the
 * worker and re-runs registration, and two identical schedules would be invisible
 * (both succeed, the work is idempotent) and permanent.
 *
 * Reading `process.env` directly is fine here, as `worker.redis.test.ts` says: test
 * files are exempt from the no-direct-env invariant, and the full schema would mean
 * inventing Postgres credentials for a test that never touches Postgres.
 */

const connection = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['REDIS_PORT'] ?? 6379),
};

/** Isolated from development data and from other runs on the same Redis. */
const prefix = `test-sched-${process.pid}-${MAINTENANCE_QUEUE}`;

let scheduler: Scheduler | undefined;
let queue: Queue | undefined;

afterEach(async () => {
  await scheduler?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  scheduler = undefined;
  queue = undefined;
});

function inspector(): Queue {
  queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix });
  return queue;
}

describe('the maintenance schedules', () => {
  it('registers every scheduler, named the way the constants say', async () => {
    /*
     * **Both, in one `register()` call** (slice 5.4b). A worker that came up with
     * one of two schedules would look healthy and silently never reconcile, which
     * is why `register` does all of them rather than leaving a caller to remember.
     */
    const logger = createRecordingLogger();
    scheduler = createScheduler({ connection, logger: logger.logger, prefix });

    await scheduler.register();

    const registered = await inspector().getJobSchedulers();
    expect(registered.map((entry) => entry.key).sort()).toEqual(
      [EXPIRE_REQUESTS_SCHEDULER, RECONCILE_PAYMENTS_SCHEDULER].sort(),
    );
  });

  it('mints a job under the name the processor routes on', async () => {
    /*
     * The name matters separately from the scheduler id: the processor looks the
     * handler up by job name, so a mismatch here is a job that arrives and fails
     * with "no handler" every fifteen minutes.
     */
    const logger = createRecordingLogger();
    scheduler = createScheduler({ connection, logger: logger.logger, prefix });

    await scheduler.register();

    const jobs = await inspector().getJobs(['delayed', 'waiting', 'active']);
    expect(jobs.map((job) => job.name)).toContain(EXPIRE_REQUESTS_JOB);
  });

  it('carries a correlation id, so a sweep is traceable across the boundary', async () => {
    const logger = createRecordingLogger();
    scheduler = createScheduler({ connection, logger: logger.logger, prefix });

    await scheduler.register();

    const jobs = await inspector().getJobs(['delayed', 'waiting', 'active']);
    const data = jobs[0]?.data as { correlationId?: unknown } | undefined;
    expect(typeof data?.correlationId).toBe('string');
  });

  it('leaves one schedule when registered twice', async () => {
    /*
     * **The assertion this file exists for.** Every deploy restarts the worker and
     * runs `register()` again. `upsertJobScheduler` against a stable id is what
     * keeps that at one; the old `add({ repeat })` would have left both running, and
     * nothing would have said so because both succeed.
     */
    const logger = createRecordingLogger();
    scheduler = createScheduler({ connection, logger: logger.logger, prefix });

    await scheduler.register();
    await scheduler.register();
    await scheduler.register();

    // Two schedules from 5.4b, and still two after three registrations — the
    // property is "no duplicates", not "one".
    const registered = await inspector().getJobSchedulers();
    expect(registered).toHaveLength(2);
  });

  it('says what it registered, including the interval', async () => {
    // The interval is engineering judgement bounded by configuration (§8.6's 1-hour
    // floor), so a boot log that states it is how anybody finds out what it is.
    const logger = createRecordingLogger();
    scheduler = createScheduler({ connection, logger: logger.logger, prefix });

    await scheduler.register();

    const [line] = logger.at('info');
    expect(line?.message).toBe('registered the maintenance schedules');
    expect(line?.fields).toMatchObject({
      queue: MAINTENANCE_QUEUE,
      schedules: [
        {
          scheduler: EXPIRE_REQUESTS_SCHEDULER,
          job: EXPIRE_REQUESTS_JOB,
          everyMs: EXPIRE_REQUESTS_EVERY_MS,
        },
        {
          scheduler: RECONCILE_PAYMENTS_SCHEDULER,
          job: RECONCILE_PAYMENTS_JOB,
          everyMs: RECONCILE_PAYMENTS_EVERY_MS,
        },
      ],
    });
  });

  it('can be closed without removing the schedule', async () => {
    /*
     * Shutdown releases a Redis connection; the schedule lives in Redis and must
     * survive, or every deploy would leave a window with nothing scheduled until
     * the next boot re-registered it.
     */
    const logger = createRecordingLogger();
    const first = createScheduler({ connection, logger: logger.logger, prefix });
    await first.register();
    await first.close();

    const registered = await inspector().getJobSchedulers();
    expect(registered).toHaveLength(2);
  });
});
