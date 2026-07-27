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
    // Three 30ms checks in sequence would take 90ms. A readiness probe that
    // costs the sum of its dependencies gets slower with every one we add.
    const slow = (name: string): DependencyCheck => ({
      name,
      probe: () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
    });
    const { service } = build([slow('a'), slow('b'), slow('c')], 500);

    const started = Date.now();
    await service.report();
    expect(Date.now() - started).toBeLessThan(80);
  });
});
