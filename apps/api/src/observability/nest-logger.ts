import type { LoggerService } from '@nestjs/common';
import type { LogFields, Logger } from '@platform/observability';

/**
 * Routes NestJS's internal logging through `@platform/observability`.
 *
 * Nest's default logger writes coloured, multi-line text straight to stdout.
 * That bypasses redaction entirely, which is the problem: Nest logs the request
 * URL on an unhandled error, and a URL can carry a postcode or a listing's
 * coordinates (BRD §8.4.1). It also produces log lines no aggregator can query.
 *
 * Nest passes an optional trailing `context` string — the class that emitted
 * the record — and, for errors, a stack trace before it.
 */

function toMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Split Nest's variadic tail into the context name and anything else.
 *
 * Nest's own calls put the context last. Application code sometimes passes
 * extra values, and dropping them silently would lose diagnostics, so they are
 * kept under `details` rather than discarded.
 */
export function splitParams(params: readonly unknown[]): LogFields {
  if (params.length === 0) return {};

  const last = params[params.length - 1];
  const hasContext = typeof last === 'string';
  const context = hasContext ? last : undefined;
  const rest = hasContext ? params.slice(0, -1) : params.slice();

  return {
    ...(context !== undefined ? { context } : {}),
    ...(rest.length > 0 ? { details: rest } : {}),
  };
}

export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.info(toMessage(message), splitParams(params));
  }

  error(message: unknown, ...params: unknown[]): void {
    this.logger.error(toMessage(message), splitParams(params));
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn(toMessage(message), splitParams(params));
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.logger.debug(toMessage(message), splitParams(params));
  }

  /**
   * Nest's `verbose` is finer-grained than its `debug`, but our level set stops
   * at debug (BRD §10). Collapsing it there keeps the records rather than
   * inventing a level nothing filters on.
   */
  verbose(message: unknown, ...params: unknown[]): void {
    this.logger.debug(toMessage(message), splitParams(params));
  }

  /** Nest treats fatal as unrecoverable; we have no level above error. */
  fatal(message: unknown, ...params: unknown[]): void {
    this.logger.error(toMessage(message), { ...splitParams(params), fatal: true });
  }
}
