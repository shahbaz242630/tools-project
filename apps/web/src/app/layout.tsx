import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from '@clerk/nextjs';
import { BRAND } from '@platform/config';
import Link from 'next/link';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

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
    <html lang="en-GB">
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
