import type { Logger } from '@platform/observability';

/**
 * Ordered teardown on SIGTERM.
 *
 * The exit code is a claim about *why* the process ended, and an orchestrator
 * reads it that way: 0 means "I stopped because you asked", non-zero means
 * "I crashed". Getting that wrong turns an ordinary deploy into an apparent
 * crash loop.
 *
 * So a resource that fails to close is logged and stepped over. The process was
 * asked to stop and it is stopping; a Redis client that was never connected
 * refusing to disconnect is not a reason to claim we crashed. Only failing to
 * finish at all — the timeout — earns a non-zero code.
 */

export interface Closable {
  readonly name: string;
  close(): Promise<void>;
}

export interface ShutdownOptions {
  /** Closed in order. Stop accepting work before releasing what it needs. */
  readonly closables: readonly Closable[];
  readonly logger: Logger;
  readonly timeoutMs: number;
  /** Injected so the sequence is testable without ending the test runner. */
  readonly exit: (code: number) => void;
}

export function createShutdown(options: ShutdownOptions): (signal: string) => void {
  const { closables, logger, timeoutMs, exit } = options;
  let shuttingDown = false;

  return function shutdown(signal: string): void {
    // A second SIGTERM is an operator losing patience, not a reason to close
    // everything twice.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('shutdown requested', { signal });

    // Exiting late beats never: the orchestrator will SIGKILL us anyway, and
    // doing it ourselves keeps the exit code honest about what happened.
    const forceExit = setTimeout(() => {
      logger.error('shutdown timed out, exiting', { timeoutMs });
      exit(1);
    }, timeoutMs);
    forceExit.unref();

    void (async (): Promise<void> => {
      for (const closable of closables) {
        try {
          await closable.close();
        } catch (error) {
          logger.warn('failed to close cleanly during shutdown', {
            resource: closable.name,
            error,
          });
        }
      }

      clearTimeout(forceExit);
      logger.info('shutdown complete', { signal });
      exit(0);
    })();
  };
}
