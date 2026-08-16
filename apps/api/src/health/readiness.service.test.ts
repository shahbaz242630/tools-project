import { describe, expect, it } from 'vitest';
import { ReadinessService } from './readiness.service.js';
import type { DependencyCheck } from './dependency-check.js';
import { createRecordingLogger } from '@platform/observability/testing';

const ok = (name: string): DependencyCheck => ({
  name,
  probe: () => Promise.resolve(),
});

const failing = (name: string, message = 'connection refused'): DependencyCheck => ({
  name,
  probe: () => Promise.reject(new Error(message)),
});

const hanging = (name: string): DependencyCheck => ({
  name,
  probe: () => new Promise<void>(() => {}),
});

function build(checks: readonly DependencyCheck[], timeoutMs = 50) {
  const recording = createRecordingLogger();
  return {
    service: new ReadinessService(checks, recording.logger, timeoutMs),
    recording,
  };
}

describe('ReadinessService', () => {
  it('is ready when every dependency answers', async () => {
    const { service } = build([ok('postgres'), ok('redis')]);
    expect(await service.report()).toEqual({
      ready: true,
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('is not ready when any dependency fails', async () => {
    const { service } = build([ok('postgres'), failing('redis')]);
    const report = await service.report();
    expect(report.ready).toBe(false);
    expect(report.checks).toEqual({ postgres: 'ok', redis: 'failed' });
  });

  it('reports every dependency, not just the first failure', async () => {
    // A report that stopped at the first problem would send someone to fix
    // Postgres while Redis was also down.
    const { service } = build([failing('postgres'), failing('redis')]);
    expect((await service.report()).checks).toEqual({
      postgres: 'failed',
      redis: 'failed',
    });
  });

  it('distinguishes a hang from a refusal', async () => {
    const { service } = build([hanging('postgres'), failing('redis')], 20);
    expect((await service.report()).checks).toEqual({
      postgres: 'timeout',
      redis: 'failed',
    });
  });

  it('is ready with no dependencies configured', async () => {
    // Vacuous, but it must not throw: an app with nothing to check is ready.
    expect(await build([]).service.report()).toEqual({ ready: true, checks: {} });
  });

  it('logs the failure detail that the report withholds', async () => {
    const { service, recording } = build([
      failing('redis', 'ECONNREFUSED 127.0.0.1:6379'),
    ]);
    await service.report();

    const errors = recording.at('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('readiness check failed');
    expect(errors[0]?.fields?.['dependency']).toBe('redis');
    expect((errors[0]?.fields?.['error'] as Error).message).toContain('ECONNREFUSED');
  });

  it('keeps the underlying error out of the report entirely', async () => {
    // The response body reaches whoever calls /ready. A driver error names
    // hosts, ports and users, so nothing but a coarse status may escape here.
    const { service } = build([failing('postgres', 'password authentication failed')]);
    const report = await service.report();

    expect(JSON.stringify(report)).not.toContain('password');
    expect(Object.keys(report)).toEqual(['ready', 'checks']);
  });

  it('says nothing when everything is healthy', async () => {
    const { service, recording } = build([ok('postgres')]);
    await service.report();
    expect(recording.records).toHaveLength(0);
  });

  it('runs checks concurrently rather than in sequence', async () => {
    // A readiness probe that costs the sum of its dependencies gets slower with
    // every one we add, so the property is worth pinning.
    //
    // **Observed rather than timed, and the previous version is why.** This
    // asserted that three 30 ms checks finished in under 80 ms — sequential
    // would be 90 ms, so it had ten milliseconds of headroom. On a machine
    // running sixteen test workers, three `setTimeout(30)` callbacks routinely
    // take longer than 80 ms to be *scheduled*, let alone run, and the suite
    // failed with "expected 80 to be less than 80" while the code was correct.
    // A stopwatch cannot tell "ran in sequence" from "ran concurrently on a
    // busy machine"; it was measuring the machine.
    //
    // So each probe now reports that it has started and then **waits until all
    // three have**. Run concurrently they release each other and every check
    // succeeds. Run in sequence the first probe waits on two that have not been
    // called yet, `runCheck` gives up on it after `timeoutMs`, and the report
    // comes back not ready — so the assertion is the service's own output, with
    // no clock and no threshold to tune.
    //
    // **An earlier version of this counted probe invocations and had no teeth**
    // — it was checked by making the service sequential and it still passed.
    // Sequential execution invokes all three probes too, just one at a time, so
    // a count can never tell the two apart. What distinguishes them is whether
    // the three were ever in flight *together*, and only a barrier shows that.
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;

    const tracked = (name: string): DependencyCheck => ({
      name,
      probe: async () => {
        started += 1;
        if (started === 3) release();
        await allStarted;
      },
    });
    const { service } = build([tracked('a'), tracked('b'), tracked('c')], 500);

    const report = await service.report();

    expect(report.ready).toBe(true);
    expect(report.checks).toEqual({ a: 'ok', b: 'ok', c: 'ok' });
  });
});
