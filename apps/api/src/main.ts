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
  loadMediaEnv,
  mediaStorageFrom,
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
import { RedisRateLimiter } from './rate-limiting/redis-rate-limiter.js';
import { ClerkSessionVerifier } from './identity/clerk-session-verifier.js';
import { composeSecondFactor } from './identity/compose-second-factor.js';
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
import { BookingDataService } from './booking/booking-data.service.js';
import { RequestExpiryService } from './booking/request-expiry.service.js';
import { PrismaListingSearch } from './search-location/prisma-listing-search.js';
import { PrismaListingStore } from './catalogue/prisma-listing-store.js';
import { PrismaListingMediaStore } from './catalogue/prisma-listing-media-store.js';
import { ListingMediaService } from './catalogue/listing-media.service.js';
import { R2ObjectStore } from './catalogue/r2-object-store.js';
import { MemoryObjectStore } from './catalogue/memory-object-store.js';
import { ListingImageSigner } from './catalogue/listing-image-signer.js';
import { assertDecodersAvailable } from './catalogue/prepare-image.js';
import { registerImageUploadParser } from './catalogue/image-upload-parser.js';
import { FeatureFlagsService } from './feature-flags/feature-flags.service.js';
import { PrismaFeatureFlagStore } from './feature-flags/prisma-flag-store.js';
import { LedgerService } from './payments/ledger.service.js';
import { NoPaymentProvider } from './payments/no-payment-provider.js';
import { PaymentsService } from './payments/payments.service.js';
import { ReconciliationService } from './payments/reconciliation.service.js';
import { PrismaLedgerStore } from './payments/prisma-ledger-store.js';
import { PrismaPaymentIntentStore } from './payments/prisma-payment-intent-store.js';
import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import { createShutdown } from '@platform/runtime';

/**
 * Two scalars back into a `Money` at the Booking to Payments seam (slice 5.2c).
 *
 * **The seam is where the two modules' own types meet**, and Booking states its
 * charge as plain numbers so it need not import `@platform/core`'s branded type
 * through a port. `Money.money` refuses a non-integer and an unsupported currency,
 * which is the check worth having on the one path where these figures become a
 * charge on somebody's card.
 */
function asMoney(value: {
  readonly amount: number;
  readonly currency: string;
}): MoneyValue {
  return Money.money(value.amount, value.currency as MoneyValue['currency']);
}

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

  // What may prove an administrator's second factor, **in the order asked**
  // (ADR 0021, ADR 0053). Clerk's `fva` claim first, because it is the real
  // one; the development exception last, so that on the day it is wrongly
  // installed the rule it replaces has still been evaluated and logged. The
  // chain short-circuits on the first prover that proves *within* the age
  // bound, so a stale real factor does not mask a fresh one.
  //
  // The exception is not added at all unless the flag is set, and
  // `loadIdentityEnv` refuses to load that flag under NODE_ENV=production — so
  // an environment that cannot set it cannot construct the adapter.
  const secondFactor = composeSecondFactor({
    allowWithoutSecondFactor: identityEnv.DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA,
    logger,
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
    /*
     * Booking's section (slice 4.8d) — the third module to hold personal data,
     * and the first that had an eraser without a source. Composed here like the
     * other two rather than injected into Identity, which owns the document and
     * deliberately owns none of its sections.
     */
    { exportFor: (userId: string) => bookingData.exportFor(userId) },
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
  /*
   * **One store, two consumers** (slice 5.2c). `CatalogueService` administers
   * categories; `findFeePolicyByVersionId` answers Payments' `CategoryFeePolicySource`
   * with the fee policy of one *pinned* version. The store is hoisted into a
   * variable so both reach the same instance rather than opening two.
   */
  const categoryStore = new PrismaCategoryStore(database);

  const catalogue = new CatalogueService(
    categoryStore,
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

  /*
   * A listing's photographs (slice 2.6b-i).
   *
   * **Built before `listings`, not beside `listingMedia` below** (slice
   * 2.6b-ii). The public read paths sign object keys, so `ListingsService`
   * takes a signer over this store — and a lazy delegate like the eraser's
   * would be reaching for a workaround where an ordering change does. Nothing
   * here depends on a listing.
   *
   * **The object store is chosen here and nowhere else**, which is the whole
   * point of a composition root: `mediaStorageFrom` returns null when no bucket
   * is configured, and that is a supported state meaning "run against memory".
   * Local development takes it, so a developer machine cannot write into the
   * bucket a deployed environment serves from — the object-storage form of the
   * rule that local development never shares a database. Under
   * `NODE_ENV=production` the same absence refuses to boot instead, because a
   * deployed environment that silently accepts no photographs and shows none
   * passes every health check.
   */
  const mediaStorage = mediaStorageFrom(loadMediaEnv());
  const objectStore =
    mediaStorage === null
      ? new MemoryObjectStore()
      : new R2ObjectStore(mediaStorage, logger.child({ module: 'catalogue' }));

  if (mediaStorage === null) {
    logger.warn('No object store is configured; photographs are held in memory', {
      // Not an error: it is the correct configuration for local development and
      // the only one it can have. It is a warning because the same line in a
      // deployed environment would be the explanation for every missing image.
      reason: 'media-storage-absent',
    });
  }

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
    /*
     * The media eraser, as a delegate rather than the object.
     *
     * `listingMedia` is built *below* this call, because it needs the same
     * listing store for ownership — so the reference is read at call time rather
     * than at construction. Erasure happens on a request, long after boot, so
     * the binding is always resolved by the time it runs.
     */
    { eraseForListings: (ids) => listingMedia.eraseForListings(ids) },
    /*
     * The signer, over the object store chosen above.
     *
     * **The signer rather than `objectStore` itself**: this service renders
     * photographs on two unguarded public reads and must never write or destroy
     * one, and `ObjectStore` carries `put` and `delete` beside `signedUrl`.
     */
    new ListingImageSigner(objectStore),
  );

  /*
   * **Fired at boot rather than at the first upload.** sharp ships a different
   * prebuilt libvips per platform and libc, and they do not carry identical
   * codec sets — so a runtime image with the wrong binary would accept an iPhone
   * photograph and refuse it as "not an image", which reads as the owner's fault
   * and is ours.
   */
  assertDecodersAvailable();

  const listingMedia = new ListingMediaService(
    listingStore,
    new PrismaListingMediaStore(database),
    objectStore,
    logger.child({ module: 'catalogue' }),
    metrics,
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

  /*
   * **Both methods of the port, handed over together** (slice 5.2c). `ownerOf`
   * joined `isOwnedBy` because paying a hire needs a payee and `bookings` keeps
   * no owner column — and it is answered by the *ownership* port rather than the
   * quotable one on purpose: an owner who pauses their listing after accepting a
   * booking must not thereby make the hire unpayable.
   */
  const listingOwnership = {
    isOwnedBy: (listingId: string, ownerId: string) =>
      listings.isOwnedBy(listingId, ownerId),
    ownerOf: (listingId: string) => listings.ownerOf(listingId),
  };

  const availability = new AvailabilityService(availabilityStore, listingOwnership);

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
  /*
   * Payments & Ledger is wired for the first time (slice 5.2c). 5.1 and 5.2b built
   * it deliberately unwired — a Nest token with no consumer is dead wiring — and
   * this is the slice that gives it one.
   *
   * **The ledger is constructed here and nothing else may write those tables.**
   * `PaymentsService` reaches them through `LedgerService`, which is what keeps a
   * future provider adapter from posting rows itself (ADR 0051).
   */
  const payments = new PaymentsService(
    new PrismaPaymentIntentStore(database),
    /*
     * **No production adapter exists yet — 5.2e builds it against Stripe**, and it
     * is the one piece of Phase 5 blocked on an external account.
     *
     * **The absence is named here rather than papered over.** `NoPaymentProvider`
     * throws on every call; what keeps it unreachable is the `booking.payment`
     * feature flag, which defaults off and which `BookingsService` checks before
     * it touches a booking's state. A provider that returned `failed` instead
     * would put a claim about somebody's card into the ledger and the booking's
     * history, and `PAYMENT_FAILED` is a state a renter cannot leave by fixing
     * anything.
     */
    new NoPaymentProvider(),
    new LedgerService(new PrismaLedgerStore(database)),
    /*
     * The **pinned** fee policy, answered by Catalogue (§8.2, slice 5.2b). Not the
     * current one: a booking keeps the terms it was made under, and today's
     * commission would pay an owner a rate nobody agreed to.
     */
    { findFeePolicy: (versionId) => categoryStore.findFeePolicyByVersionId(versionId) },
  );

  /*
   * **The reconciliation sweep** (slice 5.4a). It shares `PaymentsService` rather
   * than reaching the provider itself: `refresh` already owns the decision about
   * what an outcome may do to an attempt, and a second caller re-deciding it would
   * be two places that can disagree about whether money is recorded.
   *
   * **Its own `PrismaPaymentIntentStore`, deliberately.** The one above is held
   * privately by `PaymentsService`; handing the sweep a second instance costs
   * nothing — the adapter is stateless over a shared client — and keeps the seam
   * honest, because the sweep genuinely is a different caller with a different
   * query.
   */
  const reconciliation = new ReconciliationService(
    new PrismaPaymentIntentStore(database),
    payments,
    logger,
  );

  const bookings = new BookingsService(
    bookingStore,
    quoteStore,
    quotableListings,
    availabilityStore,
    /*
     * Taking the money, answered by Payments (slice 5.2c) — narrowed to one method
     * at the seam like every other port across a module boundary. Booking states
     * its own request and result shapes, so a field added on one side and
     * forgotten on the other fails to compile *here*.
     */
    {
      chargeForHire: async (request) => {
        const outcome = await payments.payForHire({
          bookingId: request.bookingId,
          ownerId: request.ownerId,
          categoryVersionId: request.categoryVersionId,
          itemTitle: request.itemTitle,
          charge: {
            itemCharge: asMoney(request.itemCharge),
            renterFee: asMoney(request.renterFee),
            total: asMoney(request.total),
          },
        });

        return {
          status:
            outcome.intent.status === 'initiated'
              ? 'processing'
              : outcome.intent.status,
          ...(outcome.payerAction === undefined
            ? {}
            : { payerAction: outcome.payerAction }),
          ...(outcome.intent.failure === undefined
            ? {}
            : { failureMessage: outcome.intent.failure.message }),
        };
      },
    },
    listingOwnership,
    { isPaymentEnabled: () => featureFlags.isEnabled('booking.payment') },
    /*
     * Securing the handover, answered by Payments (slice 5.5c-ii) — narrowed to
     * one method at the seam, like the charge above and for the same reason.
     *
     * **The translation of `kind` into `status` is where the two vocabularies
     * meet, and it is deliberately not a pass-through.** Payments answers *what it
     * did* — `not_required`, or `attempted` with an intent that has its own
     * status — and Booking asks *how did securing this handover turn out*. Only
     * `failed` may move a booking to `SECURITY_FAILED`, so `initiated` and
     * `processing` collapse to `pending_payer_action`: both mean the hold is
     * unfinished, and unfinished is not failed.
     */
    {
      holdForCollection: async (request) => {
        const outcome = await payments.holdDamageSecurity({
          bookingId: request.bookingId,
          ownerId: request.ownerId,
          categoryVersionId: request.categoryVersionId,
          itemTitle: request.itemTitle,
          excess: request.excess === null ? null : asMoney(request.excess),
        });

        if (outcome.kind === 'not_required') return { status: 'not_required' };

        const { intent } = outcome;

        if (intent.status === 'succeeded') return { status: 'held' };

        if (intent.status === 'failed') {
          return {
            status: 'failed',
            ...(intent.failure === undefined
              ? {}
              : { failureMessage: intent.failure.message }),
          };
        }

        return {
          status: 'pending_payer_action',
          ...(outcome.payerAction === undefined
            ? {}
            : { payerAction: outcome.payerAction }),
        };
      },
    },
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

  /*
   * Booking's half of §10.1 (slice 4.8d). It shares both stores above, for the
   * reason every service in this module shares them: a second instance would be a
   * second view of the same rows, and a data export that disagreed with the
   * dashboards about what somebody had booked is the one place that cannot be
   * shrugged off.
   *
   * **Constructed before `accountData` needs it**, which is why it lives here
   * rather than beside the other Booking services — `main.ts` is a composition
   * root and the order is the dependency order.
   */
  const bookingData = new BookingDataService(bookingStore, quoteStore);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      // The same instance the services above were given (slice 3.1f). One
      // registry, or the HTTP hook and the search counter end up in different
      // expositions and only one of them is scraped.
      metrics,

      /*
       * **The one Redis connection, reused rather than a second one opened**
       * (slice H7a). `RedisRateLimiter` takes a narrow interface for the reason
       * every adapter here does — `no-provider-sdk-outside-adapter` names this
       * file as the only one in the API allowed to import `ioredis`, so the
       * composition root constructs the client and hands out capabilities.
       *
       * **Sharing the connection with BullMQ's broker is deliberate and worth
       * one line of thought.** The limiter issues `INCR`, `EXPIRE` and `TTL` —
       * none blocking — so it cannot occupy the connection the way a blocking
       * queue read would. It is the queue that needs its own client, and the
       * worker has one.
       */
      rateLimiter: new RedisRateLimiter(redis),
      rateLimits: {
        read: env.RATE_LIMIT_READ_PER_MINUTE,
        write: env.RATE_LIMIT_WRITE_PER_MINUTE,
      },

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
        secondFactor,
      },
      profiles,
      audit,
      catalogue,
      featureFlags,
      listings,
      listingMedia,
      availability,
      quotes,
      bookings,
      requestExpiry,
      reconciliation,
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

  // Image uploads arrive as raw bytes. The registration lives in the catalogue
  // module so that the tests exercise the same code this line does — see
  // `image-upload-parser.ts` for why that mattered.
  registerImageUploadParser(app.getHttpAdapter().getInstance());

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
