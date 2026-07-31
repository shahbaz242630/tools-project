import 'reflect-metadata';

import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { verifyToken } from '@clerk/backend';
import {
  describeEnv,
  loadEnv,
  loadIdentityEnv,
  loadPersonalDataEnv,
} from '@platform/config';
import { createLogger } from '@platform/observability';
import type { Logger } from '@platform/observability';
import { createPrismaClient, ping } from '@platform/database';
import type { PrismaClient } from '@platform/database';
import Redis from 'ioredis';
import { AppModule } from './app.module.js';
import { PostgresCheck } from './health/postgres.check.js';
import { RedisCheck } from './health/redis.check.js';
import { ClerkSessionVerifier } from './identity/clerk-session-verifier.js';
import { IdentityService } from './identity/identity.service.js';
import {
  PrismaUserDirectory,
  PrismaWebhookLedger,
} from './identity/prisma-identity-store.js';
import { AuditService } from './audit/audit.service.js';
import { PrismaAuditLog } from './audit/prisma-audit-log.js';
import { createStateDigest } from './audit/state-digest.js';
import { NestLoggerAdapter } from './observability/nest-logger.js';
import { createFieldEncryptor } from './profiles/field-encryption.js';
import { PrismaProfileStore } from './profiles/prisma-profile-store.js';
import { ProfilesService } from './profiles/profiles.service.js';
import { createShutdown } from '@platform/runtime';

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

  // Separate from loadEnv because the worker shares that schema and has no
  // business holding identity configuration. Loaded here, immediately, so a
  // missing key still fails at startup naming the variable rather than at the
  // first authenticated request.
  const identityEnv = loadIdentityEnv();

  // Separate again, and for the same reason: the worker has no business holding
  // a key that decrypts home addresses. Loaded at startup so a missing or
  // wrong-length key names the variable here rather than throwing inside a
  // cipher on whichever request first saves an address.
  const personalDataEnv = loadPersonalDataEnv();

  const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });

  // One client, one pool. Prisma 7 connects through a `pg` driver adapter, so
  // this is the same driver the raw PostGIS queries will use later (BRD §4.2)
  // rather than a second pool alongside it.
  const database = createPrismaClient({ connectionString: env.databaseUrl });

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

  // Networkless: `jwtKey` is a public key held in memory, so verifying a
  // session performs no I/O and a Clerk outage cannot hang an authenticated
  // request. See CLERK_JWT_PUBLIC_KEY in @platform/config for why the API is
  // not given the secret key that would make this a network call instead.
  const sessionVerifier = new ClerkSessionVerifier({
    verifyToken,
    jwtKey: identityEnv.CLERK_JWT_PUBLIC_KEY,
    authorizedParties: identityEnv.CLERK_AUTHORIZED_PARTIES,
  });

  // Built before identity and profiles, because both write to it. Its digest
  // key is derived from the same master secret that encrypts addresses, with a
  // distinct purpose string — one secret to operate, two independent keys.
  const audit = new AuditService(
    new PrismaAuditLog(database),
    createStateDigest(personalDataEnv.PERSONAL_DATA_ENCRYPTION_KEY),
  );

  // Declared before `profiles` exists so the two can reference each other; the
  // eraser is the one direction that has to be late-bound. When listings and
  // messages hold personal data too, several erasers compose into this one
  // function and nothing inside the identity module changes.
  const identity: IdentityService = new IdentityService(
    new PrismaUserDirectory(database),
    new PrismaWebhookLedger(database),
    audit,
    { erase: (actor) => profiles.eraseFor(actor) },
    { exportFor: (userId) => profiles.exportFor(userId) },
  );

  const profiles: ProfilesService = new ProfilesService(
    new PrismaProfileStore(
      database,
      createFieldEncryptor(personalDataEnv.PERSONAL_DATA_ENCRYPTION_KEY),
    ),
    // The profiles module's `AccountLookup` port, answered by the identity
    // service. An adapter rather than a direct dependency: Profiles & Trust
    // states the question it has, Identity & Access answers it, and neither
    // imports the other's internals (BRD §5.1).
    {
      findActive: async (userId) => {
        const user = await identity.findActiveById(userId);
        return user === null ? null : { id: user.id, createdAt: user.createdAt };
      },
    },
    audit,
  );

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      checks: [
        // `ping` is bound to the client here rather than the check holding a
        // Prisma instance, so the check stays testable without one.
        new PostgresCheck({ ping: () => ping(database) }),
        new RedisCheck(redis),
      ],
      logger,
      identity: { sessionVerifier, service: identity },
      profiles,
      audit,
    }),
    new FastifyAdapter(),
    { logger: new NestLoggerAdapter(logger) },
  );

  await app.register(helmet);

  installShutdownHandlers(app, database, redis, logger);

  await app.listen({ port: env.API_PORT, host: env.API_HOST });

  logger.info('api listening', {
    host: env.API_HOST,
    port: env.API_PORT,
    ...describeEnv(env),
  });
}

function installShutdownHandlers(
  app: NestFastifyApplication,
  database: PrismaClient,
  redis: Redis,
  logger: Logger,
): void {
  const shutdown = createShutdown({
    logger,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    // Stop accepting work first, then release what in-flight requests needed.
    closables: [
      { name: 'http server', close: () => app.close() },
      { name: 'database', close: () => database.$disconnect() },
      {
        name: 'redis',
        close: async () => {
          // `quit()` sends a command, so it rejects outright if the client
          // never connected — the normal state during a Redis outage.
          // `disconnect()` just drops the socket and always succeeds.
          try {
            await redis.quit();
          } catch {
            redis.disconnect();
          }
        },
      },
    ],
  });

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
