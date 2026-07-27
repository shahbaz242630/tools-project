import { runInJobContext } from './envelope.js';
import type { JobEnvelope } from './envelope.js';

export type JobHandler = (envelope: JobEnvelope<never>) => Promise<void>;

/** The part of a BullMQ job this needs. Narrow, so routing is testable. */
export interface ProcessableJob {
  readonly name: string;
  readonly data: unknown;
}

/**
 * Routes a job to its handler inside the correlation context the job carries.
 *
 * Separated from `createMaintenanceWorker` because everything interesting
 * happens here, and none of it needs Redis: which handler runs, what happens
 * when there is not one, and whether the trace survives the queue. Constructing
 * a BullMQ `Worker` opens a connection, so keeping these together would make
 * every one of those assertions require a live broker.
 */
export function createJobProcessor(
  handlers: Readonly<Record<string, JobHandler>>,
): (job: ProcessableJob) => Promise<void> {
  return async function process(job: ProcessableJob): Promise<void> {
    const data = job.data as JobEnvelope<never> | undefined;

    // Established before the handler runs, so every log line it produces — and
    // every provider call it makes — carries the id from the request that
    // enqueued the work.
    return runInJobContext(data?.correlationId, async () => {
      const handler = handlers[job.name];

      // An unknown job name usually means a deploy removed a handler while jobs
      // of that type were still queued. Failing the single job keeps it in the
      // failed set, where it can be inspected and retried, rather than
      // discarding the work or taking the worker down.
      if (handler === undefined) {
        throw new Error(`no handler registered for job "${job.name}"`);
      }

      await handler(data as JobEnvelope<never>);
    });
  };
}
