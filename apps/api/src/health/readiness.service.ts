import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@platform/observability';
import { runCheck } from './dependency-check.js';
import type { DependencyCheck, DependencyStatus } from './dependency-check.js';

export const DEPENDENCY_CHECKS = Symbol('DEPENDENCY_CHECKS');
export const READINESS_LOGGER = Symbol('READINESS_LOGGER');
export const READINESS_TIMEOUT_MS = Symbol('READINESS_TIMEOUT_MS');

/**
 * How long a single dependency has to answer.
 *
 * Not environment configuration: it is an engineering constant about how long a
 * load balancer should wait, not a business rule that changes without a deploy.
 * It is injected rather than read inline so the timeout path is testable.
 */
export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, DependencyStatus>>;
}

@Injectable()
export class ReadinessService {
  constructor(
    @Inject(DEPENDENCY_CHECKS)
    private readonly checks: readonly DependencyCheck[],
    @Inject(READINESS_LOGGER) private readonly logger: Logger,
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  async report(): Promise<ReadinessReport> {
    // Concurrently, so the endpoint costs the slowest dependency rather than
    // their sum. `runCheck` resolves rather than rejecting, so one broken
    // dependency cannot hide the status of the others.
    const results = await Promise.all(
      this.checks.map((check) => runCheck(check, this.timeoutMs)),
    );

    const checks: Record<string, DependencyStatus> = {};
    for (const result of results) {
      checks[result.name] = result.status;

      // The detail goes here and nowhere else. A driver error names hosts,
      // ports and users, and sometimes the whole connection string; the logger
      // redacts it, the response body could not.
      if (result.status !== 'ok') {
        this.logger.error('readiness check failed', {
          dependency: result.name,
          status: result.status,
          timeoutMs: this.timeoutMs,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
      }
    }

    return {
      ready: results.every((result) => result.status === 'ok'),
      checks,
    };
  }
}
