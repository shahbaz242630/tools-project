/**
 * Error tracking behind an interface.
 *
 * BRD §5 requires every external provider to sit behind an interface with a
 * production adapter, a test fake and an explicit failure strategy. Sentry is
 * the intended provider, but the adapter is deliberately not written yet: there
 * is no account or DSN, so it could not be exercised, and an untested adapter
 * is worse than an absent one because it looks finished.
 *
 * `createNoopErrorTracker` is a real production adapter, not a placeholder — it
 * is what runs when tracking is intentionally disabled, and it guarantees the
 * call sites work identically either way.
 *
 * The overriding rule: a failure in error tracking must never become a failure
 * in the request that triggered it. Every method here swallows its own errors.
 */

import type { Logger } from './logger.js';
import { getContext } from './correlation.js';
import { redact } from './redaction.js';

export interface ErrorContext {
  /** Grouping hint — the operation that failed, not the message. */
  readonly operation?: string;
  /** Additional detail. Redacted before it leaves the process. */
  readonly extra?: Record<string, unknown>;
  /** Raise the assigned severity above the default. */
  readonly severity?: 'warning' | 'error' | 'fatal';
}

export interface ErrorTracker {
  captureException(error: unknown, context?: ErrorContext): void;
  captureMessage(message: string, context?: ErrorContext): void;
  /** Best-effort delivery before shutdown. Resolves false on timeout. */
  flush(timeoutMs?: number): Promise<boolean>;
}

/**
 * Production adapter for "tracking is off".
 *
 * Errors still reach the log — losing the diagnostic entirely would be worse
 * than having no aggregator.
 */
export function createNoopErrorTracker(logger: Logger): ErrorTracker {
  return {
    captureException(error, context) {
      logger.error('exception captured', {
        error,
        operation: context?.operation,
        severity: context?.severity ?? 'error',
        ...context?.extra,
      });
    },
    captureMessage(message, context) {
      logger.warn('message captured', {
        capturedMessage: message,
        operation: context?.operation,
        severity: context?.severity ?? 'warning',
        ...context?.extra,
      });
    },
    async flush() {
      return true;
    },
  };
}

export interface RecordedEvent {
  kind: 'exception' | 'message';
  value: unknown;
  context?: ErrorContext;
  correlationId?: string;
}

export interface RecordingErrorTracker extends ErrorTracker {
  readonly events: readonly RecordedEvent[];
  reset(): void;
}

/** Test fake. Records what would have been sent, redacted as it would be. */
export function createRecordingErrorTracker(): RecordingErrorTracker {
  const events: RecordedEvent[] = [];

  // Read the context once per call. Two lookups cannot be narrowed together,
  // and would also risk observing different values either side of an await.
  function record(
    kind: RecordedEvent['kind'],
    value: unknown,
    context?: ErrorContext,
  ): void {
    const correlationId = getContext()?.correlationId;
    events.push({
      kind,
      value: redact(value),
      ...(context !== undefined ? { context } : {}),
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  }

  return {
    events,
    captureException(error, context) {
      record('exception', error, context);
    },
    captureMessage(message, context) {
      record('message', message, context);
    },
    async flush() {
      return true;
    },
    reset() {
      events.length = 0;
    },
  };
}

/**
 * Catch what would otherwise terminate the process silently.
 *
 * An unhandled rejection in a background job — a booking expiry, a payout
 * release — would otherwise vanish. Returns a function that removes the
 * handlers, so tests do not leak listeners between cases.
 */
export function installProcessHandlers(
  logger: Logger,
  tracker: ErrorTracker,
): () => void {
  const onUnhandledRejection = (reason: unknown): void => {
    logger.error('unhandled promise rejection', { error: reason });
    tracker.captureException(reason, {
      operation: 'unhandledRejection',
      severity: 'fatal',
    });
  };

  const onUncaughtException = (error: Error): void => {
    logger.error('uncaught exception', { error });
    tracker.captureException(error, {
      operation: 'uncaughtException',
      severity: 'fatal',
    });
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);

  return () => {
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtException', onUncaughtException);
  };
}
