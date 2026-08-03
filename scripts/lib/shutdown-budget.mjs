/**
 * Reads the two numbers that have to agree for a graceful shutdown to happen,
 * and which live nowhere near each other.
 *
 * A service decides its own exit code only if it finishes tearing down before
 * the orchestrator loses patience. That makes `stop_grace_period` in the compose
 * file and `SHUTDOWN_TIMEOUT_MS` in the service's `main.ts` a single rule split
 * across two files, two languages and two units — and nothing compared them, so
 * for four sessions the worker waited 30s inside a container Docker killed at
 * its 10s default. The force-exit whose entire purpose is keeping the exit code
 * honest had never once been able to run.
 *
 * Pure parsing, so the test can both check the real files and pin the parser
 * against inputs the real files do not currently contain.
 */

export class ShutdownBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShutdownBudgetError';
  }
}

/**
 * Compose durations are a string with a unit — `45s`, `2m30s`, `1h`. A bare
 * number is seconds in some tools and nanoseconds in others, so it is refused
 * rather than guessed at.
 */
export function parseDuration(value) {
  const text = String(value).trim();
  if (!/^(\d+h)?(\d+m)?(\d+s)?(\d+ms)?$/.test(text) || text === '') {
    throw new ShutdownBudgetError(
      `not a compose duration: ${JSON.stringify(value)} — use a unit, e.g. "45s"`,
    );
  }

  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)(ms|h|m|s)/g)) {
    const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
    total += Number(amount) * factor;
  }
  return total;
}

/**
 * `stop_grace_period` per service, in milliseconds. Services that do not set one
 * are absent rather than defaulted — the caller decides whether an unset value
 * is acceptable, because Docker's silent 10s default is the whole bug.
 */
export function readGracePeriods(composeYaml) {
  /** @type {Record<string, number>} */
  const found = {};
  let service = null;

  for (const line of composeYaml.split(/\r?\n/)) {
    // Two-space indent under `services:` is a service name. Deeper is its body,
    // and no indent is a new top-level key, which ends the services block.
    const start = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (start) {
      service = start[1];
      continue;
    }
    if (/^\S/.test(line) && line.trim() !== '') {
      service = null;
      continue;
    }

    const grace = /^\s+stop_grace_period:\s*(\S+)\s*$/.exec(line);
    if (grace && service) {
      found[service] = parseDuration(grace[1]);
    }
  }

  return found;
}

/**
 * The `--stop-timeout` CI gives each container, in milliseconds, keyed by
 * service.
 *
 * CI runs `docker run` directly rather than through compose, so it does not
 * inherit `stop_grace_period` — without this flag it asserts the shutdown
 * contract against Docker's 10s default, which is a grace period we do not
 * deploy with. A check that passes under a configuration that exists nowhere is
 * worse than no check.
 */
export function readCiStopTimeouts(workflowYaml) {
  /** @type {Record<string, number>} */
  const found = {};
  for (const [, service, seconds] of workflowYaml.matchAll(
    /--name\s+([A-Za-z0-9_-]+)-ci\b.*?--stop-timeout\s+(\d+)/g,
  )) {
    found[service] = Number(seconds) * 1000;
  }
  return found;
}

/**
 * The `SHUTDOWN_TIMEOUT_MS` a composition root declares, in milliseconds.
 * Numeric separators are allowed because the source uses them (`30_000`).
 */
export function readShutdownTimeout(source) {
  const match = /const SHUTDOWN_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/.exec(source);
  if (!match) {
    throw new ShutdownBudgetError('no SHUTDOWN_TIMEOUT_MS declaration found');
  }
  return Number(match[1].replaceAll('_', ''));
}
