import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
// Not `import type`: with emitDecoratorMetadata, Nest resolves this dependency
// from the emitted design:paramtypes, and a type-only import erases it. The
// result compiles cleanly and fails at runtime. See ADR 0011.
import { ReadinessService } from './readiness.service.js';
import type { DependencyStatus } from './dependency-check.js';

export interface HealthResponse {
  readonly status: 'ok';
}

export interface ReadyResponse {
  readonly status: 'ready' | 'not_ready';
  readonly checks: Readonly<Record<string, DependencyStatus>>;
}

@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /**
   * Liveness. Deliberately depends on nothing.
   *
   * If this checked the database, a database outage would make the orchestrator
   * conclude the process is dead and restart it — turning a recoverable
   * dependency failure into a restart loop that guarantees an outage.
   */
  @Get('health')
  health(): HealthResponse {
    return { status: 'ok' };
  }

  /**
   * Readiness. Should this instance receive traffic right now?
   *
   * 503 with a per-dependency status, never with the underlying error: the
   * detail is logged instead. See `ReadinessService`.
   */
  @Get('ready')
  async ready(): Promise<ReadyResponse> {
    const report = await this.readiness.report();

    if (!report.ready) {
      throw new HttpException(
        { status: 'not_ready', checks: report.checks } satisfies ReadyResponse,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status: 'ready', checks: report.checks };
  }
}
