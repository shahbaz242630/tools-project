import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ShutdownBudgetError,
  parseDuration,
  readGracePeriods,
  readShutdownTimeout,
} from './shutdown-budget.mjs';

const fromRoot = (relative) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');

describe('parseDuration', () => {
  it.each([
    ['45s', 45_000],
    ['15s', 15_000],
    ['2m', 120_000],
    ['1m30s', 90_000],
    ['1h', 3_600_000],
    ['500ms', 500],
  ])('reads %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each([['30'], [''], ['soon'], ['30 s'], ['-5s']])(
    'refuses %j rather than guessing a unit',
    (input) => {
      // A bare number is seconds to one tool and nanoseconds to another. Reading
      // it wrong here would silently reinstate the bug this file exists to catch.
      expect(() => parseDuration(input)).toThrow(ShutdownBudgetError);
    },
  );
});

describe('readGracePeriods', () => {
  it('reads the value against the service it belongs to', () => {
    const yaml = [
      'services:',
      '  api:',
      '    image: x',
      '    stop_grace_period: 15s',
      '  worker:',
      '    image: y',
      '    stop_grace_period: 45s',
      'volumes:',
      '  data:',
    ].join('\n');

    expect(readGracePeriods(yaml)).toEqual({ api: 15_000, worker: 45_000 });
  });

  it('omits a service that sets none rather than inventing a default', () => {
    // Docker's silent 10s default is precisely what went unnoticed, so absence
    // has to stay visible to the caller.
    const yaml = ['services:', '  web:', '    image: x'].join('\n');
    expect(readGracePeriods(yaml)).toEqual({});
  });

  it('does not attribute a value to a service after the services block ends', () => {
    const yaml = [
      'services:',
      '  api:',
      '    image: x',
      'volumes:',
      '  stop_grace_period: 99s',
    ].join('\n');

    expect(readGracePeriods(yaml)).toEqual({});
  });
});

describe('readShutdownTimeout', () => {
  it('reads a numeric separator', () => {
    expect(readShutdownTimeout('const SHUTDOWN_TIMEOUT_MS = 30_000;')).toBe(30_000);
  });

  it('throws when the declaration is gone rather than returning a default', () => {
    expect(() => readShutdownTimeout('const OTHER = 1;')).toThrow(ShutdownBudgetError);
  });
});

describe('the deployed stack', () => {
  const compose = fromRoot('infra/compose/docker-compose.app.yml');
  const grace = readGracePeriods(compose);

  // Every service whose process installs `createShutdown`. `web` is deliberately
  // absent: Next installs no SIGTERM handler at all, so it has no teardown to
  // outrun — a known gap recorded in the Phase 0 handoff, not an oversight here.
  const SERVICES = [
    { name: 'api', main: 'apps/api/src/main.ts' },
    { name: 'worker', main: 'apps/worker/src/main.ts' },
  ];

  it.each(SERVICES)('$name sets a stop_grace_period at all', ({ name }) => {
    expect(grace[name]).toBeGreaterThan(0);
  });

  it.each(SERVICES)(
    '$name is given longer to stop than it waits before force-exiting',
    ({ name, main }) => {
      // The rule this whole file exists for. If the grace period is not strictly
      // greater, the force-exit in @platform/runtime is unreachable: SIGKILL
      // lands first and the exit code becomes 137, which reads as a crash and
      // turns an ordinary deploy into an apparent crash loop.
      const timeout = readShutdownTimeout(fromRoot(main));
      expect(grace[name]).toBeGreaterThan(timeout);
    },
  );
});
