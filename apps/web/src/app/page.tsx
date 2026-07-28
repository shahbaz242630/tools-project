import { BRAND, isBrandPlaceholder } from '@platform/config';
import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>{BRAND.name}</h1>

      {isBrandPlaceholder() ? (
        // Honest rather than decorative. The name genuinely is not decided, and
        // a placeholder that looked like a finished brand would be a lie in the
        // one place a reviewer looks first.
        <p>
          This is a scaffold. The brand name is not yet decided and lives in one file (
          <code>packages/config/src/brand.ts</code>); everything here reads it from
          there.
        </p>
      ) : null}

      <p>
        There are no product features yet. The one page that does something real reads
        live state from the API:
      </p>

      <p>
        <Link href="/status">Status</Link>
      </p>
    </main>
  );
}
