import { Module, RequestMethod } from '@nestjs/common';
import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import type { Logger, Metrics } from '@platform/observability';
import { HealthController } from './health/health.controller.js';
import type { DependencyCheck } from './health/dependency-check.js';
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  DEPENDENCY_CHECKS,
  READINESS_LOGGER,
  READINESS_TIMEOUT_MS,
  ReadinessService,
} from './health/readiness.service.js';
import { CorrelationMiddleware } from './observability/correlation.middleware.js';
import {
  ADMIN_MFA_BYPASS,
  AUTH_LOGGER,
  AuthGuard,
  IDENTITY_SERVICE,
  SESSION_VERIFIER,
} from './identity/auth.guard.js';
import { AUDIT_SERVICE } from './audit/audit.tokens.js';
import { AdminActivityController } from './audit/admin-activity.controller.js';
import { MeActivityController } from './audit/me-activity.controller.js';
import type { AuditService } from './audit/audit.service.js';
import { AdminApprovalsController } from './identity/admin-approvals.controller.js';
import { AdminSuspensionController } from './identity/admin-suspension.controller.js';
import { AdminUserController } from './identity/admin-user.controller.js';
import { ClerkEventsController } from './identity/clerk-events.controller.js';
import { MeController } from './identity/me.controller.js';
import { MeDeletionController } from './identity/me-deletion.controller.js';
import { MeExportController } from './identity/me-export.controller.js';
import { MeSignInsController } from './identity/me-sign-ins.controller.js';
import type { IdentityService } from './identity/identity.service.js';
import type { AccountDataService } from './identity/account-data.service.js';
import type { AccountAdminService } from './identity/account-admin.service.js';
import type { RoleApprovalService } from './identity/role-approval.service.js';
import {
  ACCOUNT_ADMIN_SERVICE,
  ACCOUNT_DATA_SERVICE,
  ROLE_APPROVAL_SERVICE,
} from './identity/identity.tokens.js';
import type { SessionVerifier } from './identity/session-verifier.js';
import { MeProfileController } from './profiles/me-profile.controller.js';
import { PROFILES_SERVICE } from './profiles/profiles.tokens.js';
import { PublicProfileController } from './profiles/public-profile.controller.js';
import type { ProfilesService } from './profiles/profiles.service.js';
import { AdminCategoriesController } from './catalogue/admin-categories.controller.js';
import { AdminListingsController } from './catalogue/admin-listings.controller.js';
import { OwnerListingsController } from './catalogue/owner-listings.controller.js';
import { PublicListingsController } from './catalogue/public-listings.controller.js';
import { PublicListingSearchController } from './catalogue/public-listing-search.controller.js';
import { PublicCategoriesController } from './catalogue/public-categories.controller.js';
import { CATALOGUE_SERVICE, LISTINGS_SERVICE } from './catalogue/catalogue.tokens.js';
import { OwnerAvailabilityController } from './booking/owner-availability.controller.js';
import {
  AVAILABILITY_SERVICE,
  BOOKINGS_SERVICE,
  QUOTES_SERVICE,
} from './booking/booking.tokens.js';
import type { AvailabilityService } from './booking/availability.service.js';
import { QuotesController } from './booking/quotes.controller.js';
import { BookingsController } from './booking/bookings.controller.js';
import type { QuotesService } from './booking/quotes.service.js';
import type { BookingsService } from './booking/bookings.service.js';
import { AdminFeatureFlagsController } from './feature-flags/admin-feature-flags.controller.js';
import { FEATURE_FLAGS_SERVICE } from './feature-flags/feature-flags.tokens.js';
import type { FeatureFlagsService } from './feature-flags/feature-flags.service.js';
import type { CatalogueService } from './catalogue/catalogue.service.js';
import type { ListingsService } from './catalogue/listings.service.js';
import { MetricsController } from './observability/metrics.controller.js';
import { MetricsHook } from './observability/metrics.hook.js';
import { METRICS } from './observability/metrics.tokens.js';

export interface AppModuleOptions {
  /** Built in the composition root, so no provider SDK is imported here. */
  readonly checks: readonly DependencyCheck[];
  readonly logger: Logger;
  readonly readinessTimeoutMs?: number;

  /**
   * Where request timings go (slice H1).
   *
   * **Required, not optional**, for slice 2.1's reason: an optional dependency
   * is one that ten boot sites forget, and the one that forgets is the one in
   * production. A caller that genuinely wants no metrics passes
   * `createNoopMetrics()` and has said so.
   */
  readonly metrics: Metrics;

  /**
   * Identity, assembled outside for the same reason the checks are: it keeps
   * `@clerk/backend` and Prisma in `main.ts`, and it lets a test boot the real
   * application — real routing, real guard, real exception filter — against
   * fakes, with neither a database nor a Clerk instance.
   */
  readonly identity: {
    readonly sessionVerifier: SessionVerifier;
    /**
     * The mirror — sessions, provisioning and provider events.
     *
     * Named `service` still, after slice H4 split the class four ways, because
     * this is the one the guard resolves every request against. The three
     * beside it took a responsibility each.
     */
    readonly service: IdentityService;
    /** BRD §10.1's subject rights: export, sign-in history, deletion. */
    readonly accountData: AccountDataService;
    /** Administering somebody else's account: read, suspend, reinstate. */
    readonly accountAdmin: AccountAdminService;
    /** Role changes, which need two administrators (ADR 0023). */
    readonly roleApprovals: RoleApprovalService;

    /**
     * Admit an administrator with no verified second factor (ADR 0030).
     *
     * **Optional here, and defaulting to `false`, which is the one place in this
     * options object where an optional field is the right shape.** Slice 2.1's
     * rule — an optional dependency is one that ten boot sites forget — is about
     * dependencies whose absence breaks something. This one's absence is the
     * safe state, and the failure mode of forgetting it is that MFA is
     * *enforced*. `main.ts` passes it from an environment variable that
     * `loadIdentityEnv` refuses to accept in production at all.
     */
    readonly mfaBypassed?: boolean;
  };

  /**
   * Profiles, assembled outside for the same reasons as identity — and one
   * more: the address store needs an encryption key, and building it here would
   * put `PERSONAL_DATA_ENCRYPTION_KEY` in reach of every test that boots the
   * module.
   */
  readonly profiles: ProfilesService;

  /**
   * The audit trail. Assembled outside for the same reason as the rest — it
   * needs a key derived from PERSONAL_DATA_ENCRYPTION_KEY, and building it here
   * would put that secret in reach of every test that boots the module.
   */
  readonly audit: AuditService;

  /**
   * Categories and their versioned configuration. Assembled outside like
   * everything else, so a test can boot the real application against a fake
   * store with no database — which is what `categories.integration.test.ts`
   * does to prove the guard rather than to prove Prisma.
   */
  readonly catalogue: CatalogueService;

  /**
   * Listings, and the category options an owner picks from. Required rather than
   * optional, for the reason slice 2.1 learned when it made `catalogue`
   * required: an optional dependency is one that ten boot sites forget, and the
   * failure arrives as an undefined injection at request time rather than as a
   * compile error listing every place to fix.
   */
  readonly listings: ListingsService;

  /**
   * Feature flags and the kill switches §9 asks for (slice H3a, ADR 0036).
   *
   * Required for the reason `catalogue` and `listings` are. It is worse here
   * than for either of them if it is forgotten: an optional flag service would
   * boot an application whose kill switches were absent, and the way anybody
   * would find out is by reaching for one during an incident.
   */
  readonly featureFlags: FeatureFlagsService;

  /**
   * The owner's availability calendar (slice 4.3b).
   *
   * The first thing the Booking module puts on the wire. Assembled outside like
   * everything else, and required for the reason `listings` is: an optional
   * dependency is one that ten boot sites forget, and the failure arrives as an
   * undefined injection at request time rather than as a compile error listing
   * every place to fix.
   */
  readonly availability: AvailabilityService;

  /**
   * The quote engine (slice 4.4b, BRD §8.5.2).
   *
   * Required rather than optional, for the reason every dependency here is.
   */
  readonly quotes: QuotesService;

  /**
   * Requesting a booking (slice 4.5a, BRD §8.6).
   *
   * Required rather than optional, for the reason every dependency here is.
   */
  readonly bookings: BookingsService;
}

/**
 * Dependencies arrive from outside rather than being constructed here.
 *
 * It keeps `pg` and `ioredis` confined to `main.ts`, and it means a test can
 * boot the real application — real routing, real middleware, real exception
 * filter — against fakes, without a database.
 */
@Module({})
export class AppModule implements NestModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        // Unguarded, like the health routes and for a stronger reason: the API
        // is not reachable from the internet, CI asserts it, and Prometheus
        // scrapes this from inside the stack. See MetricsController.
        MetricsController,
        MeController,
        ClerkEventsController,
        MeDeletionController,
        MeExportController,
        MeSignInsController,
        MeProfileController,
        MeActivityController,
        AdminActivityController,
        AdminUserController,
        AdminApprovalsController,
        AdminSuspensionController,
        AdminCategoriesController,
        AdminFeatureFlagsController,
        OwnerListingsController,
        AdminListingsController,
        // The owner's calendar (slice 4.3b) — authenticated, owner-scoped, and
        // sitting with the other two for that reason rather than with the
        // public four below.
        OwnerAvailabilityController,
        QuotesController,
        BookingsController,
        // **Unguarded by design, all four**, and kept together at the end of
        // this list so the set is countable rather than scattered. BRD §2 gives
        // visitors public profiles; §8.17 makes listing pages crawlable, which
        // requires the same; §8.4 makes search the point of the whole product,
        // and from slice 3.2b makes its category filter usable without an
        // account. Each is a separate controller so the decision is visible
        // rather than looking like a missing decorator — see the docblock on
        // each class.
        //
        // **Anything added here is world-readable.** Four entries is still a
        // number somebody can check by eye at review time; that is the whole
        // reason they sit together, and it is why slice 3.1a added a class
        // rather than a second route to the one below it — and why 3.2b did the
        // same rather than hanging `/public/categories` off the search
        // controller it serves.
        //
        // **The two collections are the ones to watch.** Search returns rows for
        // an origin the caller picks; categories returns every row of a small
        // configuration table. The other two answer about one thing whose id the
        // caller had to already know. All four are unmetered until the WAF
        // exists (`SECURITY.md`), and the collections are what a limit lands on
        // first.
        PublicProfileController,
        PublicListingsController,
        PublicListingSearchController,
        PublicCategoriesController,
      ],
      providers: [
        ReadinessService,
        { provide: METRICS, useValue: options.metrics },
        // Registers a Fastify `onResponse` hook on boot, which measures every
        // route without anybody remembering to decorate one — including the
        // requests a guard refused, which a Nest interceptor never sees.
        MetricsHook,
        { provide: DEPENDENCY_CHECKS, useValue: options.checks },
        { provide: READINESS_LOGGER, useValue: options.logger },
        {
          provide: READINESS_TIMEOUT_MS,
          useValue: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        },

        // Registered as a provider rather than applied globally with
        // APP_GUARD. A global guard would also cover /health and /ready, and a
        // readiness probe that needs a session token is a readiness probe that
        // reports the service down whenever authentication is broken.
        AuthGuard,
        { provide: SESSION_VERIFIER, useValue: options.identity.sessionVerifier },
        { provide: IDENTITY_SERVICE, useValue: options.identity.service },
        { provide: ACCOUNT_DATA_SERVICE, useValue: options.identity.accountData },
        { provide: ACCOUNT_ADMIN_SERVICE, useValue: options.identity.accountAdmin },
        { provide: ROLE_APPROVAL_SERVICE, useValue: options.identity.roleApprovals },
        { provide: AUTH_LOGGER, useValue: options.logger },
        {
          provide: ADMIN_MFA_BYPASS,
          // `?? false` rather than the option being required: forgetting it
          // enforces MFA, which is the direction a mistake should fail in.
          useValue: options.identity.mfaBypassed ?? false,
        },

        { provide: PROFILES_SERVICE, useValue: options.profiles },
        { provide: AUDIT_SERVICE, useValue: options.audit },
        { provide: CATALOGUE_SERVICE, useValue: options.catalogue },
        { provide: LISTINGS_SERVICE, useValue: options.listings },
        { provide: FEATURE_FLAGS_SERVICE, useValue: options.featureFlags },
        { provide: AVAILABILITY_SERVICE, useValue: options.availability },
        { provide: QUOTES_SERVICE, useValue: options.quotes },
        { provide: BOOKINGS_SERVICE, useValue: options.bookings },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // Every route, including ones that do not exist yet — a request that 404s
    // still deserves a correlation id, because "the client called a URL we do
    // not serve" is exactly the kind of thing someone later needs to trace.
    consumer
      .apply(CorrelationMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
