#!/usr/bin/env node
/**
 * Deploy, roll back, or report on one environment.
 *
 * The only supported way to change what is running. `docker compose up` by hand
 * works, and that is the problem — it skips the readiness check, leaves the
 * recorded history wrong, and gives the next rollback nowhere to go.
 *
 * Everything that decides anything lives in lib/release-plan.mjs and is unit
 * tested. What remains here is process orchestration: run docker, poll, revert
 * if it went wrong. That part is covered by the deploy rehearsal in CI, which
 * runs this script against a real stack.
 *
 * Usage:
 *   node scripts/deploy.mjs --env staging --tag <commit-sha>
 *   node scripts/deploy.mjs --env staging --rollback
 *   node scripts/deploy.mjs --env staging --status
 *
 * Environment:
 *   RELEASE_ROOT   Where env files and release state live. Default /opt/rental.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  interpretProbe,
  nextStateAfterDeploy,
  nextStateAfterRollback,
  parseArgs,
  parseState,
  planDeploy,
  planRollback,
  ReleaseError,
  setEnvValue,
  USAGE,
} from './lib/release-plan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = join(REPO_ROOT, 'infra', 'compose', 'docker-compose.app.yml');
const EDGE_NETWORK = 'rental-edge';

/** Seconds between readiness probes. */
const PROBE_INTERVAL_SECONDS = 2;

const releaseRoot = process.env.RELEASE_ROOT ?? '/opt/rental';
const envFilePath = (env) => join(releaseRoot, `${env}.env`);
const stateFilePath = (env) => join(releaseRoot, 'state', `${env}.json`);

const say = (message = '') => console.log(message);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    // No shell. Arguments reach the process exactly as written, so a value with
    // a space or a quote cannot become a second command.
    shell: false,
    ...options,
  });
}

function runInherit(command, args, options = {}) {
  return run(command, args, { stdio: 'inherit', ...options });
}

const sleep = (seconds) =>
  new Promise((done) => {
    setTimeout(done, seconds * 1000);
  });

// --- Preconditions -----------------------------------------------------------

function requireDocker() {
  const result = run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (result.status !== 0) {
    throw new ReleaseError(
      `Cannot reach the Docker daemon.\n${(result.stderr ?? '').trim()}`,
    );
  }
}

function requireEdgeNetwork() {
  const result = run('docker', ['network', 'inspect', EDGE_NETWORK]);
  if (result.status === 0) return;

  throw new ReleaseError(
    `The shared "${EDGE_NETWORK}" network does not exist, so the ingress has no ` +
      `way to reach this stack.\nIt is created once when the box is ` +
      `provisioned, not by a deploy:\n\n  docker network create ${EDGE_NETWORK}\n`,
  );
}

function requireEnvFile(env) {
  const path = envFilePath(env);
  if (!existsSync(path)) {
    throw new ReleaseError(
      `No environment file at ${path}.\n` +
        `Copy infra/compose/app.env.example there, fill in the database ` +
        `password, and chmod 600 it.`,
    );
  }
  return path;
}

// --- Release state -----------------------------------------------------------

function readState(env) {
  const path = stateFilePath(env);
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : null;
  try {
    return parseState(raw);
  } catch (error) {
    if (error instanceof ReleaseError) {
      throw new ReleaseError(`${error.message}\n\nState file: ${path}`);
    }
    throw error;
  }
}

function writeState(env, state) {
  const path = stateFilePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Record the deployed tag in the environment's env file.
 *
 * Only after the release is confirmed healthy. The file then always names what
 * is actually serving, which is what makes a plain `docker compose ps` or
 * `docker compose logs` work by hand — during an incident, needing this script
 * to run any docker command at all would be its own problem.
 */
function recordTagInEnvFile(env, tag) {
  const path = envFilePath(env);
  writeFileSync(
    path,
    setEnvValue(readFileSync(path, 'utf8'), 'IMAGE_TAG', tag),
    'utf8',
  );
}

// --- Docker ------------------------------------------------------------------

function compose(env, tag, args, options = {}) {
  return runInherit(
    'docker',
    ['compose', '--env-file', envFilePath(env), '-f', COMPOSE_FILE, ...args],
    {
      ...options,
      env: {
        ...process.env,
        APP_ENV: env,
        // Passed through the process rather than written to the env file up
        // front: a deploy that fails must not leave the file claiming the tag
        // that broke it. The file is updated only once the release is healthy.
        IMAGE_TAG: tag,
      },
    },
  );
}

function bringUp(env, tag) {
  const result = compose(env, tag, [
    'up',
    '--detach',
    // Removes containers from services that no longer exist in the file, so a
    // renamed service does not leave an orphan running the old image.
    '--remove-orphans',
    // Tags are immutable commit SHAs, so a local copy is by definition the
    // right one. `always` would re-download the same bytes on every rollback.
    '--pull',
    'missing',
    '--wait',
    // Without this, `--wait` treats a container that starts and immediately
    // exits as success.
    '--wait-timeout',
    '120',
  ]);

  // Not fatal on its own. `--wait` fails if a dependency never became healthy,
  // but the readiness poll below is the check that decides, and it produces a
  // far better message than compose's.
  return result.status === 0;
}

/**
 * Ask the running API whether it is ready.
 *
 * Over `docker exec` rather than HTTP from the host, because the API publishes
 * no port — the only route in is the ingress, and gating a deploy on the
 * ingress would conflate "this release is broken" with "the proxy is
 * misconfigured".
 */
function probeReadiness(env) {
  const result = run('docker', [
    'exec',
    `rental-${env}-api`,
    'node',
    '-e',
    `fetch('http://127.0.0.1:3000/ready')
       .then(async (r) => {
         process.stdout.write(await r.text());
         process.exit(r.ok ? 0 : 1);
       })
       .catch((e) => {
         process.stderr.write(String(e));
         process.exit(1);
       });`,
  ]);

  return interpretProbe({ exitCode: result.status, stdout: result.stdout });
}

async function waitForReadiness(env, timeoutSeconds) {
  const attempts = Math.max(1, Math.ceil(timeoutSeconds / PROBE_INTERVAL_SECONDS));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const probe = probeReadiness(env);

    if (probe.outcome === 'ready') {
      say(`  ready after ${attempt * PROBE_INTERVAL_SECONDS}s`);
      return { ready: true };
    }

    if (probe.outcome === 'unhealthy') {
      // The process is up and naming a broken dependency. Waiting out the rest
      // of the budget would not change the answer.
      say(`  the release started but reports it is not ready:`);
      say(`  ${probe.detail}`);
      return { ready: false, reason: 'unhealthy', detail: probe.detail };
    }

    if (attempt % 5 === 0) {
      say(`  still starting (${attempt * PROBE_INTERVAL_SECONDS}s)`);
    }
    await sleep(PROBE_INTERVAL_SECONDS);
  }

  return {
    ready: false,
    reason: 'timeout',
    detail: `no readiness response within ${timeoutSeconds}s`,
  };
}

/**
 * Save the failed release's logs before reverting destroys them.
 *
 * `docker compose up` replaces the API container, so by the time anyone reads
 * the "deploy failed" message the evidence is gone — and `scripts/logs.mjs`
 * would show the healthy replacement, which looks like the failure never
 * happened. Capture first, then revert.
 */
function captureFailedLogs(env, tag) {
  const result = run('docker', ['logs', '--tail', '200', `rental-${env}-api`]);

  // Both streams: a Node process that dies on startup usually says why on
  // stderr, which is exactly the case worth keeping.
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.status !== 0 || output.trim() === '') {
    return { path: null, lines: [] };
  }

  const path = join(releaseRoot, 'state', `${env}.failed.log`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# failed release: ${tag}\n${output}`, 'utf8');

  return { path, lines: output.trimEnd().split('\n') };
}

function runningImage(env) {
  const result = run('docker', [
    'inspect',
    `rental-${env}-api`,
    '--format',
    '{{.Config.Image}}',
  ]);
  return result.status === 0 ? result.stdout.trim() : null;
}

// --- Modes -------------------------------------------------------------------

function showStatus(env) {
  const state = readState(env);

  say(`Environment: ${env}`);
  say(`Recorded:    ${state.current ?? 'nothing deployed'}`);
  say(`Running:     ${runningImage(env) ?? 'no API container'}`);
  say('');

  if (state.history.length > 1) {
    say('Rollback would return to:');
    say(`  ${state.history[1]}`);
    say('');
    say('History, most recent first:');
    for (const tag of state.history) say(`  ${tag}`);
  } else {
    say('No earlier release recorded, so --rollback has nowhere to go.');
  }

  say('');
  say('Container state:');
  compose(env, state.current ?? 'unset', ['ps']);
}

async function applyRelease(env, plan, timeoutSeconds, revertOnFailure) {
  say(
    `${plan.action === 'rollback' ? 'Rolling back' : 'Deploying'} ${env} → ${plan.target}`,
  );
  if (plan.isRedeploy) say('  (already the recorded release — redeploying it)');
  say('');

  bringUp(env, plan.target);
  say('');
  say('Waiting for readiness...');

  const readiness = await waitForReadiness(env, timeoutSeconds);

  if (readiness.ready) {
    const next =
      plan.action === 'rollback'
        ? nextStateAfterRollback(readState(env))
        : nextStateAfterDeploy(readState(env), plan.target);

    writeState(env, next);
    recordTagInEnvFile(env, plan.target);

    // Dangling images only — never a tagged one, so nothing that could still be
    // a rollback target is removed.
    run('docker', ['image', 'prune', '--force']);

    say('');
    say(`${env} is serving ${plan.target}`);
    return 0;
  }

  say('');
  say(`FAILED: ${readiness.detail}`);

  if (!revertOnFailure) {
    say('');
    say('--no-rollback was given, so the failed release is still in place.');
    say(`Logs:  node scripts/logs.mjs --env ${env} --service api`);
    return 1;
  }

  if (plan.fallback === null) {
    // Nothing to go back to. Say so plainly rather than implying a revert
    // happened — this is the first deploy to this environment.
    say('');
    say('There is no previous release to revert to, so the failed one is still');
    say('in place. Fix it forward, or take the stack down deliberately:');
    say(`  docker compose --env-file ${envFilePath(env)} -f ${COMPOSE_FILE} down`);
    say('');
    say(`Logs:  node scripts/logs.mjs --env ${env} --service api`);
    return 1;
  }

  // Before the revert, not after: bringing the previous release up replaces
  // this container and takes the only record of why it failed with it.
  const failed = captureFailedLogs(env, plan.target);

  if (failed.lines.length > 0) {
    say('');
    say(`Last ${Math.min(20, failed.lines.length)} lines from the failed release:`);
    for (const line of failed.lines.slice(-20)) say(`  | ${line}`);
  }

  say('');
  say(`Reverting to ${plan.fallback}...`);
  bringUp(env, plan.fallback);

  const recovered = await waitForReadiness(env, timeoutSeconds);

  say('');
  if (recovered.ready) {
    // State is deliberately not written: the recorded current release was
    // already `plan.fallback`, and it is once again what is serving.
    say(`Reverted. ${env} is serving ${plan.fallback} again.`);
  } else {
    say(`THE REVERT ALSO FAILED. ${env} is down.`);
    say(`  ${recovered.detail}`);
    say('');
    say('This is not a bad release — a dependency is probably broken.');
    say(`  node scripts/logs.mjs --env ${env}`);
  }

  say('');
  if (failed.path !== null) {
    // Deliberately not `logs.mjs`: that reads the container now running, which
    // is the healthy one. The failed release's container no longer exists.
    say(`The failed release logged to:  ${failed.path}`);
  } else {
    say(`The failed release produced no logs before it was replaced.`);
  }
  return 1;
}

// --- Entry point -------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    say(USAGE);
    return 0;
  }

  requireDocker();
  requireEnvFile(options.env);

  if (options.status) {
    showStatus(options.env);
    return 0;
  }

  requireEdgeNetwork();

  const state = readState(options.env);
  const plan = options.rollback ? planRollback(state) : planDeploy(state, options.tag);

  return applyRelease(
    options.env,
    plan,
    options.timeoutSeconds,
    options.revertOnFailure,
  );
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof ReleaseError) {
      // Operator error. The message is the whole point; a stack trace would
      // bury it.
      console.error(`\n${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
