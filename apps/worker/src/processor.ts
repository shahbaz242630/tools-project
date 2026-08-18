import type { MetricJobName, Metrics } from '@platform/observability';
import { runInJobContext } from './envelope.js';
import type { JobEnvelope } from './envelope.js';
import { MAINTENANCE_QUEUE } from './queues.js';

export type JobHandler = (envelope: JobEnvelope<never>) => Promise<void>;

/**
 * The job names this build can put in a metric label (slice H6).
 *
 * **Derived from the handler map at call time rather than listed here**, so a job
 * name only becomes a label if this process actually has a handler for it. That is
 * the whole control: `job.name` is read back from Redis, so after a deploy that
 * removed a handler it can be a name this build has never heard of, and putting it
 * in a label unfiltered mints a series per unknown name.
 *
 * `MetricJobName` is the closed union in `@platform/observability`; anything not in
 * it collapses to `unknown`, exactly as a URL collapses to a route template.
 */
const KNOWN_JOB_NAMES: readonly MetricJobName[] = [
  'heartbeat',
  'expire-requests',
] as const;

function labelFor(name: string): MetricJobName {
  return (KNOWN_JOB_NAMES as readonly string[]).includes(name)
    ? (name as MetricJobName)
    : 'unknown';
}

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
  /**
   * Where a job's duration and outcome are recorded (slice H6).
   *
   * **Here rather than in each handler**, because this is the one place every job
   * already passes through — so a new job type is measured without its author
   * remembering to, which is the difference between a metric and a convention.
   *
   * **Optional, so the H1 signature still works.** A worker built without it
   * records nothing and behaves identically; `createNoopMetrics` is what
   * `main.ts` passes when `METRICS_ENABLED` is off, so the "off" path is a real
   * object rather than a branch here.
   */
  metrics?: Metrics,
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
        /*
         * **Recorded before throwing, and this is the case the label union exists
         * for.** A job whose handler is gone is exactly the one carrying a name
         * this build does not know, so it lands under `unknown` — one series for
         * every such name rather than one each. It is also the failure worth
         * seeing: it means jobs are being dropped on the floor after a deploy.
         *
         * `durationMs: 0` because nothing ran. The histogram's subject is how long
         * work took, and a routing failure took no time — inventing an elapsed
         * value here would put a number in the distribution that describes nothing.
         */
        metrics?.recordQueueJob({
          queue: MAINTENANCE_QUEUE,
          jobName: labelFor(job.name),
          durationMs: 0,
          outcome: 'failed',
        });

        throw new Error(`no handler registered for job "${job.name}"`);
      }

      /*
       * **`performance.now()`, not `Date.now()` and not the injected clock.**
       *
       * Not the injected clock, because this is a *duration* rather than a business
       * instant: ADR 0003 governs when a rental day starts, nothing here is rendered
       * to anybody or compared against a stored time, and a fake clock would make
       * every measured duration zero.
       *
       * Not `Date.now()` either — the `no-restricted-globals` rule refused it, and
       * chasing that refusal landed somewhere better. Wall clock can step: an NTP
       * correction mid-job yields a duration that is wrong, or negative, and a
       * negative observation in a histogram is worse than a missing one.
       * `performance.now()` is monotonic, which is what an elapsed time actually
       * wants. Fastify's `reply.elapsedTime`, which the API's hook uses, is monotonic
       * for the same reason.
       */
      const startedAt = performance.now();
      try {
        await handler(data as JobEnvelope<never>);
      } catch (error) {
        metrics?.recordQueueJob({
          queue: MAINTENANCE_QUEUE,
          jobName: labelFor(job.name),
          durationMs: performance.now() - startedAt,
          outcome: 'failed',
        });
        /*
         * Rethrown untouched — no wrapping, no `cause` juggling. BullMQ's retry
         * bookkeeping and `worker.ts`'s `failed` handler both act on this error,
         * and a metric is an observer of the path rather than a participant in it.
         */
        throw error;
      }

      metrics?.recordQueueJob({
        queue: MAINTENANCE_QUEUE,
        jobName: labelFor(job.name),
        durationMs: performance.now() - startedAt,
        outcome: 'completed',
      });
    });
  };
}
