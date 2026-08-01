import { Module, RequestMethod } from '@nestjs/common';
import type { DynamicModule, MiddlewareConsumer, NestModule } from '@nestjs/common';
import type { Logger } from '@platform/observability';
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
import type { IdentityService } from './identity/identity.service.js';
import type { SessionVerifier } from './identity/session-verifier.js';
import { MeProfileController } from './profiles/me-profile.controller.js';
import { PROFILES_SERVICE } from './profiles/profiles.tokens.js';
import { PublicProfileController } from './profiles/public-profile.controller.js';
import type { ProfilesService } from './profiles/profiles.service.js';

export interface AppModuleOptions {
  /** Built in the composition root, so no provider SDK is imported here. */
  readonly checks: readonly DependencyCheck[];
  readonly logger: Logger;
  readonly readinessTimeoutMs?: number;

  /**
   * Identity, assembled outside for the same reason the checks are: it keeps
   * `@clerk/backend` and Prisma in `main.ts`, and it lets a test boot the real
   * application — real routing, real guard, real exception filter — against
   * fakes, with neither a database nor a Clerk instance.
   */
  readonly identity: {
    readonly sessionVerifier: SessionVerifier;
    readonly service: IdentityService;
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
        MeController,
        ClerkEventsController,
        MeDeletionController,
        MeExportController,
        MeProfileController,
        MeActivityController,
        AdminActivityController,
        AdminUserController,
        AdminApprovalsController,
        AdminSuspensionController,
        // Unguarded by design — BRD §2 gives visitors public profiles. It is a
        // separate controller so that decision is visible rather than looking
        // like a missing decorator. See PublicProfileController.
        PublicProfileController,
      ],
      providers: [
        ReadinessService,
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
        { provide: AUTH_LOGGER, useValue: options.logger },

        { provide: PROFILES_SERVICE, useValue: options.profiles },
        { provide: AUDIT_SERVICE, useValue: options.audit },
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
