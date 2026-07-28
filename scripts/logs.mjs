#!/usr/bin/env node
/**
 * Read logs from a deployed stack.
 *
 * Half of the Phase 0 exit gate is "logs are demonstrated", and the honest
 * version of that is not `docker compose logs` in a runbook — it is a command
 * that knows where the stacks are, refuses a filter Docker would silently
 * ignore, and can write a file you can take off the box.
 *
 * Retention is whatever the json-file driver holds: 3 × 10 MB per service, set
 * in the compose files. That is enough for a recent incident and not enough for
 * an audit trail. Shipping logs off the box is a later slice.
 *
 * Usage:
 *   node scripts/logs.mjs --env production --service api --since 15m
 *   node scripts/logs.mjs --env staging --follow
 *   node scripts/logs.mjs --env ingress --since 1h --out incident.log
 *
 * Environment:
 *   RELEASE_ROOT   Where env files live. Default /opt/rental.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLogArgs, LogArgsError, parseLogArgs, USAGE } from './lib/log-args.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_DIR = join(REPO_ROOT, 'infra', 'compose');
const releaseRoot = process.env.RELEASE_ROOT ?? '/opt/rental';

/**
 * Which compose project a request refers to.
 *
 * The ingress is its own long-lived stack with its own env file, so it needs a
 * different file and a different project name from the app environments.
 */
function stackFor(env) {
  if (env === 'ingress') {
    return {
      composeFile: join(COMPOSE_DIR, 'docker-compose.ingress.yml'),
      envFile: join(releaseRoot, 'ingress.env'),
      extraEnv: {},
    };
  }

  return {
    composeFile: join(COMPOSE_DIR, 'docker-compose.app.yml'),
    envFile: join(releaseRoot, `${env}.env`),
    // The app compose file needs both to resolve its project and image names.
    // IMAGE_TAG is only read to build the image reference, which reading logs
    // does not use — but compose still interpolates it, so it must be present.
    extraEnv: { APP_ENV: env, IMAGE_TAG: 'unused-for-logs' },
  };
}

function main() {
  const options = parseLogArgs(process.argv.slice(2));

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const stack = stackFor(options.env);

  if (!existsSync(stack.envFile)) {
    throw new LogArgsError(
      `No environment file at ${stack.envFile}, so there is no ${options.env} ` +
        `stack on this machine to read.`,
    );
  }

  const args = [
    'compose',
    '--env-file',
    stack.envFile,
    '-f',
    stack.composeFile,
    ...buildLogArgs(options),
  ];

  // Without this the app compose file cannot interpolate APP_ENV or IMAGE_TAG.
  // It happens to work once an environment has been deployed, because the env
  // file then carries both — so the failure only appears when reading logs from
  // a stack that has never had a successful deploy, which is exactly when
  // somebody most needs them.
  const childEnv = { ...process.env, ...stack.extraEnv };

  // Streaming goes straight to the terminal. Capturing it would buffer the
  // whole stream in memory and defeat the point of following.
  if (options.follow || options.out === null) {
    const result = spawnSync('docker', args, {
      stdio: 'inherit',
      shell: false,
      env: childEnv,
    });
    return result.status ?? 1;
  }

  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    shell: false,
    env: childEnv,
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    return result.status ?? 1;
  }

  process.stdout.write(result.stdout);
  writeFileSync(options.out, result.stdout, 'utf8');

  const lines = result.stdout === '' ? 0 : result.stdout.trimEnd().split('\n').length;
  // Reported explicitly. An empty file is a real answer — nothing was logged in
  // that window — but only if the operator can tell it apart from a broken
  // command, and both look identical otherwise.
  console.log(`\n${lines} line(s) written to ${options.out}`);

  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof LogArgsError) {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
