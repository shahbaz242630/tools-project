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

describe('the admin MFA escape hatch', () => {
  it('is off when the variable is absent', () => {
    expect(loadIdentityEnv(valid).DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA).toBe(false);
  });

  it.each(['false', 'FALSE', '0', 'no', ''])('is off for %j', (value) => {
    // `z.coerce.boolean()` would read every one of these as **true**, including
    // the literal string "false". For a flag that removes an authentication
    // check, that is the worst possible default.
    const env = { ...valid, DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA: value };
    const result = (() => {
      try {
        return loadIdentityEnv(env).DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA;
      } catch {
        return false;
      }
    })();
    expect(result).toBe(false);
  });

  it('is on only for the exact string "true"', () => {
    expect(
      loadIdentityEnv({ ...valid, DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA: 'true' })
        .DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA,
    ).toBe(true);
  });

  it('refuses to start in production rather than quietly ignoring it', () => {
    // Both outcomes end with MFA enforced. Only this one tells somebody that
    // what they configured is not what they got.
    expect(() =>
      loadIdentityEnv({
        ...valid,
        NODE_ENV: 'production',
        DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA: 'true',
      }),
    ).toThrow(EnvironmentError);
  });

  it('says why, naming the rule it would break', () => {
    try {
      loadIdentityEnv({
        ...valid,
        NODE_ENV: 'production',
        DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA: 'true',
      });
    } catch (error) {
      expect((error as EnvironmentError).problems.join(' ')).toMatch(
        /second-factor check/,
      );
      return;
    }
    throw new Error('expected the environment to be refused');
  });

  it('leaves production alone when it is not set', () => {
    expect(() => loadIdentityEnv({ ...valid, NODE_ENV: 'production' })).not.toThrow();
  });

  it('allows it in test, so the guard can be exercised both ways', () => {
    expect(
      loadIdentityEnv({
        ...valid,
        NODE_ENV: 'test',
        DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA: 'true',
      }).DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA,
    ).toBe(true);
  });
});

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
    //
    // `NODE_ENV` appears in both loaders and that is not a second source of
    // truth: this schema needs it to decide whether its own escape hatch is
    // allowed, which is a judgement it cannot make without knowing where it is
    // running.
    expect(Object.keys(loadIdentityEnv(valid))).toEqual([
      'NODE_ENV',
      'CLERK_JWT_PUBLIC_KEY',
      'CLERK_AUTHORIZED_PARTIES',
      'DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA',
    ]);
  });
});

/**
 * Cloudflare Access as a second-factor provider (ADR 0053, slice H8b).
 *
 * Both variables are optional — absent means the adapter is not installed, which
 * is the correct state on a laptop, because Access protects a public hostname
 * and cannot see `localhost`.
 */
describe('the Cloudflare Access second factor', () => {
  const AUD = 'a'.repeat(64);
  const DOMAIN = 'https://spring-river-c250.cloudflareaccess.com';

  const withAccess = (overrides: Record<string, string>) =>
    loadIdentityEnv({
      ...valid,
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: DOMAIN,
      CLOUDFLARE_ACCESS_AUD: AUD,
      ...overrides,
    });

  it('is absent by default, so nothing is installed', () => {
    const env = loadIdentityEnv(valid);

    expect(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN).toBeUndefined();
    expect(env.CLOUDFLARE_ACCESS_AUD).toBeUndefined();
  });

  describe('an empty string means absent, not invalid', () => {
    // **Not a nicety.** `docker-compose.app.yml` writes
    // `${CLOUDFLARE_ACCESS_TEAM_DOMAIN:-}`, and Compose expands an unset
    // variable to an empty string rather than omitting the key. Without this,
    // every deployed environment that has not configured Access would hand the
    // schema `''` and the API would refuse to boot — an optional feature
    // becoming a required one, discovered at deploy time.
    it('treats both empty strings as not configured', () => {
      const env = loadIdentityEnv({
        ...valid,
        CLOUDFLARE_ACCESS_TEAM_DOMAIN: '',
        CLOUDFLARE_ACCESS_AUD: '',
      });

      expect(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN).toBeUndefined();
      expect(env.CLOUDFLARE_ACCESS_AUD).toBeUndefined();
    });

    it('still refuses an empty domain beside a real audience', () => {
      // Empty means absent, and absent beside a present one is still the
      // half-configured state the both-or-neither rule exists to catch.
      expect(() =>
        loadIdentityEnv({
          ...valid,
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: '',
          CLOUDFLARE_ACCESS_AUD: AUD,
        }),
      ).toThrow(EnvironmentError);
    });
  });

  it('accepts a team domain and an audience together', () => {
    const env = withAccess({});

    expect(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN).toBe(DOMAIN);
    expect(env.CLOUDFLARE_ACCESS_AUD).toBe(AUD);
  });

  describe('both or neither', () => {
    it('refuses a team domain with no audience', () => {
      // The dangerous half. Without an audience the adapter would verify a
      // token minted for *any* Access application in the account — a weaker
      // check that looks like a working one.
      expect(() =>
        loadIdentityEnv({ ...valid, CLOUDFLARE_ACCESS_TEAM_DOMAIN: DOMAIN }),
      ).toThrow(EnvironmentError);
    });

    it('refuses an audience with no team domain', () => {
      expect(() => loadIdentityEnv({ ...valid, CLOUDFLARE_ACCESS_AUD: AUD })).toThrow(
        EnvironmentError,
      );
    });

    it('says which one is missing', () => {
      expect(() =>
        loadIdentityEnv({ ...valid, CLOUDFLARE_ACCESS_TEAM_DOMAIN: DOMAIN }),
      ).toThrow(/CLOUDFLARE_ACCESS_AUD/);
    });
  });

  describe('the team domain', () => {
    it('refuses a trailing slash', () => {
      // The certs path is appended to it, and the value is compared against the
      // token's `iss`. A slash breaks both — as a verification error on every
      // request, pointing at the token rather than at this variable.
      expect(() => withAccess({ CLOUDFLARE_ACCESS_TEAM_DOMAIN: `${DOMAIN}/` })).toThrow(
        EnvironmentError,
      );
    });

    it('refuses a bare hostname with no scheme', () => {
      // `iss` carries the scheme, so a bare hostname silently never matches.
      expect(() =>
        withAccess({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: 'spring-river-c250.cloudflareaccess.com',
        }),
      ).toThrow(EnvironmentError);
    });

    it('refuses plain http', () => {
      expect(() =>
        withAccess({
          CLOUDFLARE_ACCESS_TEAM_DOMAIN: 'http://team.cloudflareaccess.com',
        }),
      ).toThrow(EnvironmentError);
    });
  });

  describe('the audience tag', () => {
    it.each([
      ['the application name', 'admin'],
      ['a UUID', '3f700d7b-4fe9-413e-bed0-380e233830e4'],
      ['too short', 'a'.repeat(63)],
      ['too long', 'a'.repeat(65)],
      ['uppercase hex', 'A'.repeat(64)],
      ['not hex', 'z'.repeat(64)],
    ])('refuses %s', (_label, value) => {
      // Pasting the name or the UUID instead of the AUD tag is an easy mistake,
      // and both would otherwise fail as an opaque verification error on every
      // admin request rather than at startup.
      expect(() => withAccess({ CLOUDFLARE_ACCESS_AUD: value })).toThrow(
        EnvironmentError,
      );
    });
  });
});
