import { BRAND } from '@platform/config';
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
      <body>{children}</body>
    </html>
  );
}
