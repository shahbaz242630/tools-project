import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import {
  createRecordingLogger,
  createRecordingMetrics,
} from '@platform/observability/testing';
import { RateLimitGuard, retryAfterSeconds } from './rate-limit.guard.js';
import { resolvePolicies } from './policy.js';
import { accountRateLimitKey } from './rate-limiter.js';
import type { RateLimitTier } from './rate-limiter.js';
import { FakeRateLimiter } from './testing/fakes.js';

const ACCOUNT = '3f7c2b90-0000-4000-8000-00000000abcd';

/**
 * A context that reports a tier and an account, plus the headers the guard set.
 *
 * Hand-rolled rather than a Nest testing module: this guard's whole job is to
 * read metadata, key on a user and shape a refusal, and a real module would put
 * an injector between the assertion and the thing being asserted.
 */
function contextFor(tier: RateLimitTier | undefined, accountId: string | undefined) {
  const headers = new Map<string, string>();
  const handler = () => undefined;
  if (tier !== undefined) Reflect.defineMetadata('__rateLimitTier__', tier, handler);

  const context = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => (accountId === undefined ? {} : { user: { id: accountId } }),
      getResponse: () => ({
        header: (name: string, value: string) => headers.set(name, value),
      }),
    }),
  } as unknown as ExecutionContext;

  return { context, headers };
}

/**
 * A reflector that answers with the tier the test asked for.
 *
 * `SetMetadata` uses a module-private symbol, so a test cannot write the same
 * key. Stubbing the read is the honest seam — what is under test is what the
 * guard does with a tier, not whether Nest's decorator stores one.
 */
function reflectorFor(tier: RateLimitTier | undefined): Reflector {
  return {
    getAllAndOverride: () => tier,
  } as unknown as Reflector;
}

function build(tier: RateLimitTier | undefined, limiter: FakeRateLimiter) {
  const { logger, records, at } = createRecordingLogger();
  const recording = createRecordingMetrics();
  const guard = new RateLimitGuard(
    reflectorFor(tier),
    limiter,
    resolvePolicies({ read: 3, write: 2 }),
    logger,
    recording.metrics,
  );

  return { guard, records, at, recording };
}

describe('the per-account rate limit (slice H7a)', () => {
  it('lets a caller through while they are under the limit', async () => {
    const limiter = new FakeRateLimiter();
    const { guard, recording } = build('read', limiter);
    const { context } = contextFor('read', ACCOUNT);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(recording.rateLimits.every((sample) => sample.outcome === 'allowed')).toBe(
      true,
    );
  });

  it('refuses the request that goes over, with a 429', async () => {
    const limiter = new FakeRateLimiter();
    const { guard, recording } = build('write', limiter);
    const { context } = contextFor('write', ACCOUNT);

    await guard.canActivate(context);
    await guard.canActivate(context);

    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });
    expect(recording.rateLimits.at(-1)).toEqual({ tier: 'write', outcome: 'refused' });
  });

  it('sets Retry-After, so a client does not have to guess', async () => {
    // A refusal without it is what turns a polite client into the retry storm
    // the limit exists to stop.
    const limiter = new FakeRateLimiter();
    const { guard } = build('write', limiter);
    const { context, headers } = contextFor('write', ACCOUNT);

    await guard.canActivate(context);
    await guard.canActivate(context);
    await guard.canActivate(context).catch(() => undefined);

    expect(Number(headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('does not tell the caller what the limit is', async () => {
    // Naming the budget tells somebody probing exactly what they are working
    // against. The sentence has to be useful without being a specification.
    const limiter = new FakeRateLimiter();
    const { guard } = build('write', limiter);
    const { context } = contextFor('write', ACCOUNT);

    await guard.canActivate(context);
    await guard.canActivate(context);

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { message: expect.not.stringContaining('2') },
    });
  });

  it('forgives a caller once the window has passed', async () => {
    const limiter = new FakeRateLimiter();
    const { guard } = build('write', limiter);
    const { context } = contextFor('write', ACCOUNT);

    await guard.canActivate(context);
    await guard.canActivate(context);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 429 });

    limiter.advance(60_000);

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('counts each account separately', async () => {
    // The failure this catches is a key built from the tier alone, which would
    // make one busy caller refuse everybody.
    const limiter = new FakeRateLimiter();
    const { guard } = build('write', limiter);
    const mine = contextFor('write', ACCOUNT);
    const theirs = contextFor('write', '00000000-0000-4000-8000-00000000ffff');

    await guard.canActivate(mine.context);
    await guard.canActivate(mine.context);
    await expect(guard.canActivate(mine.context)).rejects.toMatchObject({
      status: 429,
    });

    await expect(guard.canActivate(theirs.context)).resolves.toBe(true);
  });

  it('counts a tier separately from the others', async () => {
    // Two reads of different endpoints share one allowance, but a read and a
    // write do not — otherwise a busy dashboard would refuse a booking.
    const limiter = new FakeRateLimiter();
    const { guard: writes } = build('write', limiter);
    const { guard: reads } = build('read', limiter);

    await writes.canActivate(contextFor('write', ACCOUNT).context);
    await writes.canActivate(contextFor('write', ACCOUNT).context);

    await expect(reads.canActivate(contextFor('read', ACCOUNT).context)).resolves.toBe(
      true,
    );
  });

  it('does not limit a route that asked for no tier', async () => {
    const limiter = new FakeRateLimiter();
    const { guard, recording } = build(undefined, limiter);

    await expect(
      guard.canActivate(contextFor(undefined, ACCOUNT).context),
    ).resolves.toBe(true);
    expect(recording.rateLimits).toHaveLength(0);
  });
});

describe('when the counter is unreachable', () => {
  it('lets the caller through, because every tier fails open today', async () => {
    // The decision is on the policy, not in the guard — see `policy.ts`. A Redis
    // outage taking search offline would be a self-inflicted outage.
    const limiter = new FakeRateLimiter();
    limiter.failNext = true;
    const { guard, recording, at } = build('read', limiter);

    await expect(guard.canActivate(contextFor('read', ACCOUNT).context)).resolves.toBe(
      true,
    );

    expect(recording.rateLimits).toEqual([{ tier: 'read', outcome: 'unavailable' }]);
    expect(at('warn')).not.toHaveLength(0);
  });

  it('records unavailable as its own outcome, not as allowed', async () => {
    /*
     * The one that matters for alerting. Failing open means an outage looks
     * exactly like a healthy platform from every other signal — which is the
     * shape that hid seven failed deploys for 31 hours. Folding it into
     * `allowed` would make it unobservable.
     */
    const limiter = new FakeRateLimiter();
    limiter.failNext = true;
    const { guard, recording } = build('read', limiter);

    await guard.canActivate(contextFor('read', ACCOUNT).context);

    expect(recording.rateLimits.map((sample) => sample.outcome)).not.toContain(
      'allowed',
    );
  });
});

describe('what never reaches a metric label', () => {
  it('keeps the account id out of the sample entirely', async () => {
    /*
     * A series is created per label combination, held in process memory and
     * scraped into a system with none of §10.1's retention or erasure rules — so
     * an account id there is personal data we cannot delete, minted one series
     * at a time by whoever is being throttled. It belongs in the log line, and
     * the next test asserts it is there.
     */
    const limiter = new FakeRateLimiter();
    const { guard, recording } = build('write', limiter);
    const { context } = contextFor('write', ACCOUNT);

    await guard.canActivate(context);
    await guard.canActivate(context);
    await guard.canActivate(context).catch(() => undefined);

    expect(JSON.stringify(recording.rateLimits)).not.toContain(ACCOUNT);
    for (const sample of recording.rateLimits) {
      expect(Object.keys(sample).sort()).toEqual(['outcome', 'tier']);
    }
  });

  it('does put it in the log, where retention can reach it', async () => {
    const limiter = new FakeRateLimiter();
    const { guard, records } = build('write', limiter);
    const { context } = contextFor('write', ACCOUNT);

    await guard.canActivate(context);
    await guard.canActivate(context);
    await guard.canActivate(context).catch(() => undefined);

    expect(JSON.stringify(records)).toContain(ACCOUNT);
  });
});

describe('the key', () => {
  it('is scoped to the tier and the account', () => {
    expect(accountRateLimitKey('read', ACCOUNT)).toBe(
      `ratelimit:read:account:${ACCOUNT}`,
    );
  });
});

describe('Retry-After', () => {
  it('is never zero, which would invite an immediate retry', () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(-5)).toBe(1);
  });

  it('rounds up, so it never says a window has passed before it has', () => {
    expect(retryAfterSeconds(4.1)).toBe(5);
  });
});
