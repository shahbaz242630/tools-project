import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BRAND } from '@platform/config';
import { SiteHeader } from './site-header';

describe('SiteHeader', () => {
  it('shows the wordmark from the one file the brand lives in', () => {
    // Not a literal. ADR 0005 puts the trading name in exactly one module, and a
    // test asserting the string would be the second place it lived.
    render(<SiteHeader signedIn={false} email={null} />);
    expect(screen.getByRole('link', { name: BRAND.name })).toHaveAttribute('href', '/');
  });

  it('offers a signed-out visitor a way in and a way to list', () => {
    render(<SiteHeader signedIn={false} email={null} />);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(screen.getAllByRole('link', { name: 'List a tool' })[0]).toHaveAttribute(
      'href',
      '/listings/new',
    );
  });

  it('does not offer a signed-out visitor an account menu', () => {
    render(<SiteHeader signedIn={false} email={null} />);
    expect(
      screen.queryByRole('button', { name: 'Your account' }),
    ).not.toBeInTheDocument();
  });

  it('gives a signed-in person the account menu instead of a sign-in link', () => {
    render(<SiteHeader signedIn email="sam@example.co.uk" />);
    expect(screen.getByRole('button', { name: 'Your account' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('links nothing that does not exist yet', () => {
    /*
     * The design's header carries Browse and How it works. BRD §15 forbids a
     * control that does not do what it says, and this is the assertion that
     * stops one being added back from the mockup before the page behind it
     * exists.
     *
     * **Browse left this list in slice 3.1b**, when `/browse` was built — which
     * is the rule working rather than being relaxed. *How it works* is still an
     * anchor into a landing-page section nobody has written.
     */
    render(<SiteHeader signedIn email="sam@example.co.uk" />);
    expect(
      screen.queryByRole('link', { name: 'How it works' }),
    ).not.toBeInTheDocument();
  });

  it('offers Browse, now that there is somewhere for it to go (3.1b)', () => {
    render(<SiteHeader signedIn={false} email={null} />);

    expect(screen.getByRole('link', { name: 'Browse' })).toHaveAttribute(
      'href',
      '/browse',
    );
  });

  it('offers Browse to somebody signed in as well', () => {
    // Renting is the demand side, and it is not a signed-in privilege — the
    // public search route needs no session at all.
    render(<SiteHeader signedIn email="sam@example.co.uk" />);

    expect(screen.getByRole('link', { name: 'Browse' })).toBeInTheDocument();
  });

  it('labels the navigation, because a page will have more than one', () => {
    render(<SiteHeader signedIn={false} email={null} />);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });
});
