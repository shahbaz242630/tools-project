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
import {
  createLogger,
  createNoopMetrics,
  createPrometheusMetrics,
} from '@platform/observability';
import type { Logger } from '@platform/observability';
import { createPrismaClient, ping } from '@platform/database';
import type { PrismaClient } from '@platform/database';
import Redis from 'ioredis';
import { AppModule } from './app.module.js';
import { PostgresCheck } from './health/postgres.check.js';
import { RedisCheck } from './health/redis.check.js';
import { ClerkSessionVerifier } from './identity/clerk-session-verifier.js';
import { IdentityService } from './identity/identity.service.js';
import { AccountErasure } from './identity/account-erasure.js';
import { AccountDataService } from './identity/account-data.service.js';
import { AccountAdminService } from './identity/account-admin.service.js';
import { RoleApprovalService } from './identity/role-approval.service.js';
import { PrismaAdminApprovalStore } from './identity/prisma-admin-approval-store.js';
import { PrismaAuthenticationEvents } from './identity/prisma-authentication-events.js';
import {
  PrismaUserDirectory,
  PrismaWebhookLedger,
} from './identity/prisma-identity-store.js';
import { AuditService } from './audit/audit.service.js';
import { PrismaAuditLog } from './audit/prisma-audit-log.js';
import { createStateDigest } from './audit/state-digest.js';
import { NestLoggerAdapter } from './observability/nest-logger.js';
import { createFieldEncryptor } from './encryption/field-encryption.js';
import { PrismaProfileStore } from './profiles/prisma-profile-store.js';
import { ProfilesService } from './profiles/profiles.service.js';
import { CatalogueService } from './catalogue/catalogue.service.js';
import { PrismaCategoryStore } from './catalogue/prisma-category-store.js';
import { ListingsService } from './catalogue/listings.service.js';
import { LocationService } from './search-location/location.service.js';
import { PostcodesIoGeocoder } from './search-location/postcodes-io-geocoder.js';
import { PrismaListingSearch } from './search-location/prisma-listing-search.js';
import { PrismaListingStore } from './catalogue/prisma-listing-store.js';
import { FeatureFlagsService } from './feature-flags/feature-flags.service.js';
import { PrismaFeatureFlagStore } from './feature-flags/prisma-flag-store.js';
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

/**
 * How long shutdown may take before we stop being polite about it. Must stay
 * below the API container's `stop_grace_period`, or this never fires and the
 * orchestrator's SIGKILL decides the exit code instead.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Per-resource bound. Three closables at 3s each fit inside the backstop with
 * room to spare, and none of them has a legitimate reason to take longer:
 * draining in-flight HTTP requests is fast, and both clients are being dropped
 * rather than drained.
 */
const CLOSE_TIMEOUT_MS = 3_000;

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
  // eraser is the one direction that has to be late-bound.
  //
  // **Slice 2.5a is the "when listings hold personal data too" this comment used
  // to predict, and the prediction held: nothing inside the identity module
  // changed.** Two erasers compose into the one function below, and a second
  // export source sits beside the profile one. That is the whole return on
  // having made them ports rather than calls into `ProfilesService`.
  // The identity module is four services from slice H4, assembled here rather
  // than by a container. They share a directory, the audit trail and — for the
  // two that can delete an account — one erasure collaborator.
  const users = new PrismaUserDirectory(database);
  const authenticationEvents = new PrismaAuthenticationEvents(database);

  const erasure = new AccountErasure(
    users,
    audit,
    {
      // Sequential rather than `Promise.all`, deliberately. Erasure must be
      // idempotent and retryable, and running them in order means a failure in
      // the second leaves the first done — a retry then finishes the job. In
      // parallel, a rejection abandons the other mid-flight with no record of
      // how far it got.
      erase: async (actor) => {
        await profiles.eraseFor(actor);
        await listings.eraseFor(actor);
      },
    },
    authenticationEvents,
  );

  const identity: IdentityService = new IdentityService(
    users,
    new PrismaWebhookLedger(database),
    audit,
    authenticationEvents,
    erasure,
    logger.child({ module: 'identity' }),
  );

  const accountData = new AccountDataService(
    users,
    audit,
    { exportFor: (userId: string) => profiles.exportFor(userId) },
    { exportFor: (userId: string) => listings.exportFor(userId) },
    authenticationEvents,
    erasure,
  );

  const accountAdmin = new AccountAdminService(users, audit, {
    summaryFor: (userId: string) => profiles.adminSummaryFor(userId),
  });

  const roleApprovals = new RoleApprovalService(
    users,
    audit,
    new PrismaAdminApprovalStore(database),
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

  // Categories depend on nothing but the audit trail. Configuration has no
  // subject, so this half of Catalogue still needs neither the encryptor nor a
  // lookup into identity (BRD §5.1).
  const catalogue = new CatalogueService(
    new PrismaCategoryStore(database),
    audit,
    logger.child({ module: 'catalogue' }),
  );
  // One store, both ports. `PrismaListingStore` implements `ListingStore` and
  // `CategoryOptionSource` because both are reads of the same two tables through
  // the same client; the ports stay separate so a caller cannot reach the admin
  // projection of a category through the one that serves a form control.
  //
  // **The encryptor arrives here in slice 2.5a**, and it is the moment listings
  // stopped being ordinary content: a collection address is personal data, so
  // this store now encrypts street lines exactly as the profile store does, and
  // the service below answers both the eraser and the export.
  const listingStore = new PrismaListingStore(
    database,
    createFieldEncryptor(personalDataEnv.PERSONAL_DATA_ENCRYPTION_KEY),
  );
  // Search & Location opens here (BRD §5.1). It owns postcodes and coordinates;
  // Catalogue owns listings and asks it where a postcode is, through the port
  // `catalogue/listing-locator.ts` states — the same shape as Profiles asking
  // Identity whether an account is active.
  //
  // `globalThis.fetch` is left to the adapter's default. postcodes.io needs no
  // credentials at all, which is why this line carries none: it is ONS open data
  // behind a free, keyless API, so there is nothing to put in the secret manager
  // and nothing to rotate.
  const geocoder = new PostcodesIoGeocoder(logger.child({ module: 'search-location' }));

  const location = new LocationService(
    geocoder,
    logger.child({ module: 'search-location' }),
  );

  // The radius query (slice 3.1a, ADR 0044) — the one place in the system
  // holding hand-written SQL, because Prisma cannot express PostGIS (BRD §4.2).
  //
  // It takes the geocoder rather than the `LocationService` above, and that is
  // the boundary rather than a shortcut: a search origin is the *searcher's*
  // postcode, which is never stored and never published, so it needs none of the
  // fuzzing that service exists to guarantee. Handing it the service instead
  // would have meant widening `LocationService.geocode` to public, and its
  // docblock explains what happens next.
  const listingSearch = new PrismaListingSearch(
    database,
    geocoder,
    logger.child({ module: 'search-location' }),
  );

  // Feature flags open as their own module (slice H3a, ADR 0036). Built before
  // listings, because listings takes the kill switch as a port.
  const featureFlags = new FeatureFlagsService(
    new PrismaFeatureFlagStore(database),
    audit,
    logger.child({ module: 'feature-flags' }),
  );

  const listings = new ListingsService(
    listingStore,
    listingStore,
    /*
     * The locator port, answered by Search & Location. **Two methods, and the
     * pair is the §8.4.1 control** (slice 2.9b-ii): `locate` draws a listing's
     * fuzz offset and `relocate` reuses one it already has. Catalogue chooses
     * between them, because only Catalogue knows whether this listing has ever
     * been placed — and the choice being explicit at the call site is what stops
     * an edit quietly redrawing, which would leak the true address through the
     * mean of the points it published.
     */
    {
      locate: (postcode) => location.locate(postcode),
      relocate: (postcode, offset) => location.relocate(postcode, offset),
    },
    logger.child({ module: 'catalogue' }),
    // The port Catalogue declares, answered by the flags module — the same
    // shape as the locator above. One method rather than the whole service, so
    // a listing operation can ask whether publishing is on and can never
    // *switch* it (BRD §5.1, `publication-switch.ts`).
    { isPublicationEnabled: () => featureFlags.isEnabled('listing.publication') },
    // Moderation is the one administrative action this service performs
    // (slice 2.8c-i, ADR 0041), and ADR 0017 makes an unaudited one a failure.
    audit,
    /*
     * How a listing's owner lists, answered by Profiles (slice 2.13). One
     * method, so Catalogue can ask the one question §8.3 makes it responsible
     * for and cannot read a phone number or an address off a profile on the way
     * past — the narrowing every port across this boundary makes.
     */
    { findOwnerStatus: (userId) => profiles.findOwnerStatus(userId) },
    /*
     * Which listings are near a postcode (slice 3.1a). The second port Search &
     * Location answers, and the two are deliberately separate objects rather
     * than one geography service: the locator above is reachable only from write
     * paths and deals in a listing's own position, this is reachable only from
     * the public read and deals in ids and buckets. Neither can be used to do
     * the other's job.
     */
    {
      findWithin: (postcode, radiusMiles, limit) =>
        listingSearch.findWithin(postcode, radiusMiles, limit),
    },
  );

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      /*
       * Metrics are built here, in the composition root, so `prom-client` stays
       * out of the module graph exactly as `@clerk/backend` and Prisma do — and
       * so a test can boot the real application against a recording double
       * without a registry.
       *
       * Disabled collects nothing and still serves an empty exposition, which
       * tells a scraper "reachable, collecting nothing" rather than refusing the
       * connection.
       */
      metrics: env.METRICS_ENABLED
        ? createPrometheusMetrics({ service: 'api' })
        : createNoopMetrics(logger),
      checks: [
        // `ping` is bound to the client here rather than the check holding a
        // Prisma instance, so the check stays testable without one.
        new PostgresCheck({ ping: () => ping(database) }),
        new RedisCheck(redis),
      ],
      logger,
      identity: {
        sessionVerifier,
        service: identity,
        accountData,
        accountAdmin,
        roleApprovals,
        mfaBypassed: identityEnv.DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA,
      },
      profiles,
      audit,
      catalogue,
      featureFlags,
      listings,
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

  // Announced every boot, at warn, immediately after the line somebody actually
  // reads. `loadIdentityEnv` has already refused to start at all if this is set
  // in production, so reaching here means development or test — but a security
  // check that is off should still say so on every start rather than only in
  // the file that configured it.
  if (identityEnv.DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA) {
    logger.warn('ADMIN SECOND-FACTOR CHECK IS DISABLED', {
      variable: 'DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA',
      nodeEnv: env.NODE_ENV,
      effect:
        'every admin route admits an administrator with no verified second factor',
      why: 'Clerk gates MFA behind a paid plan (ADR 0030). Never set this anywhere real.',
    });
  }
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
    closeTimeoutMs: CLOSE_TIMEOUT_MS,
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
