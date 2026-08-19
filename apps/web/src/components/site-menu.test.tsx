import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { AccountMenu, MobileMenu, avatarInitial } from './site-menu';

/*
 * Clerk's sign-out button needs a live provider, and standing one up to assert
 * that a menu opens would be testing Clerk. The double keeps its one contract —
 * it renders whatever it is given — so the row still appears in the menu and
 * still has to be findable.
 */
vi.mock('@clerk/nextjs', () => ({
  SignOutButton: ({ children }: { children: ReactNode }) => children,
}));

describe('avatarInitial', () => {
  it('takes the first letter of the email, capitalised', () => {
    expect(avatarInitial('sam@example.co.uk')).toBe('S');
  });

  it('capitalises an address that arrives lower case', () => {
    expect(avatarInitial('zoe@example.co.uk')).toBe('Z');
  });

  it('ignores surrounding whitespace rather than rendering a blank circle', () => {
    expect(avatarInitial('  ada@example.co.uk ')).toBe('A');
  });

  it.each([
    ['no claim at all', null],
    ['an empty string', ''],
    ['only whitespace', '   '],
  ])('falls back to a neutral mark when there is %s', (_case, email) => {
    // A wrong letter reads as somebody else's account, and an empty circle reads
    // as a broken image. Neither is better than a dot.
    expect(avatarInitial(email)).toBe('·');
  });
});

describe('AccountMenu', () => {
  it('keeps the menu shut until it is asked for', () => {
    render(<AccountMenu email="sam@example.co.uk" />);
    expect(
      screen.queryByRole('navigation', { name: 'Account' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Your account' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('opens onto every account destination and the way out', async () => {
    const user = userEvent.setup();
    render(<AccountMenu email="sam@example.co.uk" />);

    await user.click(screen.getByRole('button', { name: 'Your account' }));

    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(screen.getByRole('link', { name: 'Your profile' })).toHaveAttribute(
      'href',
      '/account/profile',
    );
    expect(screen.getByRole('link', { name: 'Your listings' })).toHaveAttribute(
      'href',
      '/listings',
    );

    // Both sides of a booking behind one entry (4.8b). Two would ask somebody to
    // classify themselves before they can look.
    expect(screen.getByRole('link', { name: 'Your bookings' })).toHaveAttribute(
      'href',
      '/bookings',
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('is a labelled navigation rather than an ARIA menu', () => {
    /*
     * `role="menu"` carries a keyboard contract — arrow keys, Home, End,
     * type-ahead — and claiming it without honouring it tells a screen reader
     * user to expect behaviour that is not there. This is a list of links.
     */
    render(<AccountMenu email="sam@example.co.uk" />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('reports its state to assistive technology, not just visually', async () => {
    const user = userEvent.setup();
    render(<AccountMenu email="sam@example.co.uk" />);

    await user.click(screen.getByRole('button', { name: 'Your account' }));
    expect(screen.getByRole('button', { name: 'Your account' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('points the trigger at the panel it opens', async () => {
    const user = userEvent.setup();
    render(<AccountMenu email="sam@example.co.uk" />);

    const trigger = screen.getByRole('button', { name: 'Your account' });
    await user.click(trigger);

    const panel = screen.getByRole('navigation', { name: 'Account' });
    expect(trigger).toHaveAttribute('aria-controls', panel.id);
  });

  it('closes on Escape and puts focus back on the trigger', async () => {
    /*
     * The second half is the part that is easy to leave out. Closing the panel
     * destroys whatever was focused inside it, and without this a keyboard user
     * is thrown to the top of the document and has to tab back through the whole
     * page to reach where they were.
     */
    const user = userEvent.setup();
    render(<AccountMenu email="sam@example.co.uk" />);

    const trigger = screen.getByRole('button', { name: 'Your account' });
    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('navigation', { name: 'Account' }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes when a click lands outside it', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <AccountMenu email="sam@example.co.uk" />
        <p>elsewhere</p>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Your account' }));
    await user.click(screen.getByText('elsewhere'));

    expect(
      screen.queryByRole('navigation', { name: 'Account' }),
    ).not.toBeInTheDocument();
  });
});

describe('MobileMenu', () => {
  it('offers a signed-out visitor the rows the bar has no room for', async () => {
    const user = userEvent.setup();
    render(<MobileMenu signedIn={false} email={null} />);

    await user.click(screen.getByRole('button', { name: 'Menu' }));

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(screen.getByRole('link', { name: 'List a tool' })).toHaveAttribute(
      'href',
      '/listings/new',
    );
  });

  it.each([
    ['signed out', false, null] as const,
    ['signed in', true, 'sam@example.co.uk'] as const,
  ])('offers Browse to somebody %s (3.1b)', async (_who, signedIn, email) => {
    /*
     * **The sheet is the only navigation a phone has**, so a link that is in the
     * header and not in here is a link that does not exist on a phone — the
     * failure this file already exists to catch, arriving for a different
     * reason. Renting needs no session, so both branches carry it.
     */
    const user = userEvent.setup();
    render(<MobileMenu signedIn={signedIn} email={email} />);

    await user.click(screen.getByRole('button', { name: 'Menu' }));

    expect(screen.getByRole('link', { name: 'Browse' })).toHaveAttribute(
      'href',
      '/browse',
    );
  });

  it('does not offer a signed-out visitor a way to sign out', async () => {
    const user = userEvent.setup();
    render(<MobileMenu signedIn={false} email={null} />);

    await user.click(screen.getByRole('button', { name: 'Menu' }));

    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('carries the same account destinations the dropdown does', async () => {
    /*
     * The failure this exists to catch is a menu item that exists on a laptop
     * and not on a phone. Both menus read the same array, and this is what
     * notices if one of them stops.
     */
    const user = userEvent.setup();
    render(<MobileMenu signedIn email="sam@example.co.uk" />);

    await user.click(screen.getByRole('button', { name: 'Menu' }));

    for (const label of ['Account', 'Your profile', 'Your listings', 'Your bookings']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<MobileMenu signedIn={false} email={null} />);

    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});
