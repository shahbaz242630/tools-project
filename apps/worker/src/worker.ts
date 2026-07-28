import type { Logger } from '@platform/observability';
import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { createJobProcessor } from './processor.js';
import type { JobHandler } from './processor.js';
import { MAINTENANCE_QUEUE } from './queues.js';

export type { JobHandler } from './processor.js';

export interface MaintenanceWorkerOptions {
  readonly connection: ConnectionOptions;
  readonly logger: Logger;
  /** Keyed by job name. An unknown name fails the job rather than the worker. */
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly concurrency?: number;
  /**
   * Redis key prefix. Lets separate environments share one Redis without one
   * consuming the other's jobs, and lets a test run against a live instance
   * without touching development data.
   */
  readonly prefix?: string;
}

/**
 * Wiring only. The routing and correlation behaviour lives in `processor.ts`,
 * which is unit tested; this is exercised end to end by `*.redis.test.ts`
 * against a real broker.
 */
export function createMaintenanceWorker(options: MaintenanceWorkerOptions): Worker {
  const { connection, logger, handlers, concurrency = 5, prefix } = options;

  const worker = new Worker(MAINTENANCE_QUEUE, createJobProcessor(handlers), {
    connection,
    concurrency,
    ...(prefix !== undefined ? { prefix } : {}),
  });

  worker.on('failed', (job, error) => {
    logger.error('job failed', {
      queue: MAINTENANCE_QUEUE,
      job: job?.name,
      jobId: job?.id,
      attempts: job?.attemptsMade,
      error,
    });
  });

  // BullMQ emits this for failures outside a job — most often a lost Redis
  // connection. Unhandled, it is an unhandled 'error' event, which ends the
  // process; the supervisor should decide that, not an emitter default.
  worker.on('error', (error) => {
    logger.warn('worker error', { queue: MAINTENANCE_QUEUE, error });
  });

  return worker;
}
