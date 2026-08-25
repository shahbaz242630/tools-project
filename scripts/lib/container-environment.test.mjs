import { describe, expect, it } from 'vitest';
import { envFileValuesIn, passThroughKeysIn } from './container-environment.mjs';

/**
 * The parsing behind the deploy's "do the containers carry what is on disk"
 * check.
 *
 * **A false positive here breaks every deploy**, so the parsing is pure and
 * tested rather than exercised only by the `Deploy rehearsal` job. The rest of
 * `deploy.mjs` drives Docker and is covered there; these two are string work
 * and belong under a microscope.
 *
 * The check exists because of 25 August 2026, when two variables were right in
 * `staging.env`, right in the compose file, and correctly resolved by
 * `docker compose config` — and empty inside the running API, because the
 * containers predated the edit. Health, readiness and the image tag all said
 * the deploy had worked.
 */

describe('passThroughKeysIn', () => {
  it('finds a variable forwarded under its own name', () => {
    const compose = `    environment:
      CLERK_JWT_PUBLIC_KEY: \${CLERK_JWT_PUBLIC_KEY:?set it}
`;

    expect([...passThroughKeysIn(compose)]).toEqual(['CLERK_JWT_PUBLIC_KEY']);
  });

  it('finds one that may arrive empty', () => {
    const compose = `      CLOUDFLARE_ACCESS_AUD: \${CLOUDFLARE_ACCESS_AUD:-}\n`;

    expect([...passThroughKeysIn(compose)]).toEqual(['CLOUDFLARE_ACCESS_AUD']);
  });

  it('ignores a value built from a differently-named variable', () => {
    // **The reason this function exists at all.** Comparing the container's
    // `POSTGRES_URL` against the env file's `POSTGRES_PASSWORD` would be
    // comparing two unrelated things and reporting drift on every deploy.
    const compose = `      POSTGRES_URL: \${POSTGRES_PASSWORD:?set it}\n`;

    expect([...passThroughKeysIn(compose)]).toEqual([]);
  });

  it('ignores a literal, which is not forwarded at all', () => {
    const compose = `      NODE_ENV: production\n`;

    expect([...passThroughKeysIn(compose)]).toEqual([]);
  });

  it('ignores anything not at an environment block’s indentation', () => {
    // Service names, top-level keys and list items all live at other depths.
    const compose = `  api:\n    image: \${IMAGE:?}\n        DEEP: \${DEEP:?}\n`;

    expect([...passThroughKeysIn(compose)]).toEqual([]);
  });

  it('reads a file with Windows line endings', () => {
    const compose = '      A_KEY: ${A_KEY:-}\r\n      B_KEY: ${B_KEY:?x}\r\n';

    expect([...passThroughKeysIn(compose)]).toEqual(['A_KEY', 'B_KEY']);
  });
});

describe('envFileValuesIn', () => {
  it('reads plain assignments', () => {
    expect(envFileValuesIn('FOO=bar\nBAZ=qux\n')).toEqual(
      new Map([
        ['FOO', 'bar'],
        ['BAZ', 'qux'],
      ]),
    );
  });

  it('drops empty values, because they cannot disagree with anything', () => {
    // An empty value in the file and an empty value in the container are the
    // same state. Reporting that as drift would flag every optional variable
    // in every environment that has not configured it.
    expect(envFileValuesIn('FOO=\nBAR=set\n')).toEqual(new Map([['BAR', 'set']]));
  });

  it('ignores comments and blank lines', () => {
    expect(envFileValuesIn('# a note\n\nFOO=bar\n')).toEqual(new Map([['FOO', 'bar']]));
  });

  it('keeps a value containing an equals sign', () => {
    // Base64 and connection strings both do this, and splitting on every `=`
    // would silently truncate a secret and then report it as drift.
    expect(envFileValuesIn('KEY=abc==\n')).toEqual(new Map([['KEY', 'abc==']]));
  });

  it('strips surrounding quotes', () => {
    expect(envFileValuesIn('FOO="bar"\nBAZ=\'qux\'\n')).toEqual(
      new Map([
        ['FOO', 'bar'],
        ['BAZ', 'qux'],
      ]),
    );
  });

  it('trims trailing whitespace, which a container will not have', () => {
    expect(envFileValuesIn('FOO=bar   \n')).toEqual(new Map([['FOO', 'bar']]));
  });

  it('reads a file with Windows line endings', () => {
    expect(envFileValuesIn('FOO=bar\r\nBAZ=qux\r\n')).toEqual(
      new Map([
        ['FOO', 'bar'],
        ['BAZ', 'qux'],
      ]),
    );
  });

  it('ignores a lowercase or malformed line rather than guessing', () => {
    expect(envFileValuesIn('foo=bar\nnot a line\n=novalue\n')).toEqual(new Map());
  });
});

describe('the two together, against the real files’ shapes', () => {
  it('reports drift only for a forwarded key the container disagrees about', () => {
    const compose = `      SHARED: \${SHARED:-}\n      BUILT: \${OTHER:?x}\n`;
    const envFile = 'SHARED=expected\nOTHER=ignored\nUNUSED=nothing\n';

    const passThrough = passThroughKeysIn(compose);
    const expected = envFileValuesIn(envFile);

    // What the deploy compares: only SHARED is both forwarded by name and set.
    const comparable = [...expected.keys()].filter((key) => passThrough.has(key));

    expect(comparable).toEqual(['SHARED']);
  });
});
