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
  createNoopErrorTracker,
  createNoopMetrics,
  createPrometheusMetrics,
  installProcessHandlers,
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
import { PrismaBookingStore } from './booking/prisma-booking-store.js';
import { PrismaAvailabilityStore } from './booking/prisma-availability-store.js';
import { AvailabilityService } from './booking/availability.service.js';
import { PrismaQuoteStore } from './booking/prisma-quote-store.js';
import { QuotesService } from './booking/quotes.service.js';
import { BookingsService } from './booking/bookings.service.js';
import { RequestExpiryService } from './booking/request-expiry.service.js';
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

  /*
   * The error-tracking seam, installed rather than merely built.
   *
   * ADR 0008 defers the *provider* — there is no Sentry account, and an adapter
   * that cannot be exercised is worse than none. It never deferred the call
   * site, and until 15 August 2026 there was not one: an unhandled rejection or
   * an uncaught exception ended this process with a raw stack trace on stdout,
   * unstructured, uncorrelated and unredacted, and there was nowhere for a real
   * adapter to be swapped in even once we had one.
   *
   * The noop adapter is a real adapter (see its docblock) — errors reach the
   * logger, which is where every other diagnostic already goes.
   */
  const errorTracker = createNoopErrorTracker(logger);
  installProcessHandlers(logger, errorTracker, {
    onFatal: () => {
      /*
       * Exit non-zero, which is what happened before these handlers existed and
       * is what `restart: unless-stopped` reads as "crashed". Continuing from an
       * uncaught exception means serving requests from a process whose state
       * nobody can describe.
       *
       * Exiting in the same tick as the log line is safe *here*: `process.stdout`
       * is a pipe to the Docker daemon, and Node documents pipe writes as
       * synchronous on Linux. On macOS they are not, so a fatal error on a
       * developer's laptop may lose its final line — which is the one place it
       * is also on screen.
       */
      process.exit(1);
    },
  });

  /*
   * Metrics are built here, in the composition root, so `prom-client` stays out
   * of the module graph exactly as `@clerk/backend` and Prisma do — and so a
   * test can boot the real application against a recording double without a
   * registry.
   *
   * Disabled collects nothing and still serves an empty exposition, which tells
   * a scraper "reachable, collecting nothing" rather than refusing the
   * connection.
   *
   * **It moved up here from `AppModule.register` in slice 3.1f**, and the reason
   * is worth a line: until then the only thing recording was a Fastify hook,
   * which Nest owns, so building it inside the module options was enough. Search
   * telemetry records from inside application services, which are constructed
   * below — and **there must be exactly one registry**, or a service and the
   * HTTP hook would each hold their own and only one of them would be scraped.
   */
  const metrics = env.METRICS_ENABLED
    ? createPrometheusMetrics({ service: 'api' })
    : createNoopMetrics(logger);

  // One client, one pool. Prisma 7 connects through a `pg` driver adapter, so
  // this is the same driver the raw PostGIS queries will use later (BRD §4.2)
  // rather than a second pool alongside it.
  const database = createPrismaClient({ connectionString: env.databaseUrl });

  /*
   * ioredis 6 negotiates RESP3 by default, and this client is left on that
   * default deliberately rather than pinned back to `protocol: 2`.
   *
   * It issues exactly one command — `PING`, for the readiness check — and the
   * reply is the identical string `PONG` under both protocols, measured against
   * Redis 7 rather than assumed. A pin with no failure behind it is a line
   * nobody can later tell from a real constraint.
   *
   * What does change between the two is the shape of a *map* reply — `HGETALL`,
   * `CONFIG GET`, `XRANGE` — so a second command here is a reason to check
   * again, not to trust this note.
   */
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
        /*
         * **Three erasers now, and this one is the first from Booking** (slice
         * 4.4b). A quote holds the renter's postcode, and the `ON DELETE
         * CASCADE` on `quotes.renterId` does *not* discharge the obligation:
         * accounts are soft-deleted with a tombstoned email (ADR 0018), so the
         * `users` row survives and the cascade never fires.
         *
         * Last in the sequence because it is the cheapest and the least
         * consequential — the two above remove things other people have seen.
         */
        await quotes.eraseFor(actor.userId);
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
    metrics,
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
  // Bookings (slice 4.2). Built before listings, because listings takes the
  // booking-references port — the same ordering feature flags already needed.
  const bookingStore = new PrismaBookingStore(database);

  const listingSearch = new PrismaListingSearch(
    database,
    geocoder,
    logger.child({ module: 'search-location' }),
    metrics,
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
     * How a listing's owners list, answered by Profiles (slice 2.13). One
     * method, so Catalogue can ask the one question §8.3 makes it responsible
     * for and cannot read a phone number or an address off a profile on the way
     * past — the narrowing every port across this boundary makes.
     *
     * **The port went plural in the August 2026 audit remediation**, because
     * asking per listing was an N+1 on the search results page. Catalogue asks
     * once per page and Profiles answers with one `findMany`, so the round trip
     * count no longer grows with the number of distinct owners on a page.
     *
     * **It was briefly half done, and that is worth remembering rather than
     * tidying away.** The first pass made the port plural while this adapter
     * still fanned out over a singular `findOwnerStatus`, which moved the cost
     * from Catalogue into Profiles instead of removing it — a shape that reads
     * as fixed in every assertion about returned data, because only the query
     * *count* changes. `InMemoryProfileStore.ownerStatusLookups` exists so a
     * test can assert the count and stop it coming back.
     */
    { findOwnerStatuses: (userIds) => profiles.findOwnerStatuses(userIds) },
    /*
     * Which listings are near a postcode (slice 3.1a). The second port Search &
     * Location answers, and the two are deliberately separate objects rather
     * than one geography service: the locator above is reachable only from write
     * paths and deals in a listing's own position, this is reachable only from
     * the public read and deals in ids and buckets. Neither can be used to do
     * the other's job.
     */
    /*
     * **Passed straight through, and from slice 3.2a that is a property rather
     * than a convenience.** `ProximitySearch` and `NearbySearch` are structurally
     * identical by design — one module states what it needs, the other states
     * what it offers, and neither imports the other (BRD §5.1). Handing the
     * object over whole means a field added to one and forgotten on the other
     * fails to compile here, at the seam, rather than silently arriving as
     * `undefined` in the SQL.
     */
    { findWithin: (search) => listingSearch.findWithin(search) },
    // What a search did (slice 3.1f). The same instance the geocoder above was
    // given and the same one the HTTP hook records into — see the note where it
    // is built.
    metrics,
    /*
     * Which listings a booking points at (slice 4.2), answered by Booking.
     *
     * **Narrowed to one method, like the three ports above it**, so the erasure
     * path cannot reach further into another module's bookings than the one
     * question it is entitled to ask. It is the only thing Catalogue knows about
     * bookings at all.
     */
    { findBookedListings: (ids) => bookingStore.findBookedListings(ids) },
  );

  /*
   * The owner's calendar (slice 4.3b). Built *after* listings, because it takes
   * the ownership port they answer — the mirror of the ordering above, where
   * listings had to be built after bookings for `findBookedListings`.
   *
   * **`isOwnedBy` narrowed to one method at the seam**, like every other port
   * across this boundary. It is the first one Booking declares and Catalogue
   * answers; the three before it all pointed the other way. A boolean is the
   * whole answer, so the calendar cannot reach a collection address through it
   * — see `existsOwnedBy`, which reads one column rather than decrypting one.
   */
  const availabilityStore = new PrismaAvailabilityStore(database);

  const availability = new AvailabilityService(availabilityStore, {
    isOwnedBy: (listingId, ownerId) => listings.isOwnedBy(listingId, ownerId),
  });

  /*
   * The quote engine (slice 4.4b). Built after listings for the same reason the
   * calendar is: it takes a port they answer.
   *
   * **`findQuotable` narrowed to one method at the seam**, the second port
   * Booking declares and Catalogue answers. What crosses is rates, the current
   * fee policy, the current duration cap and the version id they came from — and
   * pointedly not a title, a description or an address, so a module whose subject
   * is dates and money cannot hold one.
   *
   * **It is given the availability *store*, not the service**, and the same
   * instance the calendar has. Every method on that service is owner-scoped, and
   * a renter asking for a price owns nothing; `reasonUnavailable` is the one
   * question on the store that is not about whose calendar it is.
   */
  const quoteStore = new PrismaQuoteStore(database);
  const quotableListings = {
    findQuotable: (listingId: string) => listings.findQuotable(listingId),
  };

  const quotes = new QuotesService(quoteStore, quotableListings, availabilityStore);

  /*
   * The request path (slice 4.5a) — the first thing here that makes something
   * bookable.
   *
   * **It shares the quote store and the listing port with the quote engine**,
   * deliberately: a request is made *from* a quote, so reading one through a
   * second instance would be two views of the same rows. It shares the
   * availability store with the calendar for the reason 4.4b gives.
   */
  const bookings = new BookingsService(
    bookingStore,
    quoteStore,
    quotableListings,
    availabilityStore,
  );

  /*
   * The expiry sweep (slice 4.7a). Its own service, sharing the one booking store
   * above for the same reason `bookings` shares the availability store: two
   * instances would be two views of the same rows.
   *
   * It is set off from outside — `apps/worker` holds the schedule (4.7b) — so
   * nothing here starts a timer. That is deliberate: a sweep on an interval inside
   * the request-serving process is a second scheduler nobody registered, and it
   * would keep running after the worker's own was turned off.
   */
  const requestExpiry = new RequestExpiryService(bookingStore, logger);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      // The same instance the services above were given (slice 3.1f). One
      // registry, or the HTTP hook and the search counter end up in different
      // expositions and only one of them is scraped.
      metrics,
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
      availability,
      quotes,
      bookings,
      requestExpiry,
      internalTriggerSecret: env.INTERNAL_TRIGGER_SECRET,
    }),
    /*
     * **One hop, not all of them, and not none.**
     *
     * Fastify's default is `trustProxy: false`, under which `request.ip` is the
     * socket peer — and this API's socket peer is *always* the web container,
     * because only `web` joins the edge network and every call arrives
     * server-side. So the default makes `request.ip` a constant, which is
     * harmless while nothing reads it and quietly wrong for the first thing that
     * does. That thing is already named: BRD §10 requires rate limiting by IP,
     * and `@fastify/rate-limit` keys on `request.ip`, so under the default the
     * entire internet would share one bucket and the limit would fire on the
     * hundredth honest visitor.
     *
     * `true` is the answer most examples give and it means "believe the whole
     * `X-Forwarded-For` chain". That is only ever correct while the topology
     * holds, and it fails open: the day this API is reachable by anything else,
     * every address it records is whatever the caller typed. `1` trusts exactly
     * the nearest hop and takes the **last** entry, which is the same rule
     * ADR 0017 wrote down for `clientIpFrom` in the web app, for the same reason
     * — the first entry is attacker-supplied, the last is what a proxy we run
     * observed.
     *
     * **This changes nothing that is recorded today**, and that is the point of
     * doing it now rather than later. The web app does not forward
     * `X-Forwarded-For` at all: it resolves the address itself and sends
     * `x-client-ip`, a single-valued header the guard reads and the audit log
     * stores (ADR 0017). With no `X-Forwarded-For` present, proxy-addr returns
     * the socket address exactly as before. What this settles is what happens
     * the day a header does arrive — before something depends on the answer.
     */
    new FastifyAdapter({ trustProxy: 1 }),
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
