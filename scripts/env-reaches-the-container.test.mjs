import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_ENV_KEYS,
  MEDIA_ENV_KEYS,
  PERSONAL_DATA_ENV_KEYS,
  PROXY_ENV_KEYS,
  SERVER_ENV_KEYS,
  WEB_ENV_KEYS,
  WORKER_ENV_KEYS,
} from '@platform/config';

/**
 * That a variable the application requires actually reaches a deployed process.
 *
 * **This closes the one gap nothing else in the repository can see, and it has
 * been walked into twice.**
 *
 * `infra/compose/docker-compose.app.yml` **enumerates every variable by name and
 * deliberately passes no env file through** — which is the right choice, because
 * a compose file that forwards an entire env file gives every container every
 * secret. The cost is that a variable is only delivered if somebody edited that
 * file, and **nothing fails when they did not**: the value sits on the box, the
 * process never sees it, and the schema's default silently applies.
 *
 * - **`TRUSTED_PROXY_HOPS`** (H7a → 24 Aug 2026) was never passed to the web
 *   container. Setting it on the box did nothing and said nothing, for a month.
 *   It is what decides which address lands in `audit_logs.ipAddress` — evidence.
 * - **`MEDIA_S3_*`** (2.6a → 24 Aug 2026) was the same bug the same week, caught
 *   only because that one has a refuse-to-boot guard behind it. Three of the
 *   four places needing the change were obvious; the compose file was not.
 *
 * ADR 0017 predicted this class and the prediction landed one layer below where
 * it was aimed. So the check is mechanical now.
 *
 * **The keys are derived from the zod schemas** (`Object.keys(shape)`), never
 * written out here — a second list is exactly the thing that drifts, which is
 * the defect this file exists to prevent one level up.
 *
 * **A variable that genuinely must not be deployed is excused by name, with a
 * reason.** That is the point: the check does not demand every variable be
 * forwarded, it demands somebody *decided*. Silence is what it removes.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE = path.join(HERE, '..', 'infra', 'compose', 'docker-compose.app.yml');

/**
 * Variables that deliberately never reach a deployed container.
 *
 * Each needs a reason. An entry with a weak reason is a variable somebody could
 * not be bothered to wire up, and that is the failure this file is about.
 */
const NOT_DEPLOYED = {
  NODE_ENV:
    'Set literally to `production` in the compose file rather than passed through, ' +
    'so a deployed process cannot be started in development mode by an env file.',

  POSTGRES_TEST_DB:
    'The integration suite’s database, which exists only on a developer machine. ' +
    'A deployed process must never hold the name of a database it is allowed to truncate.',

  DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA:
    'ADR 0030. The API refuses to boot with it set under NODE_ENV=production, so ' +
    'forwarding it could only ever turn a deploy into a crash loop.',

  METRICS_ENABLED:
    'Defaults to true, chosen in H1 precisely so no environment has to remember to ' +
    'switch observability on — and the environment that would be forgotten is the ' +
    'one that matters. Forwarding it would add a way to turn it off by accident.',

  RATE_LIMIT_READ_PER_MINUTE:
    'Carries a default and is not yet tuned. **This one has a trigger**: H7a says the ' +
    'limits are set by judgement rather than measurement, so the day ' +
    '`rate_limit_decisions_total` says the numbers are wrong, they need to be tunable ' +
    'without a deploy — and that is the day this entry moves out of this list.',

  RATE_LIMIT_WRITE_PER_MINUTE:
    'As RATE_LIMIT_READ_PER_MINUTE above: a default, untuned, and it moves out of this ' +
    'list the day the counter says the number is wrong. The two travel together — a ' +
    'read limit tunable without a deploy and a write limit that is not would be worse ' +
    'than neither, because only one half of a policy would move.',

  WORKER_METRICS_PORT:
    'Defaults to 9464, which is what `prometheus.yml` scrapes by name. Two places ' +
    'holding the number is how they come to disagree; the default is the single one.',
};

/** Every variable any of the application’s schemas declares. */
const DECLARED = [
  ...new Set([
    ...SERVER_ENV_KEYS,
    ...IDENTITY_ENV_KEYS,
    ...MEDIA_ENV_KEYS,
    ...PERSONAL_DATA_ENV_KEYS,
    ...PROXY_ENV_KEYS,
    ...WORKER_ENV_KEYS,
    ...WEB_ENV_KEYS,
  ]),
].sort();

/**
 * The variable names the compose file sets on any service.
 *
 * Matched on `NAME:` at an environment block’s indentation. Deliberately not a
 * YAML parse: the file is full of `${VAR:?message}` interpolation, and adding a
 * parser to read six lines is a dependency for the sake of it.
 */
function composeEnvKeys() {
  const text = readFileSync(COMPOSE, 'utf8');
  const found = new Set();

  for (const line of text.split(/\r?\n/)) {
    const matched = line.match(/^ {6}([A-Z][A-Z0-9_]*):/);
    if (matched) found.add(matched[1]);
  }

  return found;
}

describe('the deployment compose file', () => {
  const inCompose = composeEnvKeys();

  it('was read at all — a silent zero here would pass every test below', () => {
    /*
     * The failure this guards is the one that makes a checker worthless: a moved
     * file or a changed indentation makes `composeEnvKeys` return nothing, every
     * assertion trivially holds, and the check reports success forever.
     */
    expect(inCompose.size).toBeGreaterThan(20);
    expect(inCompose.has('POSTGRES_HOST')).toBe(true);
  });

  it('has schemas to check against', () => {
    expect(DECLARED.length).toBeGreaterThan(25);
  });

  it.each(DECLARED)('delivers %s, or says why it does not', (key) => {
    if (Object.hasOwn(NOT_DEPLOYED, key)) {
      // Excused — but the reason has to be a real one.
      expect(NOT_DEPLOYED[key].length).toBeGreaterThan(40);
      return;
    }

    expect(
      inCompose.has(key),
      `${key} is declared by an env schema but never set in ` +
        `infra/compose/docker-compose.app.yml. A deployed process will not see it, ` +
        `however it is set on the box, and nothing will fail — the schema default ` +
        `applies silently. Either add it to the service that needs it, or add it to ` +
        `NOT_DEPLOYED in this file with a reason.`,
    ).toBe(true);
  });

  /**
   * Variables the compose file may hand over as an **empty string**.
   *
   * `${VAR:-}` does not mean "leave it unset". Docker Compose expands an unset
   * variable to an empty string and still sets the key, so the process receives
   * `VAR=''` rather than nothing at all. A schema that treats the field as
   * optional but validates it with `min(1)` therefore **refuses to boot** in
   * every environment that has not configured the feature — an optional thing
   * becoming a required one, discovered at deploy time rather than here.
   *
   * That is not hypothetical: it is what `CLOUDFLARE_ACCESS_*` did on 25 August
   * 2026, and the API stayed up only because the schema had been taught the
   * difference an hour earlier.
   *
   * Every variable written this way must therefore be listed with a note saying
   * its schema reads an empty value as absent. The list is not the control — the
   * schema is — but it is what makes the next person go and check.
   */
  const EMPTY_MEANS_ABSENT = {
    CLOUDFLARE_ACCESS_TEAM_DOMAIN:
      'absentWhenEmpty() in identity-env.ts maps an empty string to undefined, so an ' +
      'environment with no Cloudflare Access simply installs no prover',
    CLOUDFLARE_ACCESS_AUD:
      'absentWhenEmpty() in identity-env.ts maps an empty string to undefined; the ' +
      'both-or-neither rule then treats the pair as wholly absent',
  };

  it('accounts for every variable that can arrive as an empty string', () => {
    const text = readFileSync(COMPOSE, 'utf8');
    const bare = new Set();

    for (const line of text.split(/\r?\n/)) {
      // `NAME: ${NAME:-}` with nothing after the dash. A default value is fine —
      // `${LOG_LEVEL:-info}` can never arrive empty.
      const matched = line.match(
        /^ {6}([A-Z][A-Z0-9_]*):\s*\$\{[A-Z][A-Z0-9_]*:-\}\s*$/,
      );
      if (matched) bare.add(matched[1]);
    }

    for (const key of bare) {
      expect(
        typeof EMPTY_MEANS_ABSENT[key] === 'string' &&
          EMPTY_MEANS_ABSENT[key].length > 40,
        `${key} is written as \${${key}:-} in docker-compose.app.yml, so a deployed ` +
          `process receives it as an EMPTY STRING when it is not configured — not as ` +
          `absent. Make its schema read an empty value as absent (see absentWhenEmpty ` +
          `in identity-env.ts), then record here how it does so. Otherwise every ` +
          `environment without this feature refuses to boot.`,
      ).toBe(true);
    }
  });

  it('leaves no note behind for a variable that is no longer optional', () => {
    // Same rule as NOT_DEPLOYED below, for the same reason: a note about a
    // variable that has since become required reads as a decision about
    // something that is no longer true.
    //
    // **It is also what stops the check above going vacuous.** If the compose
    // file's indentation changes and the matcher stops finding anything, that
    // check passes by examining nothing — but this one fails, because every
    // note it holds then describes a line it can no longer find.
    const text = readFileSync(COMPOSE, 'utf8');
    const stale = Object.keys(EMPTY_MEANS_ABSENT).filter(
      (key) => !text.includes(`      ${key}: \${${key}:-}`),
    );

    expect(stale).toEqual([]);
  });

  it('excuses nothing that no schema declares', () => {
    /*
     * The other direction, and it is what stops this list becoming a graveyard.
     * A variable deleted from the schemas leaves its excuse behind, and the next
     * reader takes the entry as evidence of a decision about something that no
     * longer exists.
     */
    const stale = Object.keys(NOT_DEPLOYED).filter((key) => !DECLARED.includes(key));
    expect(stale).toEqual([]);
  });
});
