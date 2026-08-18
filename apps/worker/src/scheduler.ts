import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import type { Logger } from '@platform/observability';
import { envelope } from './envelope.js';
import {
  EXPIRE_REQUESTS_EVERY_MS,
  EXPIRE_REQUESTS_JOB,
  EXPIRE_REQUESTS_SCHEDULER,
  MAINTENANCE_QUEUE,
} from './queues.js';

/**
 * The project's first job producer (slice 4.7b).
 *
 * **Nothing had ever enqueued anything before this.** The worker consumed a queue
 * nothing wrote to, and `identity.service.ts` still carries the note *"queueing it
 * needs a scheduler we do not have."* This is that scheduler, and it is deliberately
 * the smallest possible one: a `Queue` handle whose only purpose is to register a
 * repeatable job, held open because closing it would close the schedule's owner.
 *
 * ## Why the worker registers its own schedule
 *
 * The alternative is the API registering it, which sounds tidier — the API is where
 * the work happens — and is worse for two reasons. It would make the API a queue
 * producer, so a service that must never block on Redis would gain a Redis
 * dependency on the boot path. And **the schedule would then be registered by the
 * process that does not run it**, so a worker deployed without an API would sit idle
 * with no schedule and nothing saying why.
 *
 * ## `upsertJobScheduler`, and what it protects against
 *
 * BullMQ 6 replaced the old `repeat` option on `add()` with job schedulers, and the
 * upsert semantics matter here more than the rename: **every deploy restarts this
 * process**, so registration runs again on every release. An `add()` with a repeat
 * option would leave the previous schedule in place beside the new one, and two
 * identical schedules is two sweeps a tick — harmless, because the work is
 * idempotent, and invisible, because both succeed. An upsert against a **stable id**
 * is what keeps it at one.
 *
 * That makes `EXPIRE_REQUESTS_SCHEDULER` load-bearing in a way a constant usually is
 * not: changing the string does not rename the schedule Redis already holds, it
 * creates a second one and leaves the first running forever. `queues.ts` says so
 * where the constant is.
 */
export interface SchedulerOptions {
  readonly connection: ConnectionOptions;
  readonly logger: Logger;
  /** Redis key prefix, matching the worker's — see `MaintenanceWorkerOptions`. */
  readonly prefix?: string;
}

export interface Scheduler {
  /** Register the repeatable sweep, or update it if the interval changed. */
  register(): Promise<void>;
  /** Release the Redis connection this holds. Called from the shutdown sequence. */
  close(): Promise<void>;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { connection, logger, prefix } = options;

  const queue = new Queue(MAINTENANCE_QUEUE, {
    connection,
    ...(prefix !== undefined ? { prefix } : {}),
  });

  /*
   * A `Queue` emits `error` on a lost connection exactly as a `Worker` does, and an
   * unhandled 'error' event ends the process. The supervisor decides that, not an
   * emitter default — the same reasoning `worker.ts` gives for its own handler.
   */
  queue.on('error', (error) => {
    logger.warn('scheduler queue error', { queue: MAINTENANCE_QUEUE, error });
  });

  return {
    async register(): Promise<void> {
      await queue.upsertJobScheduler(
        EXPIRE_REQUESTS_SCHEDULER,
        {
          /*
           * **No `immediately: true`, and there was until BullMQ said out loud that
           * it does nothing**: registering with both printed *"Using option
           * immediately with every does not affect the job's schedule. Job will run
           * immediately anyway"* on every boot.
           *
           * Removing it changed no behaviour, which was then measured in three
           * cases rather than assumed — because "the schedule fires when you expect"
           * is exactly the claim that is easy to write and wrong:
           *
           * - **A fresh schedule fires at once.** Walked locally: a request was
           *   expired **248 ms** after `worker started`.
           * - **A restart between ticks keeps the existing next-run time**, so a
           *   deploy does *not* get an extra sweep. Read out of Redis after a
           *   restart: the next fire was 13 minutes away on a 15-minute interval.
           *   That is the same worst case as normal operation, so nothing is lost —
           *   but it does mean a deploy is not a way to force a sweep.
           * - **A restart after missed ticks fires promptly**, which is the case
           *   that matters. With the interval temporarily at 5 s and the worker
           *   stopped for 16 s (three intervals missed), the first sweep after
           *   restart came **1,023 ms** in: an overdue delayed job runs on
           *   reconnect. So a backlog after real downtime clears on boot — via the
           *   overdue tick, not via any option here.
           */
          every: EXPIRE_REQUESTS_EVERY_MS,
        },
        {
          name: EXPIRE_REQUESTS_JOB,
          /*
           * An empty payload, wrapped so the job carries a correlation id like every
           * other (`envelope.ts`). There is no ambient context at boot, so this
           * mints a fresh one — which is correct: the schedule is its own origin,
           * not a continuation of somebody's request.
           *
           * **The envelope is stored once, at registration, and reused for every
           * job the scheduler mints** — so all of them share one correlation id.
           * That is a known limitation of a template rather than a design: the
           * per-run id is `requestId`, which `runInJobContext` mints fresh on each
           * execution, and that is the one that distinguishes two sweeps in a log.
           */
          data: envelope<Record<string, never>>({}),
        },
      );

      logger.info('registered the expiry schedule', {
        queue: MAINTENANCE_QUEUE,
        scheduler: EXPIRE_REQUESTS_SCHEDULER,
        job: EXPIRE_REQUESTS_JOB,
        everyMs: EXPIRE_REQUESTS_EVERY_MS,
      });
    },

    async close(): Promise<void> {
      await queue.close();
    },
  };
}
