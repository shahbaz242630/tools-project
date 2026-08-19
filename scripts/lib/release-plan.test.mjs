import { describe, expect, it } from 'vitest';
import {
  assertDeployableTag,
  assertNoRehearsalProfile,
  emptyState,
  interpretProbe,
  interpretWebProbe,
  interpretWorkerProbe,
  isImmutableTag,
  MAX_HISTORY,
  nextStateAfterDeploy,
  nextStateAfterRollback,
  parseArgs,
  parseState,
  planDeploy,
  planFailureResponse,
  planRollback,
  releaseImagesToRemove,
  REHEARSAL_PROFILE,
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

describe('assertNoRehearsalProfile', () => {
  it('refuses production when the rehearsal profile is enabled', () => {
    // The database is managed (ADR 0037). Enabling this profile in production
    // starts a Postgres container nothing connects to, holding a stale schema
    // on a disk nobody backs up — and every health check still passes, because
    // the applications are talking to Neon regardless. Nothing would notice.
    expect(() => assertNoRehearsalProfile('production', REHEARSAL_PROFILE)).toThrow(
      ReleaseError,
    );
    expect(() => assertNoRehearsalProfile('production', REHEARSAL_PROFILE)).toThrow(
      /unset COMPOSE_PROFILES/,
    );
  });

  it('finds it among several profiles, and tolerates spacing', () => {
    // COMPOSE_PROFILES is a comma-separated list, so a substring check would
    // both miss this and match a profile merely named "rehearsal-something".
    for (const value of [
      `observability,${REHEARSAL_PROFILE}`,
      ` ${REHEARSAL_PROFILE} , observability `,
      `${REHEARSAL_PROFILE},`,
    ]) {
      expect(() => assertNoRehearsalProfile('production', value)).toThrow(ReleaseError);
    }
  });

  it('allows a profile whose name merely contains it', () => {
    expect(() =>
      assertNoRehearsalProfile('production', 'rehearsal-notes'),
    ).not.toThrow();
  });

  it('allows staging, which is what CI rehearses as', () => {
    // Staging must stay permitted or the Deploy rehearsal cannot run at all,
    // and the rehearsal is the only thing proving this script works.
    expect(() => assertNoRehearsalProfile('staging', REHEARSAL_PROFILE)).not.toThrow();
  });

  it('allows production when the variable is absent or empty', () => {
    for (const value of [undefined, null, '', '   ', ',,']) {
      expect(() => assertNoRehearsalProfile('production', value)).not.toThrow();
    }
  });

  it('allows production with unrelated profiles set', () => {
    expect(() =>
      assertNoRehearsalProfile('production', 'observability,debug'),
    ).not.toThrow();
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

  it('has no automatic fallback, because the only other release is the one being left', () => {
    expect(planRollback({ version: 1, current: C, history: [C, B, A] }).fallback).toBe(
      null,
    );
  });
});

describe('planFailureResponse', () => {
  it('reverts an ordinary deploy to the release it replaced', () => {
    const plan = planDeploy({ version: 1, current: A, history: [A] }, B);

    expect(planFailureResponse(plan)).toEqual({ response: 'revert', target: A });
  });

  it('is stuck when nothing has ever served here', () => {
    const plan = planDeploy(emptyState(), A);

    expect(planFailureResponse(plan)).toEqual({ response: 'stuck' });
  });

  it('is stranded — not stuck — when a rollback fails', () => {
    /*
     * The distinction defect 5 of the August 2026 audit was about. Both plans
     * carry `fallback: null`, so `deploy.mjs` treated a failed rollback as a
     * first deploy: it printed "there is no previous release to revert to" and
     * wrote no state, leaving `state.current` naming the newer tag while the
     * older one served. Nothing errored, and a second `--rollback` re-deployed
     * the release that had just failed.
     */
    const plan = planRollback({ version: 1, current: C, history: [C, B, A] });

    expect(plan.fallback).toBe(null);
    expect(planFailureResponse(plan)).toEqual({ response: 'stranded' });
  });

  it('records what is actually running after a stranded rollback', () => {
    // What `deploy.mjs` writes in that branch. `current` becomes the release
    // that is serving, and the abandoned one leaves history — so another
    // rollback walks further back rather than repeating the failure.
    const state = { version: 1, current: C, history: [C, B, A] };

    expect(nextStateAfterRollback(state)).toEqual({
      version: 1,
      current: B,
      history: [B, A],
    });
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

describe('interpretWorkerProbe', () => {
  it('is ready when the container is healthy', () => {
    expect(interpretWorkerProbe({ exitCode: 0, stdout: 'running healthy' })).toEqual({
      outcome: 'ready',
    });
  });

  it('is unhealthy when the process is up but its health check is failing', () => {
    /*
     * The failure this probe exists for: a worker that started, never reached
     * Redis, and is therefore processing nothing. Before the container carried a
     * HEALTHCHECK at all, compose's `--wait` accepted "running" and this
     * deployed as a success.
     */
    const result = interpretWorkerProbe({ exitCode: 0, stdout: 'running unhealthy' });

    expect(result.outcome).toBe('unhealthy');
    expect(result.detail).toContain('Redis');
  });

  it('is starting while the health check is still within its start period', () => {
    expect(
      interpretWorkerProbe({ exitCode: 0, stdout: 'running starting' }).outcome,
    ).toBe('starting');
  });

  it('is starting — not ready — while the container is crash-looping', () => {
    // `restarting` may still resolve, so it is worth waiting out; what must not
    // happen is calling it ready, which is what having no probe at all did.
    const result = interpretWorkerProbe({ exitCode: 0, stdout: 'restarting starting' });

    expect(result.outcome).toBe('starting');
    expect(result.detail).toContain('restarting');
  });

  it.each([['exited'], ['dead']])('is unhealthy when the container has %s', (state) => {
    expect(interpretWorkerProbe({ exitCode: 0, stdout: `${state} none` }).outcome).toBe(
      'unhealthy',
    );
  });

  it('is starting when there is no container yet', () => {
    expect(
      interpretWorkerProbe({ exitCode: 1, stdout: 'Error: No such object' }).outcome,
    ).toBe('starting');
    expect(interpretWorkerProbe({ exitCode: 1, stdout: '' }).outcome).toBe('starting');
    expect(interpretWorkerProbe({ exitCode: 1 }).outcome).toBe('starting');
  });

  it('passes an image with no health check, and says it is unverified', () => {
    /*
     * Every image built before the HEALTHCHECK existed is a legitimate rollback
     * target. Failing here would mean the first rollback after this shipped
     * could not complete — a probe added to catch a bad deploy would have become
     * the thing that stopped an incident being ended.
     */
    const result = interpretWorkerProbe({ exitCode: 0, stdout: 'running none' });

    expect(result.outcome).toBe('ready');
    expect(result.unverified).toBe(true);
  });
});

describe('releaseImagesToRemove', () => {
  const repo = 'ghcr.io/owner/project';
  const image = (service, tag) => `${repo}/${service}:${tag}`;

  it('keeps every tag a rollback can name', () => {
    const state = { version: 1, current: A, history: [A, B] };
    const present = [
      image('api', A),
      image('web', A),
      image('api', B),
      image('api', C),
    ];

    expect(releaseImagesToRemove(present, state)).toEqual([image('api', C)]);
  });

  it('keeps the running release even if history somehow omits it', () => {
    // Should be impossible — nextStateAfterDeploy always prepends. This is the
    // case where trusting that invariant would delete the image being served.
    const state = { version: 1, current: A, history: [B] };

    expect(releaseImagesToRemove([image('api', A)], state)).toEqual([]);
  });

  it('removes nothing when every image is still reachable', () => {
    const state = { version: 1, current: A, history: [A, B, C] };
    const present = [image('api', A), image('worker', B), image('migrations', C)];

    expect(releaseImagesToRemove(present, state)).toEqual([]);
  });

  it('keeps a line it cannot parse rather than guessing', () => {
    const state = { version: 1, current: A, history: [A] };

    // No tag at all, and an empty tag. Neither is a release image; both are
    // left alone, because a wrong deletion costs more than a stray image.
    expect(releaseImagesToRemove([`${repo}/api`, `${repo}/api:`], state)).toEqual([]);
  });

  it('removes every service of a release that has aged out, not just one', () => {
    const state = { version: 1, current: A, history: [A] };
    const present = [
      image('api', A),
      image('api', B),
      image('web', B),
      image('worker', B),
      image('migrations', B),
    ];

    expect(releaseImagesToRemove(present, state)).toEqual([
      image('api', B),
      image('web', B),
      image('worker', B),
      image('migrations', B),
    ]);
  });

  it('bounds what is kept by MAX_HISTORY, so disk use cannot grow without limit', () => {
    // The property that matters: history is capped, so the set of images this
    // function protects is capped by the same number rather than by a second
    // setting that could disagree with it.
    let state = { version: 1, current: sha(0), history: [sha(0)] };
    for (let i = 1; i <= MAX_HISTORY + 5; i += 1) {
      state = nextStateAfterDeploy(state, sha(i));
    }

    const present = Array.from({ length: MAX_HISTORY + 6 }, (_, i) =>
      image('api', sha(i)),
    );

    expect(present.length - releaseImagesToRemove(present, state).length).toBe(
      MAX_HISTORY,
    );
  });
});
