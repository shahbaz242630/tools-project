'use client';

import './globals.css';

/**
 * The boundary of last resort (Phase 0–3 audit).
 *
 * **There was none, and the gap it left is not theoretical.** `error.tsx` wraps
 * the pages *below* the root layout and explicitly does not wrap the layout
 * itself — and `app/layout.tsx` calls `auth()`, which reaches Clerk. A Clerk
 * outage, a malformed token or a missing JWT key therefore threw in the one
 * component with nothing above it to catch it, and the visitor got whatever the
 * runtime produces with no boundary at all.
 *
 * **It renders its own `<html>` and `<body>` because it replaces the root
 * layout.** That is Next's requirement rather than a choice, and it has two
 * consequences worth stating so nobody "tidies" them:
 *
 * - `globals.css` is imported here explicitly. Without it none of the design
 *   tokens are defined and this page is unstyled browser default — the layout
 *   that normally imports the stylesheet is precisely the thing that failed.
 * - the typeface is *not* the app's. `next/font` publishes
 *   `--font-instrument-sans` from the root layout, which is not running, so
 *   `--font-sans` would resolve to an undefined variable and the whole
 *   `font-family` declaration would be discarded — leaving a serif. The body
 *   names the fallback chain directly instead. A last-resort page in the wrong
 *   font is fine; one in the wrong font *by accident* is how you find out
 *   nobody looked at it.
 *
 * **A plain `<a>` home, not `next/link`.** If the root layout is what threw,
 * a client-side navigation re-renders the same broken layout and lands straight
 * back here. A full document request is the only thing on this page that can
 * actually recover, so it must not be turned into a soft navigation for
 * consistency with the rest of the application.
 *
 * **It says nothing about the failure**, for the reason `error.tsx` gives: an
 * unhandled error can carry a stack trace or a row that was mid-flight, and this
 * page is reachable by anybody.
 *
 * Metadata exports are not supported in a client component, so the title is
 * React's own `<title>`, which React 19 hoists into the head.
 */
export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en-GB">
      <body style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
        <title>Something went wrong</title>

        <main>
          <h1>That didn&rsquo;t work.</h1>
          <p>
            Something went wrong before the page could be drawn. Nothing you did caused
            it, and nothing you had saved has been changed.
          </p>
          <p>
            <button
              type="button"
              onClick={() => {
                retry();
              }}
            >
              Try again
            </button>{' '}
            <a href="/">Go home</a>
          </p>
        </main>
      </body>
    </html>
  );
}
