/**
 * Release planning — the decisions a deploy makes, with no side effects.
 *
 * Separated from `scripts/deploy.mjs` because the interesting failures here are
 * not "docker returned non-zero". They are: rolling back when there is nothing
 * to roll back to, a half-written state file after the box lost power, and a
 * tag that looks fine but cannot be traced to a commit. Those are cheap to test
 * as pure functions and awkward to force in a live stack.
 *
 * Everything below takes data and returns data. Nothing reads a file, runs a
 * process or prints. See ADR 0012.
 */

/** Releases retained per environment. Ten is more than anyone rolls back. */
export const MAX_HISTORY = 10;

/**
 * Raised for anything an operator can fix. `deploy.mjs` prints the message
 * alone; a stack trace here would bury the one line that matters.
 */
export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

/**
 * A full 40-character commit SHA, lowercase.
 *
 * Nothing shorter, and no names. The Release workflow publishes exactly one tag
 * per image and it is the SHA, so anything else either does not exist in the
 * registry or is a locally built image that no commit corresponds to. A short
 * SHA is rejected too — it is ambiguous in principle, and accepting it makes
 * the recorded history inconsistent with what the registry holds.
 */
const IMMUTABLE_TAG = /^[0-9a-f]{40}$/;

export function isImmutableTag(tag) {
  return typeof tag === 'string' && IMMUTABLE_TAG.test(tag);
}

export function assertDeployableTag(tag) {
  if (isImmutableTag(tag)) return tag;

  // Named separately because these are the two mistakes people actually make,
  // and "invalid tag" sends them looking in the wrong place for both.
  if (typeof tag === 'string' && /^[0-9a-f]{7,39}$/.test(tag)) {
    throw new ReleaseError(
      `Tag "${tag}" is an abbreviated SHA. Deploys pin the full 40 characters ` +
        `so the running image is unambiguous.\n` +
        `  git rev-parse ${tag}`,
    );
  }

  throw new ReleaseError(
    `Tag "${tag}" is not a commit SHA.\n` +
      `Only images published by the Release workflow can be deployed, and it ` +
      `tags them with the full commit SHA — there is no "latest" to fall back ` +
      `on, deliberately (ADR 0012).\n` +
      `  git rev-parse origin/main`,
  );
}

/** The state of an environment that has never been deployed to. */
export function emptyState() {
  return { version: 1, current: null, history: [] };
}

/**
 * Read persisted state, tolerating everything except silent wrongness.
 *
 * A missing file is normal — it means nothing has been deployed yet. Unparseable
 * or structurally wrong content is not: continuing from a guess would make the
 * next rollback target arbitrary, which is the one moment it must not be. So a
 * corrupt file raises, and the message says how to proceed deliberately.
 */
export function parseState(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return emptyState();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReleaseError(
      `Release state is not valid JSON, so the rollback target cannot be ` +
        `trusted.\nInspect the state file, then deploy an explicit --tag to ` +
        `re-establish it.`,
    );
  }

  const looksRight =
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray(parsed.history) &&
    parsed.history.every((tag) => isImmutableTag(tag)) &&
    (parsed.current === null || isImmutableTag(parsed.current));

  if (!looksRight) {
    throw new ReleaseError(
      `Release state is readable but not the expected shape, so the rollback ` +
        `target cannot be trusted.\nInspect the state file, then deploy an ` +
        `explicit --tag to re-establish it.`,
    );
  }

  return {
    version: 1,
    current: parsed.current ?? null,
    history: parsed.history,
  };
}

/**
 * What a deploy to `tag` will do.
 *
 * Redeploying what is already running is allowed and reported as such — it is
 * how you recover a box whose containers were removed, and refusing it would
 * send someone to `docker compose up` by hand, skipping the health check.
 */
export function planDeploy(state, tag) {
  assertDeployableTag(tag);

  return {
    action: 'deploy',
    target: tag,
    // Where a failed health check returns to. Null on a first deploy, which is
    // why `deploy.mjs` has to handle "broken and nowhere to go".
    fallback: state.current,
    isRedeploy: state.current === tag,
  };
}

/**
 * What a rollback will do.
 *
 * Rollback walks backwards: the tag being left is dropped from history, so
 * running it twice reaches the release before last rather than returning to the
 * one just abandoned. During an incident "go back again" is the intent, and
 * ping-ponging between two versions is not.
 */
export function planRollback(state) {
  if (state.current === null) {
    throw new ReleaseError(
      `Nothing is recorded as deployed here, so there is nothing to roll back ` +
        `from. Deploy an explicit --tag instead.`,
    );
  }

  const previous = state.history[1];

  if (previous === undefined) {
    throw new ReleaseError(
      `${state.current} is the only release recorded here, so there is no ` +
        `earlier one to return to.\nPick a tag from the git history and deploy ` +
        `it explicitly:\n  git log --oneline origin/main`,
    );
  }

  return {
    action: 'rollback',
    target: previous,
    from: state.current,
    fallback: null,
    isRedeploy: false,
  };
}

/**
 * State after a deploy that passed its health check.
 *
 * Only called on success. A failed deploy leaves the file untouched, so the
 * recorded current release stays the one that is actually serving traffic
 * rather than the one that was attempted.
 */
export function nextStateAfterDeploy(state, tag) {
  assertDeployableTag(tag);

  if (state.current === tag) {
    // A redeploy of what is already running changes nothing. Prepending would
    // put the same tag in history twice and make the next rollback a no-op
    // that looks like it worked.
    return { version: 1, current: tag, history: [...state.history] };
  }

  return {
    version: 1,
    current: tag,
    history: [tag, ...state.history.filter((t) => t !== tag)].slice(0, MAX_HISTORY),
  };
}

/** State after a rollback. Drops the abandoned release rather than reordering. */
export function nextStateAfterRollback(state) {
  const { target } = planRollback(state);
  return { version: 1, current: target, history: state.history.slice(1) };
}

const USAGE = `
Usage:
  node scripts/deploy.mjs --env <staging|production> --tag <commit-sha>
  node scripts/deploy.mjs --env <staging|production> --rollback
  node scripts/deploy.mjs --env <staging|production> --status

Options:
  --env <name>      Required. Which environment to act on.
  --tag <sha>       Full 40-character commit SHA to deploy.
  --rollback        Return to the release before the current one.
  --status          Print what is recorded and running. Changes nothing.
  --timeout <s>     Seconds to wait for readiness. Default 120.
  --no-rollback     Leave a failed deploy in place instead of reverting it.
                    For debugging a staging failure; wrong for production.
`.trim();

export { USAGE };

const ENVIRONMENTS = ['staging', 'production'];

/**
 * Parse argv into an intent.
 *
 * Deliberately strict — an unrecognised flag is an error rather than something
 * ignored. A typo'd `--rollbac` that silently became "deploy nothing" would be
 * discovered during an incident.
 */
export function parseArgs(argv) {
  const options = {
    env: null,
    tag: null,
    rollback: false,
    status: false,
    timeoutSeconds: 120,
    revertOnFailure: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    const requireValue = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ReleaseError(`${arg} needs a value.\n\n${USAGE}`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--env':
        options.env = requireValue();
        break;
      case '--tag':
        options.tag = requireValue();
        break;
      case '--rollback':
        options.rollback = true;
        break;
      case '--status':
        options.status = true;
        break;
      case '--no-rollback':
        options.revertOnFailure = false;
        break;
      case '--timeout': {
        const value = Number(requireValue());
        if (!Number.isInteger(value) || value <= 0) {
          throw new ReleaseError(
            `--timeout must be a positive whole number of seconds.`,
          );
        }
        options.timeoutSeconds = value;
        break;
      }
      case '--help':
      case '-h':
        return { ...options, help: true };
      default:
        throw new ReleaseError(`Unrecognised option "${arg}".\n\n${USAGE}`);
    }
  }

  if (options.env === null) {
    throw new ReleaseError(`--env is required.\n\n${USAGE}`);
  }
  if (!ENVIRONMENTS.includes(options.env)) {
    throw new ReleaseError(
      `--env must be one of ${ENVIRONMENTS.join(', ')}, not "${options.env}".`,
    );
  }

  const modes = [options.tag !== null, options.rollback, options.status].filter(
    Boolean,
  ).length;

  if (modes === 0) {
    throw new ReleaseError(`Give one of --tag, --rollback or --status.\n\n${USAGE}`);
  }
  if (modes > 1) {
    throw new ReleaseError(
      `--tag, --rollback and --status are mutually exclusive.\n\n${USAGE}`,
    );
  }

  return { ...options, help: false };
}

/**
 * Rewrite one `KEY=value` line in an env file, leaving everything else byte for
 * byte as it was.
 *
 * Used to record the deployed tag in the environment's env file after a
 * successful deploy, so the file always names what is actually running and a
 * plain `docker compose` command works by hand during an incident.
 *
 * It is worth doing precisely because the file it edits also holds the only
 * copy of the database password. A regex that matched slightly too much would
 * destroy the environment rather than mislabel it, so the match is anchored to
 * the start of a line and the key must be followed immediately by `=`.
 */
export function setEnvValue(contents, key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new ReleaseError(`"${key}" is not a valid environment variable name.`);
  }
  // Newlines would inject a second assignment; `#` would comment out the rest
  // of the line. Neither can occur in a commit SHA, which is the point of
  // checking rather than assuming.
  if (/[\r\n#]/.test(value)) {
    throw new ReleaseError(`Refusing to write a value containing a newline or "#".`);
  }

  const line = `${key}=${value}`;
  const existing = new RegExp(`^${key}=.*$`, 'm');

  if (existing.test(contents)) {
    return contents.replace(existing, line);
  }

  // Absent rather than empty. Append, preserving whether the file ended with a
  // newline so repeated deploys do not accumulate blank lines.
  const separator = contents === '' || contents.endsWith('\n') ? '' : '\n';
  return `${contents}${separator}${line}\n`;
}

/**
 * Turn a readiness probe into a decision.
 *
 * The three outcomes are genuinely different and conflating them costs real
 * time during an incident. `starting` means keep waiting — a cold Node process
 * behind a cold Postgres legitimately takes tens of seconds. `unhealthy` means
 * the process is up and telling us a dependency is broken, so waiting longer
 * will not help. `ready` is ready.
 */
export function interpretProbe({ exitCode, stdout }) {
  const body = (stdout ?? '').trim();

  if (exitCode === 0 && body.includes('"status":"ready"')) {
    return { outcome: 'ready' };
  }

  // The app answered and said no. Its own body names which dependency failed.
  if (body.includes('"status":"not_ready"')) {
    return { outcome: 'unhealthy', detail: body };
  }

  // Container not up yet, HTTP server not listening, or exec failed. All
  // indistinguishable from here and all worth retrying.
  return { outcome: 'starting', detail: body };
}

/**
 * The same three outcomes for the web app.
 *
 * Separate from `interpretProbe` because the web app has no readiness endpoint
 * to report against — it renders whether or not the API is reachable, which is
 * deliberate. What matters is that it serves its own root page, so the probe
 * reports an HTTP status and this maps it.
 *
 * A deploy has to gate on this too. Gating only on the API would report success
 * while the thing every visitor actually loads was returning 500.
 */
export function interpretWebProbe({ exitCode, stdout }) {
  const body = (stdout ?? '').trim();

  if (exitCode === 0 && body === 'WEB_OK') {
    return { outcome: 'ready' };
  }

  // It answered, with a status we did not want. Retrying will not fix a 500.
  if (body.startsWith('WEB_')) {
    return {
      outcome: 'unhealthy',
      detail: `the web app answered HTTP ${body.slice('WEB_'.length)}`,
    };
  }

  return { outcome: 'starting', detail: body };
}
