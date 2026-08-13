import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BRAND } from '@platform/config';
import { SiteFooter } from './site-footer';

describe('SiteFooter', () => {
  it('carries the brand from the one file it lives in', () => {
    render(<SiteFooter />);
    // Twice: the wordmark and the copyright line. Both read the same source.
    expect(screen.getAllByText(new RegExp(BRAND.name)).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('links only to pages that exist', () => {
    render(<SiteFooter />);
    for (const [label, href] of [
      ['List a tool', '/listings/new'],
      ['Sign in', '/sign-in'],
      ['Create an account', '/sign-up'],
      ['Your profile', '/account/profile'],
      ['Status', '/status'],
    ] as const) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
  });

  it.each(['Browse', 'How it works', 'Privacy', 'Terms', 'Support'])(
    'does not link %s, which has no page behind it',
    (label) => {
      /*
       * The design's footer draws all five. Browse is Phase 3, How it works is
       * an anchor into the landing page (slice D3), and the three legal pages
       * need copy a solicitor writes rather than a designer. BRD §15 forbids a
       * control that does not do what it says — and this component renders on
       * every page in the application, so a dead link here is a dead link
       * everywhere.
       */
      render(<SiteFooter />);
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    },
  );

  it('labels each column with a real heading', () => {
    // Four unlabelled link groups are four unlabelled link groups to a screen
    // reader. The headings are what make them skippable.
    render(<SiteFooter />);
    for (const heading of ['Marketplace', 'Account', 'Platform']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
  });
});
