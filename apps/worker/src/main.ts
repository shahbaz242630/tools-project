import { closeSync, constants, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeEnv, loadEnv, loadWorkerEnv } from '@platform/config';
import {
  createLogger,
  createNoopErrorTracker,
  createNoopMetrics,
  createPrometheusMetrics,
  installProcessHandlers,
} from '@platform/observability';
import { createShutdown } from '@platform/runtime';
import { hasNothingToDrain } from './drain.js';
import { createExpireRequestsHandler } from './expire-requests.handler.js';
import { createReconcilePaymentsHandler } from './reconcile-payments.handler.js';
import { createHeartbeatHandler } from './heartbeat.handler.js';
import { createMetricsServer } from './metrics-server.js';
import {
  EXPIRE_REQUESTS_JOB,
  EXPIRE_REQUESTS_SCHEDULER,
  HEARTBEAT_JOB,
  RECONCILE_PAYMENTS_JOB,
  RECONCILE_PAYMENTS_SCHEDULER,
} from './queues.js';
import { allSchedulesRegistered } from './schedule-health.js';
import { createScheduler } from './scheduler.js';
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
 * How the health signal is written, and why it is not a plain `writeFileSync`.
 *
 * **CodeQL flagged the plain version on PR #118, correctly.** In the deployed
 * container the temp directory is a tmpfs of our own with nothing else in it,
 * so the predictable name costs nothing. On a developer laptop `tmpdir()` is
 * the genuinely shared one — `/tmp` or `%TEMP%` — where anything else running
 * as the same user can pre-create `worker-health` as a **symlink** to a file it
 * wants overwritten, and `writeFileSync` would cheerfully follow it and write
 * through. That is `js/insecure-temporary-file`, and it is a real hole even
 * though the only machine it opens is one we own.
 *
 * `O_NOFOLLOW` closes it: the open fails with `ELOOP` rather than following a
 * symlink, so a planted link makes the health signal go stale — which the probe
 * already treats as unhealthy — instead of making us the attacker's write
 * primitive. `O_CREAT | O_TRUNC | O_WRONLY` is what `flag: 'w'` already meant.
 *
 * **`?? 0` because Windows has no `O_NOFOLLOW`.** `fs.constants` simply omits
 * it there, and `undefined` in a bitwise OR would poison the whole mask to
 * `NaN` and break every write. Falling back to zero drops the protection on the
 * one platform that cannot express it rather than dropping the file.
 *
 * Mode `0o600` for the same reason the flag is here: nothing but this process
 * has any business reading or writing it.
 */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const HEALTH_FILE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW;
const HEALTH_FILE_MODE = 0o600;

/**
 * How long to let the queue drain before giving up on it. Shorter than
 * SHUTDOWN_TIMEOUT_MS so the sequence finishes and exits 0 by its own decision;
 * the backstop above is for the case where even this does not return.
 *
 * It has to be generous, because `close()` is waiting for a real job to finish
 * and an interrupted job is re-delivered. It also has to be bounded, because
 * bullmq's `close()` can fail to settle at all when the broker is unreachable.
 *
 * **From bullmq 6 this bound is no longer what handles the never-connected
 * case** — `drain.ts` does, by not waiting at all where there is nothing to
 * wait for. What is left for this timeout is the harder case it was always
 * meant for: a connection that came up, took a job, and then died. There the
 * wait might genuinely pay off, so it is worth 25 seconds before giving up.
 */
const DRAIN_TIMEOUT_MS = 25_000;

function main(): void {
  const env = loadEnv();
  /*
   * The worker's own schema, alongside the shared one (slice 4.7b). Separate
   * because the API has no use for its own address — see `worker-env.ts`, and
   * `loadIdentityEnv` for the same split in the other direction.
   */
  const workerEnv = loadWorkerEnv();
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

  /*
   * One registry for this process (slice H6), the same rule `apps/api/src/main.ts`
   * states: a service and the HTTP surface must not each hold their own, or only one
   * of them is ever scraped.
   *
   * `service: 'worker'` is what distinguishes these series from the API's in a
   * scraper that sees both.
   */
  const metrics = env.METRICS_ENABLED
    ? createPrometheusMetrics({ service: 'worker' })
    : createNoopMetrics(logger);

  const worker = createMaintenanceWorker({
    // Connection options rather than a client we built: BullMQ requires
    // `maxRetriesPerRequest: null` on a worker's connection, and letting it
    // construct its own avoids that being silently wrong.
    connection: { host: env.REDIS_HOST, port: env.REDIS_PORT },
    logger,
    handlers: {
      [HEARTBEAT_JOB]: createHeartbeatHandler(logger),
      /*
       * The scheduled sweep (slice 4.7b, ADR 0048). It holds the secret from the
       * *shared* loader and the address from the worker's own — see the handler for
       * why the secret must never reach a log line.
       */
      [EXPIRE_REQUESTS_JOB]: createExpireRequestsHandler({
        apiBaseUrl: workerEnv.API_INTERNAL_URL,
        secret: env.INTERNAL_TRIGGER_SECRET,
        logger,
      }),
      /*
       * The reconciliation sweep (slice 5.4b). Same shape, same secret, same
       * reasons — see `internal-trigger.ts`, which both handlers are built on.
       */
      [RECONCILE_PAYMENTS_JOB]: createReconcilePaymentsHandler({
        apiBaseUrl: workerEnv.API_INTERNAL_URL,
        secret: env.INTERNAL_TRIGGER_SECRET,
        logger,
      }),
    },
    // Every job's duration and outcome, recorded in `processor.ts` — one place, so a
    // job type added later is measured without its author remembering to (slice H6).
    metrics,
  });

  /*
   * BullMQ 6 removed `Worker#client` — the high-level classes no longer expose
   * Redis internals, and the raw client lives on the backend that `getBackend()`
   * returns. Held here rather than fetched per probe: it is the same object for
   * the life of the worker, and `getBackend()` on a closing worker is not
   * something this probe should be asking about.
   */
  const backend = worker.getBackend();

  /*
   * The schedule (slice 4.7b), registered after the worker is constructed so a
   * job minted immediately has a consumer ready for it.
   *
   * **Its own Redis connection, not the worker's.** BullMQ requires
   * `maxRetriesPerRequest: null` on a worker's connection and a `Queue` wants the
   * default, so sharing one would mean choosing which of the two is wrong.
   */
  const scheduler = createScheduler({
    connection: { host: env.REDIS_HOST, port: env.REDIS_PORT },
    logger,
  });

  /*
   * **Registered without blocking the boot, and a failure is retried rather than
   * fatal.** Both halves of that were measured rather than assumed.
   *
   * *Not fatal:* an earlier version of this called `process.exit(1)` on a
   * rejection, and it was wrong. A broker that is briefly unreachable is the one
   * failure this process is built to survive — the container check boots it with no
   * Redis at all and asserts it **keeps running rather than exiting** — so crashing
   * would turn a blip into a restart loop and lose the drain behaviour `drain.ts`
   * exists for.
   *
   * *Not blocking:* ioredis buffers commands while offline, so with no broker this
   * promise simply pends until one appears. Measured on 6.1.2 with Redis
   * unreachable: the process was still up after five seconds and the registration
   * had neither resolved nor thrown. Awaiting it here would therefore hang boot
   * indefinitely, and the worker would never start consuming.
   *
   * **The residual gap, stated because nothing catches it.** If registration fails
   * while Redis is healthy, the worker runs with no schedule and the health probe —
   * which only asks whether Redis answers — still reads healthy. The retry below
   * turns that into a repeating error line rather than one, and there are no alert
   * rules yet to fire on it (`SECURITY.md` §2.3). Making the probe assert the
   * schedule exists is the fix, and it belongs with whatever slice gives the worker
   * a metrics endpoint.
   */
  const REGISTER_RETRY_MS = 30_000;

  const register = (): void => {
    void scheduler.register().catch((error: unknown) => {
      logger.error('could not register the maintenance schedules; will retry', {
        retryInMs: REGISTER_RETRY_MS,
        error,
      });
      // `unref` so a pending retry never keeps the process alive on shutdown.
      setTimeout(register, REGISTER_RETRY_MS).unref();
    });
  };

  register();

  /*
   * One probe at a time. A command issued on a down connection is buffered
   * rather than refused, so during an outage each interval would otherwise leave
   * another pending probe behind, and reconnecting would resolve all of them at
   * once.
   */
  let probing = false;

  const health = setInterval(() => {
    if (probing) return;
    probing = true;

    void (async () => {
      try {
        /*
         * Three questions, cheapest first, and the order is the point.
         *
         * BullMQ's own connection status is synchronous and settles the one
         * thing the client promise cannot tell us safely: whether there has
         * ever been a connection at all. `backend.connection.client` does not
         * resolve until the connection is ready, so awaiting it during an
         * outage awaits something that may never settle — which is precisely
         * the shape of failure this project has been bitten by twice. Asking
         * `status` first means the promise is only ever awaited once it is
         * already resolved.
         *
         * Then the client's own view, which is what notices a connection that
         * came up and later dropped: BullMQ leaves its status at `ready` once
         * reached, so it answers "did we ever connect", not "are we connected".
         *
         * Then INFO, a real round trip, because it is the round trip that
         * distinguishes a live connection from a socket that believes it is
         * fine. Asking the two statuses first also means no command is ever
         * queued on a connection that is down, which is what would never
         * settle.
         *
         * All three are asked of the worker's own connection, not a second one.
         * A fresh client proving Redis is reachable would say nothing about
         * whether *this* worker is still attached to it — which is the failure
         * the whole signal exists for.
         */
        if (backend.connection.status !== 'ready') {
          logger.warn('health signal not refreshed', {
            backendStatus: backend.connection.status,
          });
          return;
        }

        const connection = await backend.connection.client;

        if (connection.status !== 'ready') {
          logger.warn('health signal not refreshed', {
            redisStatus: connection.status,
          });
          return;
        }
        await connection.info();

        /*
         * **Fourth question, added in slice H6: is the schedule actually there?**
         *
         * The three above prove the broker answers. None of them catches the failure
         * 4.7b introduced and recorded — `upsertJobScheduler` failing while Redis is
         * healthy, after which this worker answers every round trip, refreshes this
         * file, reads healthy and never sweeps again.
         *
         * Asked last because it is the only one that costs a command against Redis
         * rather than reading a status, and because the three before it are what make
         * asking it safe: a command is only ever issued on a connection already known
         * to be ready.
         *
         * **Returning early rather than throwing**, exactly as the checks above do:
         * the file simply stops being refreshed and the container probe draws the
         * conclusion. That is the right place for it — one missed check during a
         * reconnection is not an unhealthy worker, and four consecutive ones are.
         */
        if (
          !allSchedulesRegistered(await scheduler.registered(), [
            EXPIRE_REQUESTS_SCHEDULER,
            RECONCILE_PAYMENTS_SCHEDULER,
          ])
        ) {
          logger.warn('health signal not refreshed', {
            reason: 'a maintenance schedule is not registered',
            scheduler: EXPIRE_REQUESTS_SCHEDULER,
          });
          return;
        }

        // `openSync` rather than `writeFileSync`'s `flag` option: the option is
        // typed `string` and the string flags have no spelling for `O_NOFOLLOW`,
        // so the numeric mask has to be passed to `open` itself.
        const file = openSync(HEALTH_FILE, HEALTH_FILE_FLAGS, HEALTH_FILE_MODE);
        try {
          writeFileSync(file, 'ok\n');
        } finally {
          closeSync(file);
        }
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

  /*
   * The scrape endpoint (slice H6). Started after the worker and the schedule exist,
   * so the first thing a scraper can read is a process that is already working.
   *
   * **Fired rather than awaited, and a failure is not fatal.** A port collision must
   * not stop the worker from sweeping: this endpoint exists so somebody can watch the
   * work, and losing the ability to watch is strictly better than losing the work.
   * The failure is loud in two places — an error line here, and `up == 0` in
   * Prometheus, which is the condition a scraper already knows how to alarm on.
   */
  const metricsServer = createMetricsServer({
    metrics,
    logger,
    port: workerEnv.WORKER_METRICS_PORT,
  });

  void metricsServer.listen().catch((error: unknown) => {
    logger.error('could not start the metrics endpoint; the worker continues', {
      port: workerEnv.WORKER_METRICS_PORT,
      error,
    });
  });

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
        /*
         * First, with the health signal: a draining container should stop answering
         * scrapes at about the moment it stops claiming to be healthy. It is bounded
         * internally, so a scraper holding a connection cannot delay the drain.
         */
        name: 'metrics endpoint',
        close: () => metricsServer.close(),
      },
      {
        /*
         * Before the worker, so no new scheduled job is minted while the consumer
         * is draining. Closing it releases one Redis connection and nothing else —
         * the schedule itself lives in Redis and survives.
         */
        name: 'schedule',
        close: () => scheduler.close(),
      },
      {
        name: 'maintenance worker',
        /*
         * `close()` stops taking new jobs and waits for in-flight ones;
         * `close(true)` skips the waiting. Which one is right is decided here,
         * at shutdown rather than at wiring, because it depends on whether
         * there has ever been a connection — see `drain.ts` for the rule and
         * the measurements behind it.
         */
        close: () => worker.close(hasNothingToDrain(backend.connection.status)),
      },
    ],
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('worker started', {
    queue: 'maintenance',
    handlers: [HEARTBEAT_JOB, EXPIRE_REQUESTS_JOB],
    apiBaseUrl: workerEnv.API_INTERNAL_URL,
    metricsPort: workerEnv.WORKER_METRICS_PORT,
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
