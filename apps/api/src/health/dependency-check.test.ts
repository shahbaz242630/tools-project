import { describe, expect, it, vi } from 'vitest';
import { runCheck } from './dependency-check.js';
import type { DependencyCheck } from './dependency-check.js';

const reachable: DependencyCheck = {
  name: 'reachable',
  probe: () => Promise.resolve(),
};

const broken: DependencyCheck = {
  name: 'broken',
  probe: () => Promise.reject(new Error('connection refused')),
};

/** Accepts the connection and then never answers — the failure that matters. */
const silent: DependencyCheck = {
  name: 'silent',
  probe: () => new Promise<void>(() => {}),
};

describe('runCheck', () => {
  it('reports ok when the dependency answers', async () => {
    expect(await runCheck(reachable, 100)).toEqual({ name: 'reachable', status: 'ok' });
  });

  it('reports failed and keeps the error for the caller to log', async () => {
    const result = await runCheck(broken, 100);
    expect(result.status).toBe('failed');
    expect(result.name).toBe('broken');
    expect((result.error as Error).message).toBe('connection refused');
  });

  it('reports timeout rather than hanging when nothing answers', async () => {
    const result = await runCheck(silent, 20);
    expect(result).toEqual({ name: 'silent', status: 'timeout' });
  });

  it('resolves rather than throwing, so one dead dependency cannot mask others', async () => {
    await expect(runCheck(broken, 100)).resolves.toBeDefined();
  });

  it('distinguishes a refusal from a hang', async () => {
    // Both are "not ready", but they point at different problems: refused means
    // the service is down, timeout means it is up and stuck.
    const [refused, hung] = await Promise.all([
      runCheck(broken, 50),
      runCheck(silent, 20),
    ]);
    expect(refused.status).toBe('failed');
    expect(hung.status).toBe('timeout');
  });

  it('clears its timer, so a fast check leaves nothing pending', async () => {
    // A leaked timer keeps the event loop alive for the full timeout, stalling
    // graceful shutdown and hanging the test process on exit. Asserting on
    // elapsed time would not catch it — the call still returns immediately.
    vi.useFakeTimers();
    try {
      await runCheck(reachable, 60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
