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

/**
 * The compose profile carrying the throwaway Postgres the CI rehearsal uses.
 *
 * It exists so `Deploy rehearsal` can drive the real compose file end to end
 * without a live managed database (ADR 0039). Nothing else may enable it.
 */
export const REHEARSAL_PROFILE = 'rehearsal';

/**
 * Refuse a production deploy that would also start the rehearsal database.
 *
 * `COMPOSE_PROFILES` is an ordinary environment variable, so it can be set by a
 * shell profile, a CI export that outlived its job, or a copied command line —
 * and the result would be a production box quietly running a Postgres container
 * that no application is pointed at, holding a stale copy of the schema on a
 * disk we do not back up. Nobody would notice: every health check passes,
 * because the applications are talking to Neon regardless.
 *
 * Refusing rather than filtering the value out, for the reason ADR 0030 gives:
 * a flag silently dropped is one somebody eventually believes is working.
 * Staging is deliberately allowed, because staging is what CI rehearses as.
 */
export function assertNoRehearsalProfile(env, composeProfiles) {
  const profiles = String(composeProfiles ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  if (env !== 'production' || !profiles.includes(REHEARSAL_PROFILE)) return;

  throw new ReleaseError(
    `COMPOSE_PROFILES contains "${REHEARSAL_PROFILE}", which starts the ` +
      `throwaway Postgres that only the CI rehearsal should ever run.\n` +
      `Production's database is managed on Neon (ADR 0037); a local one here ` +
      `would be started, never connected to, and never backed up.\n` +
      `  unset COMPOSE_PROFILES\n`,
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
    /*
     * Deliberately null, and it does not mean the same thing as a first deploy's
     * null. There *is* an earlier release here — it is `state.current`, the one
     * being abandoned — and returning to it would be reverting to the thing
     * somebody just decided was broken. So a rollback has nowhere automatic to
     * go, on purpose.
     *
     * What that used to cost is defect 5 of the August 2026 audit: `deploy.mjs`
     * read this null, printed the first-deploy message, and **wrote no state at
     * all**. The older release was left serving while `state.current` still
     * named the newer one — and because history was also untouched, running
     * `--rollback` again re-deployed the very release that had just failed,
     * which during an incident looks like a command that did nothing. See
     * `planFailureResponse`.
     */
    fallback: null,
    isRedeploy: false,
  };
}

/**
 * What to do when a release fails its health check.
 *
 * Three genuinely different situations, and the difference is what to tell the
 * operator and what to record — not merely which message to print.
 *
 * - **revert** — an ordinary deploy over a known-good release. Go back to it.
 *   Recorded state is already correct and must not be touched.
 * - **stuck** — the first deploy to this environment. Nothing has ever served
 *   here, so there is nowhere to go and the broken release stays up.
 * - **stranded** — a rollback whose target is also unhealthy. The older release
 *   is what is serving, badly, and recorded state still names the newer one.
 *   Recording the move is not a claim that it is healthy; it is the difference
 *   between `--status` describing the box and `--status` describing a wish, and
 *   it is what makes a second `--rollback` walk one step further back instead of
 *   redeploying the release that just failed.
 */
export function planFailureResponse(plan) {
  if (plan.action === 'rollback') return { response: 'stranded' };
  if (plan.fallback === null) return { response: 'stuck' };
  return { response: 'revert', target: plan.fallback };
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
 * The same three outcomes for the worker, read from Docker rather than from the
 * application.
 *
 * The worker answers no port, so there is nothing to fetch. What it does have
 * from slice 0.9's remediation is a container HEALTHCHECK that goes stale unless
 * the process refreshes a file behind a Redis PING — so the question here is what
 * Docker thinks of it, which is `docker inspect` and two fields.
 *
 * **Two fields rather than one, because they fail differently.** A crash-looping
 * worker is `restarting` with no useful health status at all; a connected-to-
 * nothing worker is `running` and `unhealthy`. Reading only health would call the
 * first one starting forever, and reading only state would call the second one
 * ready.
 *
 * **An image with no HEALTHCHECK reports ready, and says so.** Every image built
 * before this existed is a legitimate rollback target, and a probe added later
 * must not be what stops an incident being ended. The alternative — treating an
 * absent probe as failure — would mean the first rollback after this shipped
 * could not complete.
 */
export function interpretWorkerProbe({ exitCode, stdout }) {
  const body = (stdout ?? '').trim();

  if (exitCode !== 0 || body === '') {
    // No container yet, or docker could not answer. Both worth retrying.
    return { outcome: 'starting', detail: body };
  }

  const [state, health] = body.split(/\s+/);

  if (state !== 'running') {
    // `restarting` is a crash loop and `exited` is a process that gave up.
    // Neither is going to be fixed by waiting, but `created` and `restarting`
    // can still resolve, so only a dead one is definitive.
    if (state === 'exited' || state === 'dead') {
      return { outcome: 'unhealthy', detail: `the worker container is ${state}` };
    }
    return { outcome: 'starting', detail: `the worker container is ${state}` };
  }

  if (health === 'none') {
    return {
      outcome: 'ready',
      unverified: true,
      detail: 'the worker image declares no health check',
    };
  }

  if (health === 'healthy') return { outcome: 'ready' };

  if (health === 'unhealthy') {
    return {
      outcome: 'unhealthy',
      detail:
        'the worker is running but its health check is failing — it is most likely not connected to Redis',
    };
  }

  return { outcome: 'starting', detail: `worker health is ${health ?? 'unknown'}` };
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

/**
 * Which of the box's release images may be deleted.
 *
 * **The prune that existed before this was `docker image prune --force`, which
 * removes only *dangling* images — and a release image is never dangling,
 * because every one of them is tagged with a commit SHA.** So it reclaimed
 * nothing, every time, for as long as the box had been deploying. On 19 August
 * 2026 that filled a 38 GB disk: 277 images, 35.5 GB, and a deploy that failed
 * with `ENOSPC` *after* swapping the containers, leaving the recorded release
 * and the running one disagreeing. Its comment — "never a tagged one, so
 * nothing that could still be a rollback target is removed" — was true and was
 * the whole problem.
 *
 * **The rule is the one the state file already implies: keep an image for
 * anything a rollback can name.** `history` is exactly that list and is capped
 * at {@link MAX_HISTORY}, so it needs no second retention setting to disagree
 * with — the number of releases we can roll back to and the number we keep
 * images for are now the same number by construction.
 *
 * Everything else goes. A tag pruned early is not lost: images are published to
 * ghcr and `docker compose pull` fetches one back, so the cost of being wrong
 * here is a slower rollback rather than an impossible one. The cost of being
 * wrong the other way is a full disk, which is an outage.
 *
 * Pure so it can be tested. `deploy.mjs` supplies the tags and performs the
 * removal — the same split the rest of this file uses.
 *
 * @param {readonly string[]} present every release image on the box, as `repo:tag`
 * @param {{ current: string, history: readonly string[] }} state the release record
 * @returns {string[]} the entries of `present` that are safe to remove
 */
export function releaseImagesToRemove(present, state) {
  /*
   * `current` as well as `history`, belt and braces. They should never disagree
   * — `nextStateAfterDeploy` always prepends — but this function is what stands
   * between a state file and `docker rmi`, and the failure mode of trusting the
   * invariant is deleting the image that is running.
   */
  const keep = new Set([state.current, ...state.history]);

  return present.filter((image) => {
    const tag = image.slice(image.lastIndexOf(':') + 1);

    /*
     * An image whose name we cannot parse is kept. This runs against whatever
     * `docker images` printed, and the safe answer to "I do not understand this
     * line" is to leave it on disk — a stray image costs space, and a wrong
     * deletion costs the release.
     */
    if (tag === '' || tag === image) return false;

    return !keep.has(tag);
  });
}
