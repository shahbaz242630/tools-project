import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BRAND } from '@platform/config';
import { SiteFooter } from './site-footer';

describe('SiteFooter', () => {
  it('carries the brand from the one file it lives in', () => {
    render(<SiteFooter signedIn={false} />);
    // Twice: the wordmark and the copyright line. Both read the same source.
    expect(screen.getAllByText(new RegExp(BRAND.name)).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('links only to pages that exist', () => {
    render(<SiteFooter signedIn={false} />);
    for (const [label, href] of [
      ['List a tool', '/listings/new'],
      ['Sign in', '/sign-in'],
      ['Create an account', '/sign-up'],
      ['Status', '/status'],
    ] as const) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
  });

  it.each(['How it works', 'Privacy', 'Terms', 'Support'])(
    'does not link %s, which has no page behind it',
    (label) => {
      /*
       * The design's footer draws five. How it works is an anchor into a
       * landing-page section nobody has written, and the three legal pages need
       * copy a solicitor writes rather than a designer. BRD §15 forbids a
       * control that does not do what it says — and this component renders on
       * every page in the application, so a dead link here is a dead link
       * everywhere.
       *
       * **Browse was the fifth and left this list in slice 3.1b**, when
       * `/browse` was built. The rule is why it is now present, not why it was
       * once missing.
       */
      render(<SiteFooter signedIn={false} />);
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    },
  );

  it('links Browse, now that there is somewhere for it to go (3.1b)', () => {
    render(<SiteFooter signedIn={false} />);

    expect(screen.getByRole('link', { name: 'Browse' })).toHaveAttribute(
      'href',
      '/browse',
    );
  });

  it('labels each column with a real heading', () => {
    // Four unlabelled link groups are four unlabelled link groups to a screen
    // reader. The headings are what make them skippable.
    render(<SiteFooter signedIn={false} />);
    for (const heading of ['Marketplace', 'Account', 'Platform']) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
  });
});

/**
 * **The footer was entirely auth-blind until the Phase 0–3 audit**, while the
 * header beside it has read the session since D2. It offered *Sign in* and
 * *Create an account* to somebody already signed in, and *Your profile* to a
 * stranger — a link that led to a page reading "Sign in to edit your profile",
 * which is courteous and is still a nav item that cannot be used.
 */
describe('what the footer offers a stranger', () => {
  it('offers the two ways in', () => {
    render(<SiteFooter signedIn={false} />);

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/sign-up',
    );
  });

  it.each(['Your account', 'Your profile', 'Your listings', 'Your bookings'])(
    'does not offer %s, which needs a session',
    (label) => {
      render(<SiteFooter signedIn={false} />);

      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    },
  );
});

describe('what it offers somebody signed in', () => {
  it('offers the same three the header’s menu does', () => {
    render(<SiteFooter signedIn />);

    for (const [label, href] of [
      ['Your account', '/account'],
      ['Your profile', '/account/profile'],
      ['Your listings', '/listings'],
      // Added in 4.8b. The header menu gained this entry and the footer did not,
      // which is what two lists of the same links do — found by looking at the
      // page, so it is asserted here rather than left to the next reader.
      ['Your bookings', '/bookings'],
    ] as const) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
  });

  it.each(['Sign in', 'Create an account'])(
    'does not offer %s to somebody who has already done it',
    (label) => {
      render(<SiteFooter signedIn />);

      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    },
  );

  it('keeps the links that do not depend on a session', () => {
    // Browse, List a tool and Status are for everybody — the fix is about the
    // Account column, and a change that quietly narrowed the rest would be a
    // regression nothing else here would catch.
    render(<SiteFooter signedIn />);

    for (const label of ['Browse', 'List a tool', 'Status']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });
});
