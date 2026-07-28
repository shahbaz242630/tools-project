import { describe, expect, it } from 'vitest';
import {
  assertDeployableTag,
  emptyState,
  interpretProbe,
  interpretWebProbe,
  isImmutableTag,
  MAX_HISTORY,
  nextStateAfterDeploy,
  nextStateAfterRollback,
  parseArgs,
  parseState,
  planDeploy,
  planRollback,
  ReleaseError,
  setEnvValue,
} from './release-plan.mjs';

/**
 * Distinct, valid-shaped commit SHAs. A hex counter rather than a repeated
 * digit, so `sha(1)` and `sha(11)` cannot collide and quietly weaken a test
 * that counts distinct releases.
 */
const sha = (n) => n.toString(16).padStart(40, '0');
const A = sha(1);
const B = sha(2);
const C = sha(3);

describe('isImmutableTag', () => {
  it('accepts a full lowercase SHA', () => {
    expect(isImmutableTag('a'.repeat(40))).toBe(true);
  });

  it.each([
    ['latest', 'a moving tag'],
    ['main', 'a branch name'],
    ['v1.2.3', 'a semantic version'],
    ['abc1234', 'an abbreviated SHA'],
    ['A'.repeat(40), 'uppercase — registries are case-sensitive'],
    ['g'.repeat(40), 'right length, not hex'],
    ['a'.repeat(41), 'one character too long'],
  ])('rejects %j (%s)', (tag) => {
    expect(isImmutableTag(tag)).toBe(false);
  });

  it('rejects a non-string without throwing', () => {
    expect(isImmutableTag(undefined)).toBe(false);
    expect(isImmutableTag(null)).toBe(false);
    expect(isImmutableTag(40)).toBe(false);
  });
});

describe('assertDeployableTag', () => {
  it('returns the tag when it is deployable', () => {
    expect(assertDeployableTag(A)).toBe(A);
  });

  it('tells someone who passed a short SHA how to expand it', () => {
    // The common mistake: copying the SHA out of `git log --oneline`. The
    // message has to name the fix, not just the rule.
    expect(() => assertDeployableTag('abc1234')).toThrow(/abbreviated SHA/);
    expect(() => assertDeployableTag('abc1234')).toThrow(/git rev-parse abc1234/);
  });

  it('explains that there is no latest tag to fall back on', () => {
    expect(() => assertDeployableTag('latest')).toThrow(ReleaseError);
    expect(() => assertDeployableTag('latest')).toThrow(/no "latest"/);
  });
});

describe('parseState', () => {
  it('treats a missing file as never deployed', () => {
    expect(parseState(null)).toEqual(emptyState());
    expect(parseState(undefined)).toEqual(emptyState());
    expect(parseState('   ')).toEqual(emptyState());
  });

  it('round-trips a real state file', () => {
    const raw = JSON.stringify({ version: 1, current: B, history: [B, A] });
    expect(parseState(raw)).toEqual({ version: 1, current: B, history: [B, A] });
  });

  it('refuses a truncated file rather than guessing the rollback target', () => {
    // The box lost power mid-write. Continuing from half a file would make the
    // next rollback go somewhere arbitrary.
    expect(() => parseState('{"version":1,"current":"abc')).toThrow(/not valid JSON/);
  });

  it.each([
    ['[]', 'an array'],
    ['"a string"', 'a bare string'],
    ['{"version":1,"current":null}', 'no history array'],
    [`{"version":1,"current":"latest","history":[]}`, 'a non-SHA current'],
    [`{"version":1,"current":null,"history":["latest"]}`, 'a non-SHA in history'],
  ])('refuses %s (%s)', (raw) => {
    expect(() => parseState(raw)).toThrow(/not the expected shape/);
  });
});

describe('planDeploy', () => {
  it('records what a failed deploy should fall back to', () => {
    const plan = planDeploy({ version: 1, current: A, history: [A] }, B);
    expect(plan).toMatchObject({ action: 'deploy', target: B, fallback: A });
  });

  it('has no fallback on a first deploy', () => {
    // This is the case deploy.mjs cannot auto-recover from, so the plan has to
    // say so rather than leaving it to be discovered at failure time.
    expect(planDeploy(emptyState(), A).fallback).toBeNull();
  });

  it('allows redeploying what is already running, and says that is what it is', () => {
    const plan = planDeploy({ version: 1, current: A, history: [A] }, A);
    expect(plan.isRedeploy).toBe(true);
  });

  it('refuses a tag that is not a commit SHA', () => {
    expect(() => planDeploy(emptyState(), 'latest')).toThrow(ReleaseError);
  });
});

describe('planRollback', () => {
  it('targets the release before the current one', () => {
    const plan = planRollback({ version: 1, current: C, history: [C, B, A] });
    expect(plan).toMatchObject({ action: 'rollback', target: B, from: C });
  });

  it('refuses when nothing has been deployed', () => {
    expect(() => planRollback(emptyState())).toThrow(/nothing to roll back from/);
  });

  it('refuses when the current release is the only one, and suggests the git log', () => {
    expect(() => planRollback({ version: 1, current: A, history: [A] })).toThrow(
      /only release recorded/,
    );
    expect(() => planRollback({ version: 1, current: A, history: [A] })).toThrow(
      /git log --oneline/,
    );
  });
});

describe('nextStateAfterDeploy', () => {
  it('puts the new release at the front', () => {
    const next = nextStateAfterDeploy({ version: 1, current: A, history: [A] }, B);
    expect(next).toEqual({ version: 1, current: B, history: [B, A] });
  });

  it('does not duplicate a redeploy of the current release', () => {
    // Duplicating would make the next rollback target the same tag, so it would
    // report success while changing nothing.
    const next = nextStateAfterDeploy({ version: 1, current: A, history: [A] }, A);
    expect(next).toEqual({ version: 1, current: A, history: [A] });
  });

  it('moves a re-deployed older release to the front rather than duplicating it', () => {
    const next = nextStateAfterDeploy(
      { version: 1, current: C, history: [C, B, A] },
      A,
    );
    expect(next).toEqual({ version: 1, current: A, history: [A, C, B] });
  });

  it(`caps history at ${MAX_HISTORY}, keeping the most recent`, () => {
    let state = emptyState();
    for (let i = 1; i <= MAX_HISTORY + 5; i += 1) {
      state = nextStateAfterDeploy(state, sha(i));
    }
    expect(state.history).toHaveLength(MAX_HISTORY);
    expect(state.history[0]).toBe(sha(MAX_HISTORY + 5));
    expect(state.history).not.toContain(sha(1));
  });
});

describe('nextStateAfterRollback', () => {
  it('drops the abandoned release so a second rollback goes further back', () => {
    const once = nextStateAfterRollback({ version: 1, current: C, history: [C, B, A] });
    expect(once).toEqual({ version: 1, current: B, history: [B, A] });

    const twice = nextStateAfterRollback(once);
    expect(twice).toEqual({ version: 1, current: A, history: [A] });
  });

  it('stops once there is nothing further back', () => {
    const state = { version: 1, current: A, history: [A] };
    expect(() => nextStateAfterRollback(state)).toThrow(/only release recorded/);
  });
});

describe('parseArgs', () => {
  it('parses a deploy', () => {
    expect(parseArgs(['--env', 'staging', '--tag', A])).toMatchObject({
      env: 'staging',
      tag: A,
      revertOnFailure: true,
      timeoutSeconds: 120,
    });
  });

  it('parses a rollback', () => {
    expect(parseArgs(['--env', 'production', '--rollback'])).toMatchObject({
      env: 'production',
      rollback: true,
    });
  });

  it('rejects an unknown environment', () => {
    expect(() => parseArgs(['--env', 'prod', '--rollback'])).toThrow(
      /must be one of staging, production/,
    );
  });

  it('requires an environment', () => {
    expect(() => parseArgs(['--tag', A])).toThrow(/--env is required/);
  });

  it('requires a mode', () => {
    expect(() => parseArgs(['--env', 'staging'])).toThrow(/one of --tag/);
  });

  it('refuses combined modes', () => {
    expect(() => parseArgs(['--env', 'staging', '--tag', A, '--rollback'])).toThrow(
      /mutually exclusive/,
    );
  });

  it('refuses an unrecognised flag rather than ignoring it', () => {
    // A typo'd --rollbac that parsed as "do nothing" would be found during an
    // incident, which is the worst possible time.
    expect(() => parseArgs(['--env', 'staging', '--rollbac'])).toThrow(
      /Unrecognised option/,
    );
  });

  it('refuses a flag whose value is missing', () => {
    expect(() => parseArgs(['--env', '--tag', A])).toThrow(/--env needs a value/);
  });

  it.each([['0'], ['-5'], ['1.5'], ['soon']])('refuses --timeout %j', (value) => {
    expect(() =>
      parseArgs(['--env', 'staging', '--rollback', '--timeout', value]),
    ).toThrow(/positive whole number/);
  });
});

describe('setEnvValue', () => {
  const FILE = [
    '# Per-environment settings',
    'APP_ENV=staging',
    'IMAGE_TAG=' + A,
    'POSTGRES_PASSWORD=s3cret#not-a-comment',
    'POSTGRES_DB=rental',
    '',
  ].join('\n');

  it('replaces only the named line', () => {
    const next = setEnvValue(FILE, 'IMAGE_TAG', B);
    expect(next).toContain(`IMAGE_TAG=${B}`);
    expect(next).not.toContain(A);
    // The line that must survive intact. This file holds the only copy of the
    // database password; mangling it destroys the environment.
    expect(next).toContain('POSTGRES_PASSWORD=s3cret#not-a-comment');
    expect(next.split('\n')).toHaveLength(FILE.split('\n').length);
  });

  it('appends when the key is absent, without a stray blank line', () => {
    expect(setEnvValue('APP_ENV=staging\n', 'IMAGE_TAG', A)).toBe(
      `APP_ENV=staging\nIMAGE_TAG=${A}\n`,
    );
  });

  it('appends to a file with no trailing newline', () => {
    expect(setEnvValue('APP_ENV=staging', 'IMAGE_TAG', A)).toBe(
      `APP_ENV=staging\nIMAGE_TAG=${A}\n`,
    );
  });

  it('does not match a key that merely shares a prefix', () => {
    // IMAGE_TAG must not match IMAGE_TAG_PREVIOUS, and must not match a value
    // that happens to mention it.
    const file = 'IMAGE_TAG_PREVIOUS=old\nNOTE=see IMAGE_TAG=x\n';
    const next = setEnvValue(file, 'IMAGE_TAG', A);
    expect(next).toContain('IMAGE_TAG_PREVIOUS=old');
    expect(next).toContain('NOTE=see IMAGE_TAG=x');
    expect(next).toContain(`\nIMAGE_TAG=${A}\n`);
  });

  it('refuses a value that could inject a second assignment', () => {
    expect(() => setEnvValue(FILE, 'IMAGE_TAG', 'a\nPOSTGRES_PASSWORD=')).toThrow(
      /newline/,
    );
    expect(() => setEnvValue(FILE, 'IMAGE_TAG', 'a # rest')).toThrow(/newline or "#"/);
  });

  it('refuses a malformed key', () => {
    expect(() => setEnvValue(FILE, 'image tag', A)).toThrow(/not a valid environment/);
  });
});

describe('interpretProbe', () => {
  it('is ready when the app says so', () => {
    expect(
      interpretProbe({ exitCode: 0, stdout: '{"status":"ready","checks":{}}' }),
    ).toEqual({ outcome: 'ready' });
  });

  it('is unhealthy — not starting — when the app answers 503', () => {
    // The distinction that matters: the process is up and reporting a broken
    // dependency, so waiting out the timeout would waste the whole budget.
    const result = interpretProbe({
      exitCode: 1,
      stdout: '{"status":"not_ready","checks":{"postgres":"error"}}',
    });
    expect(result.outcome).toBe('unhealthy');
    expect(result.detail).toContain('postgres');
  });

  it('is starting when nothing answered yet', () => {
    expect(interpretProbe({ exitCode: 1, stdout: '' }).outcome).toBe('starting');
  });

  it('is starting when the container is not up, not unhealthy', () => {
    expect(
      interpretProbe({ exitCode: 1, stdout: 'Error: No such container' }).outcome,
    ).toBe('starting');
  });

  it('tolerates absent output', () => {
    expect(interpretProbe({ exitCode: 1 }).outcome).toBe('starting');
  });
});

describe('interpretWebProbe', () => {
  it('is ready when the root page serves', () => {
    expect(interpretWebProbe({ exitCode: 0, stdout: 'WEB_OK' })).toEqual({
      outcome: 'ready',
    });
  });

  it('is unhealthy — not starting — on a 500', () => {
    // The web app is up and erroring. Waiting out the timeout would not help,
    // and a deploy that only gated on the API would have called this a success.
    const result = interpretWebProbe({ exitCode: 1, stdout: 'WEB_500' });
    expect(result.outcome).toBe('unhealthy');
    expect(result.detail).toContain('HTTP 500');
  });

  it('is starting when nothing has answered yet', () => {
    expect(interpretWebProbe({ exitCode: 1, stdout: '' }).outcome).toBe('starting');
  });

  it('is starting when the container does not exist yet', () => {
    expect(
      interpretWebProbe({ exitCode: 1, stdout: 'Error: No such container' }).outcome,
    ).toBe('starting');
  });

  it('tolerates absent output', () => {
    expect(interpretWebProbe({ exitCode: 1 }).outcome).toBe('starting');
  });
});
