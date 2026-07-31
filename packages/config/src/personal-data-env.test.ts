import { describe, expect, it } from 'vitest';
import { EnvironmentError } from './env.js';
import { loadPersonalDataEnv } from './personal-data-env.js';

/**
 * A correctly-shaped key that is obviously not a real one.
 *
 * Decodes to `test-only-not-a-real-key-32-byte`, so anybody reading a secret
 * scanner's report can confirm it is a fixture without having to trust an
 * allowlist entry. Random-looking base64 here would be indistinguishable from
 * a leaked key, which is how a real one eventually gets ignored.
 */
const KEY = 'dGVzdC1vbmx5LW5vdC1hLXJlYWwta2V5LTMyLWJ5dGU=';

const valid = { PERSONAL_DATA_ENCRYPTION_KEY: KEY };

describe('loadPersonalDataEnv', () => {
  it('accepts a base64 32-byte key', () => {
    expect(loadPersonalDataEnv(valid).PERSONAL_DATA_ENCRYPTION_KEY).toBe(KEY);
  });

  it('requires the key', () => {
    expect(() => loadPersonalDataEnv({})).toThrow(EnvironmentError);
  });

  it.each([
    ['a 16-byte key', 'dG9vLXNob3J0LTE2Ynl0ZQ=='],
    ['a 64-byte key', `${KEY.slice(0, -1)}${KEY}`],
    ['hex rather than base64', 'a'.repeat(64)],
    ['a passphrase', 'correct horse battery staple'],
    ['empty', ''],
    ['base64 with an illegal character', `${KEY.slice(0, 42)}$=`],
    ['the right length but unpadded', KEY.slice(0, 43)],
  ])('rejects %s', (_label, value) => {
    // Length is checked at startup rather than at first use. A short key
    // otherwise throws inside createCipheriv on whichever request first saves
    // an address — long after the deploy that introduced it, and pointing at
    // the cipher rather than at the variable.
    expect(() => loadPersonalDataEnv({ PERSONAL_DATA_ENCRYPTION_KEY: value })).toThrow(
      EnvironmentError,
    );
  });

  it('says how to generate a correct key', () => {
    // The error a person actually meets. "Invalid string" would send them to
    // the schema; naming the command ends it in one step.
    try {
      loadPersonalDataEnv({ PERSONAL_DATA_ENCRYPTION_KEY: 'nope' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as EnvironmentError).problems.join('\n')).toContain(
        'openssl rand -base64 32',
      );
    }
  });

  it('is separate from loadEnv so the worker cannot decrypt addresses', () => {
    // Least privilege, and the same lesson as loadIdentityEnv: a shared schema
    // hands every process the newest service's secrets. A queue consumer has no
    // reason to be able to read a home address.
    expect(Object.keys(loadPersonalDataEnv(valid))).toEqual([
      'PERSONAL_DATA_ENCRYPTION_KEY',
    ]);
  });
});
