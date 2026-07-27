import { describeEnv, loadEnv } from '@platform/config';
import { createLogger } from '@platform/observability';
import { createShutdown } from '@platform/runtime';
import { createHeartbeatHandler } from './heartbeat.handler.js';
import { HEARTBEAT_JOB } from './queues.js';
import { createMaintenanceWorker } from './worker.js';

/**
 * Composition root for the worker. Kept thin and excluded from coverage; the
 * behaviour it wires together is tested against a real Redis instead.
 */

const SHUTDOWN_TIMEOUT_MS = 30_000;

function main(): void {
  const env = loadEnv();
  const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });

  const worker = createMaintenanceWorker({
    // Connection options rather than a client we built: BullMQ requires
    // `maxRetriesPerRequest: null` on a worker's connection, and letting it
    // construct its own avoids that being silently wrong.
    connection: { host: env.REDIS_HOST, port: env.REDIS_PORT },
    logger,
    handlers: { [HEARTBEAT_JOB]: createHeartbeatHandler(logger) },
  });

  const shutdown = createShutdown({
    logger,
    // Longer than the API's: a worker mid-job has to finish it, and an
    // interrupted job is re-delivered, which for anything non-idempotent is
    // worse than waiting.
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    closables: [
      {
        name: 'maintenance worker',
        // `close()` stops taking new jobs and waits for in-flight ones.
        close: () => worker.close(),
      },
    ],
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('worker started', {
    queue: 'maintenance',
    handlers: [HEARTBEAT_JOB],
    ...describeEnv(env),
  });
}

try {
  main();
} catch (error) {
  // No logger yet if configuration failed. `console` is banned because it
  // bypasses redaction; this is the one point where no logger can exist.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
