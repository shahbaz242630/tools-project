import { describe, expect, it } from 'vitest';
import { EnvironmentError } from './env.js';
import { loadIdentityEnv } from './identity-env.js';

/**
 * A minimal PEM public key. Structurally real — generated, not invented — so
 * the schema's prefix check is exercised against something that would actually
 * parse rather than a string that merely starts with the right characters.
 */
const PEM_ONE_LINE =
  '-----BEGIN PUBLIC KEY-----\\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\\n-----END PUBLIC KEY-----\\n';

const valid = {
  CLERK_JWT_PUBLIC_KEY: PEM_ONE_LINE,
  CLERK_AUTHORIZED_PARTIES: 'http://localhost:3000',
};

describe('loadIdentityEnv', () => {
  it('unescapes the PEM into real newlines', () => {
    // Stored on one line because dotenv has no multi-line syntax we can rely on
    // across a shell, node --env-file and Docker Compose. Handed to the JOSE
    // library still escaped, it fails to parse as a key.
    const key = loadIdentityEnv(valid).CLERK_JWT_PUBLIC_KEY;
    expect(key).toContain('\n');
    expect(key).not.toContain('\\n');
    expect(key.split('\n')[0]).toBe('-----BEGIN PUBLIC KEY-----');
  });

  it('accepts a PEM that already has real newlines', () => {
    // A secret manager supplies one this way. Unescaping must be idempotent
    // rather than assuming the dotenv shape.
    const real = PEM_ONE_LINE.replace(/\\n/g, '\n');
    expect(
      loadIdentityEnv({ ...valid, CLERK_JWT_PUBLIC_KEY: real }).CLERK_JWT_PUBLIC_KEY,
    ).toBe(real);
  });

  it.each([
    ['sk_live_not_a_key'],
    ['-----BEGIN RSA PRIVATE KEY-----\\nMIIB\\n-----END RSA PRIVATE KEY-----'],
    ['-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----'],
  ])('rejects %j as a JWT public key', (value) => {
    // Without the prefix check these fail inside the JOSE library on the first
    // request as an opaque decode error, pointing at the request rather than at
    // the variable. The private-key case matters most: pasting the wrong half
    // of a key pair is exactly the mistake that should never reach runtime.
    expect(() => loadIdentityEnv({ ...valid, CLERK_JWT_PUBLIC_KEY: value })).toThrow(
      EnvironmentError,
    );
  });

  it('splits authorized parties on commas and trims them', () => {
    const env = loadIdentityEnv({
      ...valid,
      CLERK_AUTHORIZED_PARTIES: ' https://a.example , https://b.example ',
    });
    expect(env.CLERK_AUTHORIZED_PARTIES).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it.each([[''], [','], ['  ,  ']])(
    'rejects %j as an authorized-party list',
    (value) => {
      // An empty list disables the azp check entirely, which is worse than a
      // missing variable because the API starts and accepts tokens minted by any
      // Clerk application on the same instance.
      expect(() =>
        loadIdentityEnv({ ...valid, CLERK_AUTHORIZED_PARTIES: value }),
      ).toThrow(EnvironmentError);
    },
  );

  it('reports every problem at once', () => {
    try {
      loadIdentityEnv({});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentError);
      const { problems } = error as EnvironmentError;
      expect(problems.join('\n')).toContain('CLERK_JWT_PUBLIC_KEY');
      expect(problems.join('\n')).toContain('CLERK_AUTHORIZED_PARTIES');
    }
  });

  it('asks for no Clerk secret', () => {
    // The whole point of this schema. The API verifies signatures with a public
    // key and holds nothing that could mint a session or read the directory —
    // this fails the moment someone adds a secret to it.
    const env = loadIdentityEnv({
      ...valid,
      CLERK_SECRET_KEY: 'sk_live_should_never_reach_the_api',
      CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_belongs_to_the_web_app',
    });

    expect(env).not.toHaveProperty('CLERK_SECRET_KEY');
    expect(env).not.toHaveProperty('CLERK_WEBHOOK_SIGNING_SECRET');
  });

  it('is separate from loadEnv so the worker need not carry it', () => {
    // A queue consumer has nothing to do with identity. Folding these fields
    // into the shared schema made the worker refuse to start without a JWT key
    // — and every later service would have inherited that.
    expect(Object.keys(loadIdentityEnv(valid))).toEqual([
      'CLERK_JWT_PUBLIC_KEY',
      'CLERK_AUTHORIZED_PARTIES',
    ]);
  });
});
