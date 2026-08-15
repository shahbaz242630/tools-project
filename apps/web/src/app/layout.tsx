import { ClerkProvider } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import { BRAND } from '@platform/config';
import { Instrument_Sans } from 'next/font/google';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { CLERK_APPEARANCE } from '../lib/clerk-appearance';
import { RouteTransition } from '../components/route-transition';
import { SiteFooter } from '../components/site-footer';
import { SiteHeader } from '../components/site-header';
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
/**
 * **The description arrives with the landing page it describes** (slice D3). It
 * was deliberately absent while there was nothing to describe, on the reasoning
 * that inventing marketing copy for an unnamed product is worse than omitting
 * it — that reasoning has now expired rather than been overruled.
 *
 * It names the launch category, which is a claim about what we sell today and
 * not an assumption baked into the engine. Categories remain configuration
 * (BRD §5); nothing reads this string.
 *
 * **There is no social card here, and that is a decision rather than an
 * omission.** The design package ships one, and it reads *"Deposits held ·
 * addresses private"* — the claim slice D3 removed from the landing copy,
 * because we never hold a deposit (BRD §8.7.2 authorises a hold on the renter's
 * own card). A social card is the version of a page that gets screenshotted,
 * cached and indexed, so it is the worst possible place to keep a claim we have
 * just corrected everywhere else. It needs regenerating, and it is inert until a
 * domain exists anyway: Open Graph images must be absolute URLs, so without
 * `metadataBase` Next can only point at localhost.
 */
export const metadata: Metadata = {
  title: BRAND.name,
  description:
    'Rent tools and garden equipment by the day from people near you. ' +
    'Addresses stay private until a booking is agreed.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  /*
   * **The layout reads the session; the header is handed the answer.** Every
   * route in this application is already server-rendered on demand — Clerk's
   * `Show` is a server component and the middleware makes it so — which means
   * asking here costs nothing that was not already being paid, and it buys a
   * navigation that works before hydration and with JavaScript off.
   *
   * `email` is the custom session claim ADR 0015 configures, and it is used for
   * exactly one thing: the letter in the avatar. It degrades to a placeholder
   * rather than throwing, because an instance missing the claim should fail at
   * the API — loudly, where identity is decided — and not by breaking a header.
   */
  const { userId, sessionClaims } = await auth();

  // en-GB, not en. Affects hyphenation, spellcheck and how a screen reader
  // pronounces the page — and this is a UK-only marketplace.
  return (
    <html lang="en-GB" className={instrumentSans.variable}>
      <body>
        {/* Inside <body>, not wrapping <html>. Clerk injects elements, and
            wrapping the document element puts them outside <body> where the
            browser relocates them and hydration then disagrees with the server. */}
        <ClerkProvider appearance={CLERK_APPEARANCE}>
          {/*
            First focusable thing on the page, and invisible until it has focus.
            Without it a keyboard user crosses the whole header on every single
            navigation to reach the content — which on this site is a wordmark,
            two links and a menu, on every page, forever.
          */}
          <a href="#content" className="skip-link">
            Skip to content
          </a>

          <SiteHeader signedIn={userId !== null} email={sessionClaims?.email ?? null} />

          {/* The skip target is here rather than on each page's `<main>`, so no
              page has to remember to carry an id for the link to work. It stays
              on the outer element: the transition below remounts its child on
              every navigation, and an id that comes and goes is one the skip
              link would intermittently fail to find. */}
          <div id="content">
            <RouteTransition>{children}</RouteTransition>
          </div>

          {/* The same answer the header was given, rather than a second read.
              Both navigations describe one session, and a footer that worked it
              out separately is a footer that can disagree with the bar above
              it. */}
          <SiteFooter signedIn={userId !== null} />
        </ClerkProvider>
      </body>
    </html>
  );
}
