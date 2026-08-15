import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The two numbers that have to agree for the worker's health signal to mean
 * anything, and which live nowhere near each other.
 *
 * `apps/worker/src/main.ts` rewrites a file every HEALTH_INTERVAL_MS after a
 * Redis PING returns. `apps/worker/Dockerfile` fails the container's HEALTHCHECK
 * once that file is older than a bound written inside a shell string. If the
 * bound ever falls below the interval the worker is unhealthy by construction
 * and every deploy fails; if it grows far beyond it, a broken worker deploys
 * green for minutes. One rule, two files, two languages — which is exactly the
 * shape `shutdown-budget.test.mjs` exists for, and exactly the shape that let the
 * worker's force-exit sit unreachable for four sessions.
 *
 * Parsed with regexes rather than by importing anything: `main.ts` is TypeScript
 * that opens a Redis connection at import, and the Dockerfile is not code at all.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (...parts) => readFileSync(join(REPO_ROOT, ...parts), 'utf8');

const workerMain = read('apps', 'worker', 'src', 'main.ts');
const workerDockerfile = read('apps', 'worker', 'Dockerfile');

/** Numeric separators are allowed because the source uses them (`10_000`). */
function readHealthInterval(source) {
  const match = source.match(/const HEALTH_INTERVAL_MS\s*=\s*([\d_]+)\s*;/);
  expect(
    match,
    'no HEALTH_INTERVAL_MS declaration in apps/worker/src/main.ts',
  ).not.toBe(null);
  return Number(match[1].replaceAll('_', ''));
}

/** The `age > N` comparison inside the HEALTHCHECK's inline node script. */
function readStalenessBound(dockerfile) {
  const match = dockerfile.match(/age\s*>\s*(\d+)\s*\)/);
  expect(match, 'no staleness comparison in the worker HEALTHCHECK').not.toBe(null);
  return Number(match[1]);
}

describe('the worker health budget', () => {
  it('declares a HEALTHCHECK at all', () => {
    // The defect this whole mechanism answers: without one, compose's `--wait`
    // accepts "running" and a crash-looping worker deploys as a success.
    expect(workerDockerfile).toMatch(/^HEALTHCHECK\s/m);
  });

  it('gives the writer several intervals before calling it stale', () => {
    const interval = readHealthInterval(workerMain);
    const bound = readStalenessBound(workerDockerfile);

    // Three is the floor rather than the intent: one slow probe during a
    // reconnection must not read as an outage. Below it the signal is a coin
    // toss, and a flaky required check is one people learn to ignore.
    expect(bound).toBeGreaterThanOrEqual(interval * 3);

    // And an upper bound, because the point of the probe is that a deploy sees
    // the failure. `deploy.mjs` polls for 120s by default.
    expect(bound).toBeLessThan(120_000);
  });

  it('watches the file the worker actually writes', () => {
    // Both sides derive the path from `tmpdir()` — the container mounts a tmpfs
    // at /tmp and its root filesystem is read-only — so the shared part is the
    // name. A rename on one side and not the other would produce a probe that
    // fails forever with no way to tell it from a broken worker.
    expect(workerMain).toContain("'worker-health'");
    expect(workerDockerfile).toContain("'worker-health'");
    expect(workerMain).toContain('tmpdir()');
    expect(workerDockerfile).toContain('tmpdir()');
  });

  it('gives the process a start period longer than one write interval', () => {
    const interval = readHealthInterval(workerMain);
    const startPeriod = workerDockerfile.match(/--start-period=(\d+)s/);

    expect(startPeriod, 'the HEALTHCHECK declares no --start-period').not.toBe(null);
    // A cold Node process plus a first Redis connection plus the first write.
    // Without the margin the container reports unhealthy before it has had the
    // chance to be anything.
    expect(Number(startPeriod[1]) * 1000).toBeGreaterThan(interval * 2);
  });
});
