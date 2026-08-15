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
  assertNoRehearsalProfile,
  interpretProbe,
  interpretWebProbe,
  interpretWorkerProbe,
  nextStateAfterDeploy,
  nextStateAfterRollback,
  parseArgs,
  parseState,
  planDeploy,
  planFailureResponse,
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
 * Apply pending migrations, before anything starts serving.
 *
 * Runs the `migrations` image at the same tag as the release, as a one-off
 * container on this environment's internal network. It exits when it is done;
 * a non-zero exit aborts the deploy before a single request reaches code that
 * expects a schema which is not there.
 *
 * Safe to run on every deploy: `migrate deploy` applies only what is pending
 * and is a no-op otherwise.
 *
 * Rolling the application back afterwards is also safe, and that is not an
 * accident — expand-and-contract migrations are backwards compatible by
 * construction, so the previous release still runs against the newer schema.
 * A migration that breaks that rule breaks rollback, which is why the rule is
 * not optional (BRD §15).
 */
function runMigrations(env, tag) {
  // The service declares no `depends_on`, because the database is managed and
  // off this box (ADR 0037) — there is nothing in the stack to start or wait
  // for. It also connects to the DIRECT endpoint rather than the pooled one:
  // Prisma holds an advisory lock for the length of the migration so two
  // deploys cannot migrate at once, and a transaction pooler gives a different
  // backend per transaction, which drops that lock the moment it is taken.
  const result = compose(env, tag, ['run', '--rm', 'migrations']);

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

/**
 * Ask the web app whether it serves its own root page.
 *
 * It has no readiness endpoint by design — it renders whether or not the API is
 * reachable, and `/status` reports that honestly. So the question is only
 * whether it is serving, and gating on it matters: the API can be perfectly
 * ready while the thing every visitor loads returns 500.
 */
function probeWeb(env) {
  const result = run('docker', [
    'exec',
    `rental-${env}-web`,
    'node',
    '-e',
    `fetch('http://127.0.0.1:3000/')
       .then((r) => {
         process.stdout.write(r.ok ? 'WEB_OK' : 'WEB_' + r.status);
         process.exit(r.ok ? 0 : 1);
       })
       .catch((e) => {
         process.stderr.write(String(e));
         process.exit(1);
       });`,
  ]);

  return interpretWebProbe({ exitCode: result.status, stdout: result.stdout });
}

/**
 * Ask Docker what it thinks of the worker.
 *
 * `docker inspect` rather than `docker exec`, because there is nothing in the
 * worker to ask: it answers no port and its whole job is to be attached to a
 * queue. What it does have is a container HEALTHCHECK that goes stale unless the
 * process refreshes a file behind a Redis PING, so the honest question is the one
 * Docker already answers.
 *
 * **Until this existed a crash-looping worker deployed as a success**, and not
 * because anything was tested badly: the worker image carried no HEALTHCHECK, so
 * compose's `--wait` accepted "running", and this script only ever probed the API
 * and the web app. The one container whose failure is invisible from the outside
 * was the one nothing looked at.
 */
function probeWorker(env) {
  const result = run('docker', [
    'inspect',
    `rental-${env}-worker`,
    '--format',
    // Two fields. A crash loop and a broker outage present completely
    // differently and only one of them is visible in each.
    '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
  ]);

  return interpretWorkerProbe({ exitCode: result.status, stdout: result.stdout });
}

/**
 * Poll one probe until it succeeds, fails definitively, or the budget runs out.
 *
 * The budget is per service rather than shared: they start concurrently, so the
 * slowest one determines the wall clock either way, and splitting the allowance
 * would make a slow database look like a broken web app.
 */
async function waitFor(label, probe, timeoutSeconds) {
  const attempts = Math.max(1, Math.ceil(timeoutSeconds / PROBE_INTERVAL_SECONDS));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = probe();

    if (result.outcome === 'ready') {
      say(`  ${label} ready after ${attempt * PROBE_INTERVAL_SECONDS}s`);
      // A probe that passed because there was nothing to check must say so.
      // Rolling back to an image built before the check existed is legitimate
      // and must not be blocked; being quiet about it would not be.
      if (result.unverified === true) say(`  (unverified: ${result.detail})`);
      return { ready: true };
    }

    if (result.outcome === 'unhealthy') {
      // Up, and telling us it is broken. Waiting out the rest of the budget
      // would not change the answer.
      say(`  ${label} started but is not healthy:`);
      say(`  ${result.detail}`);
      return { ready: false, reason: 'unhealthy', detail: result.detail };
    }

    if (attempt % 5 === 0) {
      say(`  ${label} still starting (${attempt * PROBE_INTERVAL_SECONDS}s)`);
    }
    await sleep(PROBE_INTERVAL_SECONDS);
  }

  return {
    ready: false,
    reason: 'timeout',
    detail: `${label} did not become healthy within ${timeoutSeconds}s`,
  };
}

/**
 * Every service the release consists of, in the order a failure is most usefully
 * reported: the API first, because a broken API explains a broken web app but
 * not the other way round, and the worker last because nothing a visitor does
 * depends on it synchronously.
 *
 * **The worker is here from 15 August 2026 and was not before.** It processes
 * booking expiries and payout releases — work whose failure nobody sees until a
 * deadline passes — so "no visitor notices" is a reason to check it last, never
 * a reason not to check it.
 */
async function waitForStack(env, timeoutSeconds) {
  const api = await waitFor('api', () => probeReadiness(env), timeoutSeconds);
  if (!api.ready) return api;

  const web = await waitFor('web', () => probeWeb(env), timeoutSeconds);
  if (!web.ready) return web;

  return waitFor('worker', () => probeWorker(env), timeoutSeconds);
}

/**
 * Save the failed release's logs before reverting destroys them.
 *
 * `docker compose up` replaces the containers, so by the time anyone reads the
 * "deploy failed" message the evidence is gone — and `scripts/logs.mjs` would
 * show the healthy replacements, which looks like the failure never happened.
 * Capture first, then revert.
 *
 * Both application services, not only the one that failed its probe: a web app
 * returning 500 is very often explained by what the API logged, and the two are
 * about to be destroyed together.
 */
function captureFailedLogs(env, tag) {
  const sections = [];

  for (const service of ['api', 'web', 'worker']) {
    const result = run('docker', ['logs', '--tail', '200', `rental-${env}-${service}`]);

    // Both streams: a Node process that dies on startup usually says why on
    // stderr, which is exactly the case worth keeping.
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0 || output.trim() === '') continue;

    sections.push({ service, output });
  }

  if (sections.length === 0) return { path: null, lines: [] };

  const path = join(releaseRoot, 'state', `${env}.failed.log`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `# failed release: ${tag}\n` +
      sections.map((s) => `\n--- ${s.service} ---\n${s.output}`).join(''),
    'utf8',
  );

  // Only the API's tail is echoed to the terminal. Three services' worth would
  // bury the reason; the file has all of it.
  const api = sections.find((s) => s.service === 'api');
  return {
    path,
    lines: api === undefined ? [] : api.output.trimEnd().split('\n'),
  };
}

function runningImage(env, service) {
  const result = run('docker', [
    'inspect',
    `rental-${env}-${service}`,
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
  // Per service rather than one line. They are deployed from the same tag, so
  // a disagreement here means a partial deploy — worth seeing immediately
  // rather than inferring from `docker ps`.
  for (const service of ['web', 'api', 'worker']) {
    say(`  ${service.padEnd(7)} ${runningImage(env, service) ?? '(no container)'}`);
  }
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

  say('Applying migrations...');
  if (!runMigrations(env, plan.target)) {
    // Nothing has been swapped yet, so the previous release is still serving.
    // Stopping here leaves it that way, which is the correct outcome: a broken
    // migration must not be followed by code that assumes it worked.
    say('');
    say('FAILED: migrations did not apply. The running release is untouched.');
    // The migrations container ran with --rm and its output is printed above,
    // so there is no log to fetch — deliberately not pointing at
    // `logs.mjs --service postgres`, which stopped existing when the database
    // moved to Neon (ADR 0037). What is worth checking is the far end.
    say('  The migration output is above; the container is already gone.');
    say('  Check POSTGRES_DIRECT_HOST is the endpoint WITHOUT -pooler, and');
    say('  that POSTGRES_SSLMODE is verify-full. Then the Neon console.');
    return 1;
  }

  say('');
  bringUp(env, plan.target);
  say('');
  say('Waiting for readiness...');

  const readiness = await waitForStack(env, timeoutSeconds);

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

  const { response } = planFailureResponse(plan);

  if (response === 'stranded') {
    /*
     * A rollback whose target is also unhealthy. There is deliberately nowhere
     * automatic to go — the only other release is the one somebody just decided
     * to leave — so the stack stays on `plan.target` and the job here is to be
     * loud and to leave the record honest.
     *
     * **Recording the move is the fix for defect 5 of the August 2026 audit.**
     * Before it, state was left untouched: `--status` reported the newer tag
     * while the older one served, nothing errored, and a second `--rollback`
     * targeted the release that had just failed rather than the one before it.
     * Writing the state is not a claim that the release is healthy. It is a
     * claim about which images are running, which is what the file is for.
     */
    const stranded = captureFailedLogs(env, plan.target);

    writeState(env, nextStateAfterRollback(readState(env)));
    recordTagInEnvFile(env, plan.target);

    say('');
    say(
      `THE ROLLBACK FAILED AND ${env.toUpperCase()} IS SERVING AN UNHEALTHY RELEASE.`,
    );
    say(`  running:  ${plan.target}  (rolled back from ${plan.from})`);
    say('');
    say('Recorded state now says so, so --status describes the box rather than');
    say('the intention, and another --rollback walks one release further back');
    say('instead of redeploying the one that just failed.');
    say('');
    say('There is nothing left to revert to automatically: the only other');
    say('release here is the one this rollback was leaving. Deploy an explicit');
    say('--tag, or take the stack down deliberately:');
    say(`  node scripts/deploy.mjs --env ${env} --tag <sha>`);
    say(`  docker compose --env-file ${envFilePath(env)} -f ${COMPOSE_FILE} down`);
    say('');
    say(
      stranded.path !== null
        ? `The failed release logged to:  ${stranded.path}`
        : `Logs:  node scripts/logs.mjs --env ${env}`,
    );
    return 1;
  }

  if (response === 'stuck') {
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

  const recovered = await waitForStack(env, timeoutSeconds);

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

  // First, ahead of every other precondition. This one is about how the command
  // was invoked rather than about the state of the box, so it must not depend on
  // Docker running or an env file existing — and it comes before `--status`
  // because a wrong profile makes even the status output describe a stack
  // nobody meant to run.
  assertNoRehearsalProfile(options.env, process.env.COMPOSE_PROFILES);

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
