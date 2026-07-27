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

export interface AppModuleOptions {
  /** Built in the composition root, so no provider SDK is imported here. */
  readonly checks: readonly DependencyCheck[];
  readonly logger: Logger;
  readonly readinessTimeoutMs?: number;
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
      controllers: [HealthController],
      providers: [
        ReadinessService,
        { provide: DEPENDENCY_CHECKS, useValue: options.checks },
        { provide: READINESS_LOGGER, useValue: options.logger },
        {
          provide: READINESS_TIMEOUT_MS,
          useValue: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        },
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
