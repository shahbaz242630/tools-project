/**
 * Readiness probing for a single external dependency.
 *
 * Two rules shape this.
 *
 * **A probe must be bounded.** The realistic database failure is not a refused
 * connection, which returns immediately, but a socket that accepts and then
 * never answers. An unbounded probe turns that into a readiness endpoint that
 * hangs, which an orchestrator reads as neither healthy nor unhealthy.
 *
 * **A probe reports coarsely and logs precisely.** The caller of `/ready` is
 * usually a load balancer, but it may be anyone. A driver error names hosts,
 * ports, users and sometimes the connection string. That belongs in a redacted
 * log line, never in a response body.
 */

export type DependencyStatus = 'ok' | 'failed' | 'timeout';

/**
 * A dependency that can be asked whether it is reachable.
 *
 * Deliberately narrower than any client library, so an adapter can be faked in
 * a test without a database and no provider SDK leaks past this boundary.
 */
export interface DependencyCheck {
  readonly name: string;
  /** Resolves when reachable, rejects otherwise. */
  probe(): Promise<void>;
}

export interface DependencyResult {
  readonly name: string;
  readonly status: DependencyStatus;
  /** For logging only. Never serialise this into a response. */
  readonly error?: unknown;
}

/**
 * Run one check, resolving to a status rather than throwing.
 *
 * A timeout resolves rather than rejecting because "did not answer in time" is
 * a readiness answer, not an exception — the endpoint's job is to report, not
 * to fail.
 */
export async function runCheck(
  check: DependencyCheck,
  timeoutMs: number,
): Promise<DependencyResult> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<DependencyResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ name: check.name, status: 'timeout' }),
      timeoutMs,
    );
  });

  const probe = check
    .probe()
    .then((): DependencyResult => ({ name: check.name, status: 'ok' }))
    .catch((error: unknown): DependencyResult => ({
      name: check.name,
      status: 'failed',
      error,
    }));

  try {
    return await Promise.race([probe, timeout]);
  } finally {
    // Without this the process cannot exit until the longest timeout elapses,
    // which stalls both graceful shutdown and the test suite.
    if (timer !== undefined) clearTimeout(timer);
  }
}
