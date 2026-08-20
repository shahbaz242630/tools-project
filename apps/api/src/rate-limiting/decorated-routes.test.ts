import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every rate-limited route is behind something that can identify the caller.
 *
 * **The hole this closes is in `RateLimitGuard` itself.** When no account is on
 * the request it logs and returns `true`, because reaching that state means a
 * wiring mistake rather than caller behaviour, and inventing a shared key would
 * put every anonymous caller in one bucket. The consequence is that a route
 * decorated `@RateLimit` but *not* behind `AuthGuard` is **silently unlimited** —
 * it looks limited in the source, it passes every test that drives the guard
 * directly, and it warns into a log nobody reads.
 *
 * **It reads the controllers off disk rather than listing them**, which is the
 * fix #165 applied to the sign-in proxy's route test for the same reason: a
 * hand-written list is a test that cannot see a new route. A controller added
 * next year is checked by this without anybody remembering it exists.
 */
const CONTROLLERS = (() => {
  /*
   * From the repository root rather than from `import.meta.url`, which
   * `apps/api` cannot use: it compiles to CommonJS for NestJS's decorator
   * metadata (ADR 0011), and TypeScript refuses the meta-property in a file
   * headed for CJS output. Vitest runs with its config's directory as the cwd.
   *
   * The `existsSync` throw matters more than it looks: a wrong path here would
   * yield zero controllers and make every assertion below vacuously true, which
   * is the exact failure mode of a test that reads the tree.
   */
  const root = join(process.cwd(), 'apps', 'api', 'src');
  if (!existsSync(root)) {
    throw new Error(`Cannot find the API source at ${root} — check the cwd.`);
  }
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.controller.ts')) found.push(path);
    }
  };

  walk(root);
  return found.map((path) => ({
    path,
    name: relative(root, path).replaceAll('\\', '/'),
    source: readFileSync(path, 'utf8'),
  }));
})();

const limited = CONTROLLERS.filter((file) => file.source.includes('@RateLimit('));
const guarded = CONTROLLERS.filter((file) => file.source.includes('RateLimitGuard'));
const publicFacing = CONTROLLERS.filter((file) => file.name.includes('public'));

describe('every rate-limited route can name its caller (slice H7a)', () => {
  it('found the controllers to check, rather than quietly checking none', () => {
    // A traversal that silently returned nothing would make every assertion
    // below vacuously true — the failure mode of a test that reads the tree.
    expect(CONTROLLERS.length).toBeGreaterThan(5);
  });

  it('has at least one rate-limited controller, so this is not vacuous either', () => {
    expect(limited.length).toBeGreaterThan(0);
  });

  it.each(limited)(
    '$name is behind AuthGuard, so the limit has an account to key on',
    ({ source }) => {
      /*
       * `@UseGuards(AuthGuard, RateLimitGuard)` — the order matters as much as
       * the presence. Nest runs guards in the order given, so `RateLimitGuard`
       * first would see no `request.user` and let everything through.
       */
      const guards = source.match(/@UseGuards\(([^)]*)\)/)?.[1] ?? '';

      expect(guards).toContain('AuthGuard');
      expect(guards).toContain('RateLimitGuard');
      expect(guards.indexOf('AuthGuard')).toBeLessThan(
        guards.indexOf('RateLimitGuard'),
      );
    },
  );

  it.each(guarded)(
    '$name does not apply the guard without decorating any route',
    ({ source }) => {
      // The mirror mistake: the guard wired on, no tier declared, and every
      // route through it unlimited while the class reads as protected.
      expect(source).toContain('@RateLimit(');
    },
  );

  /**
   * Public controllers must stay out, and this is the one that would rot
   * quietly. Decorating a public route would not fail — it would warn once per
   * request into a log and limit nothing, which is worse than leaving it off,
   * because the source would then claim a control that is not there.
   */
  it.each(publicFacing)(
    '$name is not decorated, because it has no account to key on',
    ({ source }) => {
      expect(source).not.toContain('@RateLimit(');
    },
  );
});
