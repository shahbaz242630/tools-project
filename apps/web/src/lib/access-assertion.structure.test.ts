/**
 * Every authenticated API call must forward the Access assertion.
 *
 * **This test exists because the alternative is a rule nobody applies.** The
 * web app has no single place where outbound headers are built — thirteen
 * modules each spell out their own object — so "remember to add it" is not a
 * mechanism. A new authenticated call site that omits the assertion produces an
 * administrator who is refused their own admin surface, on a correctly-signed
 * session, with nothing failing anywhere: the API is right to refuse, the page
 * is right to show the refusal, and the omission is three files away.
 *
 * It reads the files off disk rather than importing them, the same shape as
 * `decorated-routes.test.ts` in the API, which fails on a rate-limited route
 * that is not behind the auth guard. Both are structural rules that a type
 * system cannot express.
 *
 * **What makes a call "authenticated" here is that it sends an Authorization
 * header.** That is the honest definition: those are exactly the calls made on
 * behalf of a signed-in person, and therefore exactly the ones that may reach a
 * route requiring an administrator's second factor.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Vitest runs with its config's directory — the repository root — as the
 * working directory, not the package's. `decorated-routes.test.ts` documents
 * the same trap and resolves it the same way.
 */
const LIB = join(process.cwd(), 'apps', 'web', 'src', 'lib');

/**
 * Modules that send an Authorization header, and are therefore in scope.
 *
 * Derived rather than listed. A hand-written list is a second place to forget
 * the thing this test exists to stop being forgotten.
 */
function authenticatedModules(): { readonly name: string; readonly source: string }[] {
  if (!existsSync(LIB)) {
    throw new Error(`expected ${LIB} to exist — this test is reading the wrong place`);
  }

  return readdirSync(LIB)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, source: readFileSync(join(LIB, name), 'utf8') }))
    .filter(({ source }) => sendsAuthorization(source));
}

/**
 * Both spellings, because the codebase uses both: `[AUTHORIZATION_HEADER]:` at
 * twelve assembly points and a bare lowercase `authorization:` in `profile.ts`.
 * Matching only the constant would quietly exempt the one that is different.
 *
 * **It matches the assembly form, never a bare mention of the name, and the
 * first draft of this file got that wrong.** A plain
 * `includes('AUTHORIZATION_HEADER')` also matched the *prose* in
 * `correlation.ts`'s docblock — a module that assembles no outbound request at
 * all — so this test demanded that `correlation.ts` forward the assertion, and
 * the only way to satisfy that would have been to fold it into
 * `correlationHeaders()`. That is exactly the design `access-assertion.ts`
 * refuses, because those headers are spread into public calls too. **A test
 * that fails until you make the change it exists to prevent is worse than no
 * test at all.**
 */
function sendsAuthorization(source: string): boolean {
  return (
    /\[AUTHORIZATION_HEADER\]\s*:/.test(source) ||
    /["']authorization["']\s*:/.test(source) ||
    /\bauthorization:\s*`Bearer/.test(source)
  );
}

describe('forwarding the Cloudflare Access assertion', () => {
  const modules = authenticatedModules();

  it('finds the modules it is supposed to be checking', () => {
    // Guard against vacuity. A rename, a moved directory or a changed header
    // constant would otherwise turn this whole file into a test that passes by
    // examining nothing — which is worse than not having it.
    expect(modules.length).toBe(13);
    // Named explicitly: it assembles no outbound request and must never be
    // swept in — see `sendsAuthorization` for what happened when it was.
    expect(modules.map((module) => module.name)).not.toContain('correlation.ts');
    expect(modules.map((module) => module.name)).toContain('listings.ts');
    expect(modules.map((module) => module.name)).toContain('admin-categories.ts');
  });

  it.each(modules.map((module) => module.name))(
    '%s spreads accessAssertionHeaders into its request',
    (name) => {
      const source = modules.find((module) => module.name === name)?.source ?? '';

      expect(
        source.includes('accessAssertionHeaders'),
        `${name} sends an Authorization header but does not forward the Cloudflare Access ` +
          `assertion. Any route it reaches that requires ADMIN will refuse the administrator, ` +
          `and nothing else will fail. Spread '...(await accessAssertionHeaders())' beside ` +
          `the correlation headers, or — if this module genuinely cannot reach an admin ` +
          `route — say so here rather than leaving the next reader to work it out.`,
      ).toBe(true);
    },
  );

  it('does not forward it on unauthenticated calls', () => {
    // The data-minimisation half, and the reason this is not simply folded into
    // `correlationHeaders`. The assertion carries an administrator's email; a
    // signed-out stranger's search has no use for it.
    const publicOnly = ['readiness.ts', 'clerk-webhook.ts'];

    for (const name of publicOnly) {
      const path = join(LIB, name);
      if (!existsSync(path)) continue;

      expect(
        readFileSync(path, 'utf8').includes('accessAssertionHeaders'),
        `${name} makes no authenticated call and must not carry the assertion`,
      ).toBe(false);
    }
  });
});
