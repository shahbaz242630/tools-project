import { createRecordingLogger } from '@platform/observability/testing';
import { getCorrelationId, runWithContext } from '@platform/observability';
import { Queue } from 'bullmq';
import type { Worker } from 'bullmq';
import { afterEach, describe, expect, it } from 'vitest';
import { envelope } from './envelope.js';
import { createHeartbeatHandler } from './heartbeat.handler.js';
import { HEARTBEAT_JOB, MAINTENANCE_QUEUE } from './queues.js';
import { createMaintenanceWorker } from './worker.js';

/**
 * Runs against a real Redis. Excluded from `pnpm test` and run by
 * `pnpm test:integration`, so the default suite stays dependency-free.
 *
 * BullMQ is almost entirely Redis semantics — atomic moves between sorted sets,
 * lock renewal, retry bookkeeping. Faking that would test the fake. This is the
 * only way to know a job enqueued by one process is actually executed by
 * another, with its correlation intact.
 *
 * Reading process.env directly is fine here: test files are exempt from the
 * no-direct-env invariant, and pulling in the full environment schema would
 * mean inventing Postgres credentials for a test that never touches Postgres.
 */

const connection = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: Number(process.env['REDIS_PORT'] ?? 6379),
};

/** Isolated from development data and from other runs on the same Redis. */
const prefix = `test-${process.pid}-${MAINTENANCE_QUEUE}`;

let worker: Worker | undefined;
let queue: Queue | undefined;

afterEach(async () => {
  await worker?.close();
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  worker = undefined;
  queue = undefined;
});

/** Resolves when the worker finishes a job, or rejects with its failure. */
function settled(target: Worker): Promise<{ ok: boolean; error?: Error }> {
  return new Promise((resolve) => {
    target.once('completed', () => resolve({ ok: true }));
    target.once('failed', (_job, error) => resolve({ ok: false, error }));
  });
}

describe('maintenance worker against Redis', () => {
  it('executes a job that another process enqueued', async () => {
    const recording = createRecordingLogger();
    worker = createMaintenanceWorker({
      connection,
      prefix,
      logger: recording.logger,
      handlers: { [HEARTBEAT_JOB]: createHeartbeatHandler(recording.logger) },
    });

    queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix });
    await queue.add(HEARTBEAT_JOB, envelope({ source: 'integration-test' }));

    const outcome = await settled(worker);

    expect(outcome.ok).toBe(true);
    expect(recording.at('info')[0]?.fields?.['source']).toBe('integration-test');
  });

  it('carries the correlation id from enqueue to execution', async () => {
    // The claim the envelope exists to make, across a real Redis round trip.
    //
    // Asserted by reading the ambient context from inside the handler, not from
    // the log fields: the recording logger is a fake that stores what it is
    // handed, so a log-field assertion would pass even if the context had never
    // been established.
    let seenInHandler: string | undefined;

    worker = createMaintenanceWorker({
      connection,
      prefix,
      logger: createRecordingLogger().logger,
      handlers: {
        [HEARTBEAT_JOB]: async () => {
          seenInHandler = getCorrelationId();
        },
      },
    });

    queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix });

    // Enqueued as if from inside a request.
    const wrapped = runWithContext({ correlationId: 'trace-from-api' }, () =>
      envelope({ source: 'api' }),
    );
    await queue.add(HEARTBEAT_JOB, wrapped);
    await settled(worker);

    expect(seenInHandler).toBe('trace-from-api');
  });

  it('fails a job whose handler is not registered', async () => {
    // What a deploy that removes a handler looks like while jobs are queued.
    const recording = createRecordingLogger();
    worker = createMaintenanceWorker({
      connection,
      prefix,
      logger: recording.logger,
      handlers: {},
    });

    queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix });
    await queue.add(HEARTBEAT_JOB, envelope({ source: 'api' }));

    const outcome = await settled(worker);

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toContain('no handler registered');
    expect(recording.at('error')[0]?.message).toBe('job failed');
  });

  it('keeps a failed job rather than discarding it', async () => {
    const recording = createRecordingLogger();
    worker = createMaintenanceWorker({
      connection,
      prefix,
      logger: recording.logger,
      handlers: {},
    });

    queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix });
    await queue.add(HEARTBEAT_JOB, envelope({ source: 'api' }));
    await settled(worker);

    // Recoverable: it can be inspected and retried after the handler returns.
    expect(await queue.getJobCountByTypes('failed')).toBe(1);
  });

  it('fails one malformed job without stopping the worker', async () => {
    const recording = createRecordingLogger();
    worker = createMaintenanceWorker({
      connection,
      prefix,
      logger: recording.logger,
      handlers: { [HEARTBEAT_JOB]: createHeartbeatHandler(recording.logger) },
    });

    queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix });

    const first = settled(worker);
    await queue.add(HEARTBEAT_JOB, { correlationId: 'x', payload: {} });
    expect((await first).ok).toBe(false);

    // Still serving: the next job succeeds.
    const second = settled(worker);
    await queue.add(HEARTBEAT_JOB, envelope({ source: 'after-failure' }));
    expect((await second).ok).toBe(true);
  });
});
