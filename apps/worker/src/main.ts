import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeEnv, loadEnv } from '@platform/config';
import {
  createLogger,
  createNoopErrorTracker,
  installProcessHandlers,
} from '@platform/observability';
import { createShutdown } from '@platform/runtime';
import { createHeartbeatHandler } from './heartbeat.handler.js';
import { HEARTBEAT_JOB } from './queues.js';
import { createMaintenanceWorker } from './worker.js';

/**
 * Composition root for the worker. Kept thin and excluded from coverage; the
 * behaviour it wires together is tested against a real Redis instead.
 */

const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Where the container's HEALTHCHECK looks, and how often this process refreshes
 * it.
 *
 * **The worker had no health signal at all until 15 August 2026**, and the
 * Dockerfile's comment explained why: a liveness probe asserting only "the
 * process exists" reads healthy while the worker sits disconnected from Redis
 * processing nothing. That was right about the probe and wrong about the
 * conclusion — with no HEALTHCHECK, compose's `--wait` accepts "running", so a
 * crash-looping worker deployed as a success and nothing in `deploy.mjs` ever
 * asked about it.
 *
 * So this is not a "process exists" signal. The file is rewritten only after a
 * command has come back over the worker's *own* Redis connection, which means a
 * stale file is one of: a wedged event loop, an unreachable broker, or a process
 * that keeps restarting. The staleness bound lives in the Dockerfile and must
 * stay several intervals wide; `scripts/lib/worker-health-budget.test.mjs`
 * asserts the relationship, because the two numbers are in different files, in
 * different languages, and nothing else compares them — the same shape as the
 * shutdown budget above it.
 *
 * `tmpdir()` rather than a literal `/tmp`: the deployed container mounts a
 * tmpfs there and its root filesystem is read-only, and the same code has to run
 * on a Windows laptop.
 */
const HEALTH_FILE = join(tmpdir(), 'worker-health');
const HEALTH_INTERVAL_MS = 10_000;

/**
 * How long to let the queue drain before giving up on it. Shorter than
 * SHUTDOWN_TIMEOUT_MS so the sequence finishes and exits 0 by its own decision;
 * the backstop above is for the case where even this does not return.
 *
 * It has to be generous, because `close()` is waiting for a real job to finish
 * and an interrupted job is re-delivered. It also has to be bounded, because
 * bullmq's `close()` does not settle at all when Redis was never reachable —
 * which is exactly the state during the Redis outage that makes somebody
 * redeploy.
 */
const DRAIN_TIMEOUT_MS = 25_000;

function main(): void {
  const env = loadEnv();
  const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });

  /*
   * The error-tracking seam, installed rather than merely built — see the same
   * block in `apps/api/src/main.ts` for why this is not what ADR 0008 deferred.
   * It matters more here than there: a rejection inside a booking-expiry or
   * payout-release job has no request to fail and no user to notice.
   */
  const errorTracker = createNoopErrorTracker(logger);
  installProcessHandlers(logger, errorTracker, {
    // Non-zero, so `restart: unless-stopped` reads it as a crash. A worker that
    // carries on after an uncaught exception keeps taking jobs it may not be
    // able to finish, and a re-delivered job is the one thing this process is
    // built to avoid causing.
    onFatal: () => process.exit(1),
  });

  const worker = createMaintenanceWorker({
    // Connection options rather than a client we built: BullMQ requires
    // `maxRetriesPerRequest: null` on a worker's connection, and letting it
    // construct its own avoids that being silently wrong.
    connection: { host: env.REDIS_HOST, port: env.REDIS_PORT },
    logger,
    handlers: { [HEARTBEAT_JOB]: createHeartbeatHandler(logger) },
  });

  /*
   * One probe at a time. `worker.client` does not settle until the connection is
   * ready, and a command issued on a down connection is buffered rather than
   * refused — so during an outage each interval would otherwise leave another
   * pending probe behind, and reconnecting would resolve all of them at once.
   */
  let probing = false;

  const health = setInterval(() => {
    if (probing) return;
    probing = true;

    void (async () => {
      try {
        // The worker's own connection, not a second one. A fresh client proving
        // Redis is reachable would say nothing about whether *this* worker is
        // still attached to it — which is the failure the whole signal is for.
        const connection = await worker.client;

        // Two questions, cheapest first. `status` is the client's own view and
        // costs nothing; INFO is a real round trip, and it is the round trip
        // that distinguishes a live connection from a socket that believes it is
        // fine. Asking `status` first also means no command is ever queued on a
        // connection that is down, which is what would never settle.
        if (connection.status !== 'ready') {
          logger.warn('health signal not refreshed', {
            redisStatus: connection.status,
          });
          return;
        }
        await connection.info();

        writeFileSync(HEALTH_FILE, 'ok\n');
      } catch (error) {
        // Never fatal. The file simply stops being refreshed and the container
        // probe draws the conclusion — which is the right place for it, because
        // one failed round trip during a reconnection is not an unhealthy
        // worker, and three consecutive ones are.
        logger.warn('health signal not refreshed', { error });
      } finally {
        probing = false;
      }
    })();
  }, HEALTH_INTERVAL_MS);

  // Never a reason for the process to stay alive. If everything else has let go,
  // an interval writing a file nobody reads must not be what keeps it running.
  health.unref();

  const shutdown = createShutdown({
    logger,
    // Longer than the API's: a worker mid-job has to finish it, and an
    // interrupted job is re-delivered, which for anything non-idempotent is
    // worse than waiting.
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    closeTimeoutMs: DRAIN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    closables: [
      {
        // First, so the signal goes stale the moment we begin stopping. A
        // container that is draining is not one a probe should keep calling
        // healthy, and this also stops a probe racing the drain for the
        // connection it is about to close.
        name: 'health signal',
        close: async () => {
          clearInterval(health);
        },
      },
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
