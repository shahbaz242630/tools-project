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
 *
 * **A resource that hangs is the same failure as one that throws, and used not
 * to be treated that way.** `await close()` handles a rejection fine and handles
 * a promise that never settles not at all, so one wedged resource consumed the
 * entire window every later one was going to share. bullmq 6 made that concrete:
 * its `Worker.close()` never settles when Redis was never reachable, where 5
 * resolved in about a second. Each wait is therefore bounded individually, and
 * giving up on one is logged and stepped over exactly like a rejection.
 *
 * **`timeoutMs` must be shorter than the container's `stop_grace_period`**, or
 * the force-exit below is unreachable code: the orchestrator's SIGKILL always
 * arrives first and the exit code it produces is 137, which reads as a crash.
 * That was true of the worker — 30s against Docker's unset, therefore 10s,
 * default — from the day it shipped until August 2026. The relationship is
 * asserted by `scripts/lib/shutdown-budget.test.mjs`, because the two numbers
 * live in different files, in different units, in different languages, and
 * nothing else compares them.
 */

export interface Closable {
  readonly name: string;
  close(): Promise<void>;
  /**
   * How long to wait for this resource alone, overriding `closeTimeoutMs`.
   * A worker draining an in-flight job needs longer than a socket being dropped.
   */
  readonly timeoutMs?: number;
}

export interface ShutdownOptions {
  /** Closed in order. Stop accepting work before releasing what it needs. */
  readonly closables: readonly Closable[];
  readonly logger: Logger;
  /**
   * Backstop for the whole sequence. Must be shorter than the container's
   * `stop_grace_period` — see the note above.
   */
  readonly timeoutMs: number;
  /**
   * Default bound for a single `close()`. Required rather than defaulted: a
   * convenient default here is precisely what let one hanging resource go
   * unbounded for four sessions, and the compiler listing every call site is
   * the point.
   */
  readonly closeTimeoutMs: number;
  /** Injected so the sequence is testable without ending the test runner. */
  readonly exit: (code: number) => void;
}

type CloseOutcome = 'closed' | 'timed out';

/**
 * Waits for one resource, but not forever.
 *
 * The settlement handlers are attached before the race can be decided, so a
 * rejection arriving *after* we stopped waiting is still handled — abandoning a
 * promise without one turns a slow failure into an unhandled rejection during
 * exit, which is a second bad exit code chasing the first.
 */
function closeWithin(closable: Closable, timeoutMs: number): Promise<CloseOutcome> {
  return new Promise<CloseOutcome>((resolve, reject) => {
    const timer = setTimeout(() => resolve('timed out'), timeoutMs);

    closable.close().then(
      () => {
        clearTimeout(timer);
        resolve('closed');
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createShutdown(options: ShutdownOptions): (signal: string) => void {
  const { closables, logger, timeoutMs, closeTimeoutMs, exit } = options;
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
        const bound = closable.timeoutMs ?? closeTimeoutMs;
        try {
          if ((await closeWithin(closable, bound)) === 'timed out') {
            logger.warn('gave up waiting for a resource to close', {
              resource: closable.name,
              timeoutMs: bound,
            });
          }
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
