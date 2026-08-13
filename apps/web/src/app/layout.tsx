import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from '@clerk/nextjs';
import { BRAND } from '@platform/config';
import { Instrument_Sans } from 'next/font/google';
import Link from 'next/link';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * The one typeface (slice D1).
 *
 * **`next/font` rather than a `<link>` to fonts.googleapis.com, and the reason
 * is privacy before performance.** A stylesheet link makes every visitor's
 * browser connect to Google on every page load, which hands a third party the IP
 * address of everyone who reads a listing — a transfer we would have to disclose
 * and justify, and which a German court has already held unlawful without
 * consent. `next/font` downloads the file at build time and serves it from our
 * own origin, so the request never happens.
 *
 * It also means one less origin to allow when the CSP lands (`SECURITY.md`), and
 * no layout shift, because Next emits the fallback metrics with it.
 *
 * The variable cut, so weights 400–600 come from one file rather than three.
 * Exposed as a CSS custom property because `globals.css` composes it into
 * `--font-sans` with its fallbacks rather than taking Next's class alone.
 */
const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-instrument-sans',
});

// From the one place the brand name lives (ADR 0005). When it is decided, this
// follows automatically rather than needing a search across the codebase.
//
// No `description` yet, deliberately. A meta description that named the launch
// category would hard-code exactly what the engine is built not to assume, and
// inventing marketing copy for an unnamed product is worse than omitting it.
// It belongs with the real landing page.
export const metadata: Metadata = {
  title: BRAND.name,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // en-GB, not en. Affects hyphenation, spellcheck and how a screen reader
  // pronounces the page — and this is a UK-only marketplace.
  return (
    <html lang="en-GB" className={instrumentSans.variable}>
      <body>
        {/* Inside <body>, not wrapping <html>. Clerk injects elements, and
            wrapping the document element puts them outside <body> where the
            browser relocates them and hydration then disagrees with the server. */}
        <ClerkProvider>
          {/* Deliberately unstyled, like the rest of the scaffold. There is no
              brand yet (ADR 0005), and inventing a visual identity for an
              unnamed product produces work that is thrown away twice. */}
          <header>
            <nav aria-label="Account">
              <Show when="signed-out">
                <SignInButton />
                <SignUpButton />
              </Show>
              <Show when="signed-in">
                <Link href="/account">Account</Link>
                <UserButton />
              </Show>
            </nav>
          </header>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
