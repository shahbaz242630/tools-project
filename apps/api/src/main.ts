import 'reflect-metadata';

import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { describeEnv, loadEnv } from '@platform/config';
import { createLogger } from '@platform/observability';
import type { Logger } from '@platform/observability';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { AppModule } from './app.module.js';
import { PostgresCheck } from './health/postgres.check.js';
import { RedisCheck } from './health/redis.check.js';
import { NestLoggerAdapter } from './observability/nest-logger.js';

/**
 * Composition root.
 *
 * The only file that imports a provider SDK. Everything downstream depends on
 * the narrow interfaces in `health/`, so swapping a client is a change here and
 * nowhere else.
 *
 * Kept deliberately thin and excluded from coverage: a test that asserts wiring
 * by mocking every constructor tests the mock, not the wiring. The integration
 * test boots the real application instead.
 */

/** How long shutdown may take before we stop being polite about it. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function bootstrap(): Promise<void> {
  // Before the logger exists, because the logger's level comes from here. A
  // bad environment must be loud and immediate: the message names every
  // problem at once, and stderr is the only channel available this early.
  const env = loadEnv();

  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });

  const pool = new Pool({
    connectionString: env.databaseUrl,
    // Bounded so a dead database surfaces as a failed readiness check rather
    // than a connection attempt that never returns.
    connectionTimeoutMillis: 5_000,
  });

  const redis = new Redis(env.redisUrl, {
    maxRetriesPerRequest: 1,
    // Without this, a command issued while disconnected queues silently and
    // the readiness probe waits instead of reporting the outage.
    enableOfflineQueue: false,
  });

  // ioredis emits 'error' on every reconnection attempt. Unhandled, these crash
  // the process; the readiness check is what decides whether the outage
  // matters, so record and continue.
  redis.on('error', (error: Error) => {
    logger.warn('redis client error', { error });
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      checks: [new PostgresCheck(pool), new RedisCheck(redis)],
      logger,
    }),
    new FastifyAdapter(),
    { logger: new NestLoggerAdapter(logger) },
  );

  await app.register(helmet);

  installShutdownHandlers(app, pool, redis, logger);

  await app.listen({ port: env.API_PORT, host: env.API_HOST });

  logger.info('api listening', {
    host: env.API_HOST,
    port: env.API_PORT,
    ...describeEnv(env),
  });
}

function installShutdownHandlers(
  app: NestFastifyApplication,
  pool: Pool,
  redis: Redis,
  logger: Logger,
): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    // A second SIGTERM during shutdown is an operator losing patience, not a
    // reason to start closing everything twice.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('shutdown requested', { signal });

    // If a connection refuses to drain, exiting late is better than never:
    // an orchestrator will SIGKILL us anyway, and doing it ourselves keeps the
    // exit code honest.
    const forceExit = setTimeout(() => {
      logger.error('shutdown timed out, exiting', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    void (async (): Promise<void> => {
      try {
        // Stop accepting first, then release what in-flight requests needed.
        await app.close();
        await pool.end();
        await redis.quit();
        logger.info('shutdown complete', { signal });
        process.exit(0);
      } catch (error) {
        logger.error('shutdown failed', { signal, error });
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void bootstrap().catch((error: unknown) => {
  // The logger may not exist yet — this catches configuration failures too —
  // so write directly. `console` is banned project-wide because it bypasses
  // redaction; `process.stderr` is the deliberate exception at the one point
  // where no logger can be guaranteed.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
