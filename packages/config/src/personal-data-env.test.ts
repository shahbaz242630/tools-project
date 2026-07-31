import { describe, expect, it } from 'vitest';
import { EnvironmentError } from './env.js';
import { loadPersonalDataEnv } from './personal-data-env.js';

/**
 * A correctly-shaped key, computed rather than written down.
 *
 * 32 zero bytes. Any literal that satisfies this schema is 44 characters of
 * base64, which is indistinguishable from a real key to a secret scanner — and
 * a scanner that reports a fixture on every run is one whose findings stop
 * being read. Deriving it keeps the file free of anything that looks like a
 * secret, with no allowlist entry to maintain and nothing to take on trust.
 */
const KEY = Buffer.alloc(32).toString('base64');
const SHORT_KEY = Buffer.alloc(16).toString('base64');

const valid = { PERSONAL_DATA_ENCRYPTION_KEY: KEY };

describe('loadPersonalDataEnv', () => {
  it('accepts a base64 32-byte key', () => {
    expect(loadPersonalDataEnv(valid).PERSONAL_DATA_ENCRYPTION_KEY).toBe(KEY);
  });

  it('requires the key', () => {
    expect(() => loadPersonalDataEnv({})).toThrow(EnvironmentError);
  });

  it.each([
    ['a 16-byte key', SHORT_KEY],
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
