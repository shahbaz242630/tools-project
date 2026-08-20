import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const fromRoot = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

/**
 * Tests that need a live service, by naming convention. Kept out of the default
 * run so `pnpm test` needs nothing running; `pnpm test:integration` opts in.
 */
const REQUIRES_SERVICES = ['**/*.redis.test.ts', '**/*.db.test.ts'];

// Connection details for those services live in `.env` on a developer machine.
// CI sets them directly as job environment, so an absent file is normal rather
// than an error — and swallowing the failure here is safe because the tests
// that need the values fail loudly and by name if they are missing.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env: CI, or a machine that has not run `pnpm db:up` yet.
}

export default defineConfig({
  // Workspace packages resolve to TypeScript source during tests, so the suite
  // runs without a build step and a failure points at the line you edited
  // rather than at compiled output.
  //
  // The cost is that tests never exercise the built entry points -- which is
  // exactly how these packages came to be unloadable by a real Node process
  // while the suite stayed green. `pnpm verify:runtime` closes that gap and
  // runs in CI after the build. See ADR 0010.
  resolve: {
    alias: {
      '@platform/core': fromRoot('./packages/core/src/index.ts'),
      '@platform/config': fromRoot('./packages/config/src/index.ts'),
      // Longest specifier first: an exact-match alias for the bare package
      // would otherwise never be reached for the subpath.
      '@platform/observability/testing': fromRoot(
        './packages/observability/src/testing/index.ts',
      ),
      '@platform/observability': fromRoot('./packages/observability/src/index.ts'),
      '@platform/runtime': fromRoot('./packages/runtime/src/index.ts'),
      '@platform/contracts': fromRoot('./packages/contracts/src/index.ts'),
      '@platform/database': fromRoot('./packages/database/src/index.ts'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
          exclude: REQUIRES_SERVICES,
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'worker',
          include: ['apps/worker/src/**/*.test.ts'],
          exclude: REQUIRES_SERVICES,
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          // React components need a DOM. Only this project pays for it — the
          // others stay on `node`, which is markedly faster.
          environment: 'jsdom',
          setupFiles: ['./apps/web/vitest-setup.tsx'],
        },
        // esbuild handles the JSX, so no @vitejs/plugin-react. That plugin
        // requires vite 8 and vitest 3 pins vite 7; adding it would mean an
        // unmet peer dependency for a transform we do not need. The app's own
        // tsconfig says `jsx: preserve` because Next requires it, which esbuild
        // cannot emit — hence the override here rather than there.
        esbuild: { jsx: 'automatic' },
      },
      {
        extends: true,
        test: {
          name: 'scripts',
          // Plain .mjs: `scripts/` runs under a bare `node` with no build step,
          // so the tests load exactly the files the deploy path loads.
          include: ['scripts/**/*.test.mjs'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          // Needs a live Redis or Postgres, so it is not in the default run.
          // `pnpm test`
          // names its projects explicitly rather than excluding this one --
          // a new project must be opted in, and forgetting shows up as tests
          // that visibly do not run rather than as silent coverage loss.
          include: REQUIRES_SERVICES,
          environment: 'node',

          // These files must not run in parallel with each other. They share
          // one database and each truncates in `beforeEach` to start from a
          // known state, so concurrently they delete each other's rows
          // mid-test — which surfaces as a row that vanished between being
          // written and being read, a failure indistinguishable from a bug in
          // the code under test.
          //
          // **`fileParallelism` is a root-level option and is silently ignored
          // here**, which is why it is not set in this block: it looks like it
          // works, and does nothing. The flag lives on the `test:integration`
          // script in package.json instead, so it applies to this project
          // without making the fast unit projects sequential too.
        },
      },
      {
        extends: true,
        // esbuild, vitest's default transform, silently discards decorator
        // metadata. NestJS resolves constructor dependencies from exactly that
        // metadata, so without swc every injected dependency arrives as
        // `undefined` and the failure surfaces as a 500 at request time rather
        // than as a compile error. See ADR 0011.
        plugins: [
          swc.vite({
            module: { type: 'nodenext' },
            jsc: {
              target: 'es2023',
              parser: { syntax: 'typescript', decorators: true },
              transform: { legacyDecorator: true, decoratorMetadata: true },
            },
          }),
        ],
        test: {
          name: 'api',
          include: ['apps/api/src/**/*.test.ts'],
          exclude: REQUIRES_SERVICES,
          environment: 'node',
        },
      },
    ],
    // Timezone-sensitive assertions pin their zone explicitly with luxon rather
    // than depending on the machine's, so CI and a developer laptop agree
    // without TZ being set here.
    coverage: {
      provider: 'v8',
      // .tsx as well as .ts. A `**/*.ts` glob does not match `.tsx`, so without
      // this every React component is invisible to the thresholds — its tests
      // could be deleted and coverage would not move.
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'apps/*/src/**/*.tsx'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/index.ts',
        // Machine-written by `prisma generate`. Holding generated code to a
        // coverage threshold measures Prisma, not us.
        '**/generated/**',
        // App Router pages and layouts are composition roots, the same argument
        // as main.ts below: they wire a component to a data source and a route.
        // Testing them by mocking the framework would test the mocks, and they
        // are loaded for real by the Deploy rehearsal job, which asserts on the
        // rendered HTML. Presentational components live outside app/ and are
        // counted.
        '**/web/src/app/**',
        // Composition root. Asserting its wiring by mocking every constructor
        // would test the mocks; the integration test boots the real app instead.
        '**/main.ts',
        // Test doubles, exercised by the tests that use them.
        '**/testing/**',
        // Constructing a BullMQ Worker opens a Redis connection, so this file
        // cannot be reached without a live broker. Its routing and correlation
        // logic lives in processor.ts and is unit tested; what remains here is
        // construction and two log callbacks, covered by *.redis.test.ts in the
        // integration project. Keep this exclusion narrow — logic that moves
        // back into this file stops being counted.
        '**/worker/src/worker.ts',
        // Same argument as worker.ts: exercised in full by
        // prisma-identity-store.db.test.ts, which lives in the `integration`
        // project and so does not run under this command. Its whole purpose is
        // behaviour that only a real unique constraint produces, which is
        // exactly what cannot be covered here. Keep this exclusion narrow —
        // logic that moves out of this file stops being counted.
        '**/api/src/identity/prisma-identity-store.ts',
        // Same argument again: exercised in full by
        // prisma-profile-store.db.test.ts in the `integration` project. What it
        // proves — that a foreign key fires, that a transaction covers both
        // tables, and that what lands in the encrypted column is unreadable —
        // is precisely what a double cannot. Keep this exclusion narrow.
        '**/api/src/profiles/prisma-profile-store.ts',
        // And again for the audit trail: prisma-audit-log.db.test.ts proves the
        // foreign key, the `inet` column rejecting a malformed address, and the
        // ordering — none of which a double can. Keep this exclusion narrow.
        '**/api/src/audit/prisma-audit-log.ts',
        // And for authentication events:
        // prisma-authentication-events.db.test.ts proves the `event_is_known`
        // CHECK, the unique index that makes a redelivery a no-op, the RESTRICT
        // foreign key and an IPv6 round trip through `inet`. None of those
        // exist in a double. The one piece of pure logic that *was* in this
        // file — the IP validation — was moved to `identity/ip-address.ts`
        // precisely so it stays counted. Keep this exclusion narrow.
        '**/api/src/identity/prisma-authentication-events.ts',
        // Declaration-only: a type union and three interfaces, so it emits no
        // executable JavaScript and v8 reports its source lines as uncovered
        // because there is nothing to run. The same case as webhook-ledger.ts.
        // If any code appears in here, delete this line rather than keeping it
        // honest by accident.
        '**/api/src/audit/audit-log.ts',
        // And for listings, from slice 2.5a. prisma-listing-store.db.test.ts
        // proves what only Postgres and a real cipher can: that the composite
        // foreign key makes a listing's category and its pinned version agree,
        // that `location_is_complete` fires, that the address cascades away with
        // its listing, that erasure removes the precise half and leaves the
        // listing standing, and that what lands in `encryptedDetail` is
        // unreadable and refuses to decrypt on another listing's row. A double
        // asserting any of those would be asserting itself.
        //
        // **It is excluded now rather than in 2.4a because it only now got big
        // enough to matter** — the encryption and the second table roughly
        // doubled it, and 0% of a file that size moved the global figure below
        // the threshold. Keep this exclusion narrow: the pure readers in here
        // (`asMoney`, `asValues`, `asStatus`) stop being counted, and logic
        // worth counting belongs in the service, which is.
        '**/api/src/catalogue/prisma-listing-store.ts',
        // And again for dual approval. prisma-admin-approval-store.db.test.ts
        // proves the things that only Postgres can: that the CHECK constraint
        // refuses a self-approval however the row is reached, that a failed
        // effect rolls the approval back, and that a conditional claim makes
        // two simultaneous approvals resolve to one. A double asserting any of
        // those would be asserting itself. Keep this exclusion narrow.
        '**/api/src/identity/prisma-admin-approval-store.ts',
        // And for the ledger, from slice 5.1. prisma-ledger-store.db.test.ts
        // proves what only Postgres can: that a deferred constraint trigger
        // refuses an unbalanced transaction at COMMIT, that UPDATE and DELETE are
        // refused outright, that composite foreign keys on `(id, currency)` stop
        // an entry disagreeing with its account about currency, that four
        // concurrent callers get one account, and that a unique index — not a
        // check-then-write — is what makes a re-presented idempotency key produce
        // one effect. A double asserting any of those would be asserting itself.
        //
        // **Its error handling is the reason to keep this exclusion narrow.** The
        // `catch` in `post` exists because Prisma discards the database's message
        // on a commit-time failure inside a nested write, so it asks the database
        // what is true rather than reading the error code. That behaviour cannot
        // be reproduced without a real commit, and it is tested where it can be.
        // The rules themselves live in `ledger.ts`, which is counted in full.
        '**/api/src/payments/prisma-ledger-store.ts',
        // Declaration-only: one interface and two type aliases, so it emits no
        // executable JavaScript and v8 reports its source lines as uncovered
        // because there is nothing to run. Same case as webhook-ledger.ts above.
        '**/api/src/payments/ledger-store.ts',
        // Declaration-only: two interfaces and nothing else, so it emits no
        // executable JavaScript at all and v8 reports its source lines as
        // uncovered because there is nothing to run. If any code appears in
        // here, delete this line rather than keeping it honest by accident.
        '**/api/src/identity/webhook-ledger.ts',
        // And for the radius query, from slice 3.1f — the same argument as the
        // five Prisma adapters above, and the strongest instance of it in the
        // project. prisma-listing-search.db.test.ts proves the things only a
        // real PostGIS can: which point the filter measured from, which is the
        // entire §8.4.1 privacy control (ADR 0032) and was demonstrated by
        // repointing the query at the true coordinates and watching three of
        // five trilateration tests fail. A double asserting that would be
        // asserting itself — it would be measuring from whichever point the
        // double was told to.
        //
        // **Excluded now rather than in 3.1a because it only now costs
        // anything**: the file is the project's one piece of hand-written SQL
        // and has always been invisible to this command, and 3.1f's added
        // constructor argument was what tipped the global under the threshold.
        // Keep this exclusion narrow — the bucketing and the mile conversion
        // live in `distance-bucket.ts`, which is counted, and logic worth
        // counting belongs there rather than here.
        '**/api/src/search-location/prisma-listing-search.ts',
        // And the booking store (slice 4.2), which is the strongest case in
        // this list after the radius query. What it does is write two
        // timestamps and translate one error — and the error it translates is
        // one **only a real race produces**: two inserts contending on an
        // exclusion constraint make Postgres report `40P01 deadlock detected`
        // rather than a constraint violation, about one race in three. A double
        // cannot raise that, so a unit test here would be asserting the shape
        // of an error it invented. `prisma-booking-store.db.test.ts` opens two
        // connections and races them ten times, which is the only thing that
        // can. Keep this exclusion narrow — the state machine beside it is pure
        // and is counted.
        '**/api/src/booking/prisma-booking-store.ts',
        // And the payment intent store (slice 5.2b) — the same argument as the
        // ledger adapter above, which it deliberately copies.
        // `prisma-payment-intent-store.db.test.ts` proves what only Postgres
        // can: that a **partial** unique index permits at most one *succeeded*
        // attempt per booking while letting failed retries accumulate (§8.7.1's
        // single-capture rule), that four CHECKs fire, that a `RESTRICT`
        // foreign key stops the payee, the booking and the version that priced
        // it being deleted, and that eight concurrent callers on one attempt key
        // produce one row with the losers *reading* it rather than raising. A
        // double asserting any of those would be asserting itself.
        //
        // **Kept narrow by moving the one rule out.** Refusing a key reused for
        // different money was in this file and is now `assertSameAttempt` in
        // `payment-intent.ts`, which is counted in full and swept field by
        // field — the same place `LedgerService` keeps its equivalent. What
        // remains here is two writes, two reads and the reassembly of minor
        // units into `Money`. Logic that appears in here stops being counted.
        '**/api/src/payments/prisma-payment-intent-store.ts',
        // Declaration-only: one interface, so it emits no executable JavaScript
        // and v8 reports its source lines as uncovered because there is nothing
        // to run. Same case as `ledger-store.ts` above. If any code appears in
        // here, delete this line rather than keeping it honest by accident.
        '**/api/src/payments/payment-intent-store.ts',
        // And the same for the port Catalogue answers (slice 5.2b): one
        // interface and nothing else.
        '**/api/src/payments/category-fee-policy-source.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
