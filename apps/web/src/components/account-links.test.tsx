import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccountLinks } from './account-links';
import type { MeResponse } from '@platform/contracts';

// Typed as the contract rather than `as const`: the literal types that produces
// make every override below a type error, and vitest transpiles without
// checking, so the suite would stay green while `pnpm typecheck` went red.
const ACTIVE: MeResponse = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alice@example.com',
  role: 'USER',
  suspendedAt: null,
  suspensionReason: null,
  adminMfaBypassed: false,
};

const SUSPENDED: MeResponse = {
  ...ACTIVE,
  suspendedAt: '2026-08-01T09:00:00.000Z',
  suspensionReason: 'suspected fraud, ticket 4821',
};

/**
 * The link's `href`, so a test proves where it goes and not merely that it
 * exists.
 *
 * **Every row's accessible name now runs "title, then sub"**, because slice D4
 * put the design's explanatory line inside the link. Matching on the leading
 * words rather than the whole string is what keeps these assertions about
 * destinations instead of about copy.
 */
function hrefOf(name: RegExp): string | null {
  return screen.getByRole('link', { name }).getAttribute('href');
}

describe('AccountLinks', () => {
  it('names devices in the link, so somebody looking for them finds them', () => {
    // The whole of slice 1.11, in one assertion. Clerk's device list has existed
    // since 1.7 behind a link called "Email and sign-in", which is not a phrase
    // anybody wondering "what is signed in to my account" would ever click.
    // **The design of 13 August renames this to "Email & password"**; D4 kept
    // our wording, and this is the assertion that says why.
    render(<AccountLinks account={ACTIVE} />);

    expect(hrefOf(/devices/i)).toBe('/account/email');
  });

  it('offers every account route when the account is active', () => {
    render(<AccountLinks account={ACTIVE} />);

    expect(hrefOf(/^Your profile/)).toBe('/account/profile');
    expect(hrefOf(/^View your public profile/)).toBe(
      '/users/11111111-1111-4111-8111-111111111111',
    );
    expect(hrefOf(/^Your listings/)).toBe('/listings');
    expect(hrefOf(/^Account activity/)).toBe('/account/activity');
    expect(hrefOf(/^Download your data/)).toBe('/account/data');
    expect(hrefOf(/^Delete your account/)).toBe('/account/delete');
  });

  it('keeps the public profile in the list, which the design drops', () => {
    // A person being asked for a home address should be one click from the page
    // that proves how little of it is published.
    render(<AccountLinks account={ACTIVE} />);

    expect(hrefOf(/^View your public profile/)).toContain('/users/');
  });

  it('explains each destination rather than only naming it', () => {
    render(<AccountLinks account={ACTIVE} />);

    expect(screen.getByText('Display name, address, how you list')).toBeInTheDocument();
    expect(screen.getByText('Everything you have offered to lend')).toBeInTheDocument();
  });

  it('drops the two links a suspended account would only be refused', () => {
    // Not cosmetic. The profile form would render and lose the work at the
    // save, and the public profile would 404 — both read as the site being
    // broken rather than as a decision somebody made (ADR 0024).
    render(<AccountLinks account={SUSPENDED} />);

    expect(screen.queryByRole('link', { name: /^Your profile/ })).toBeNull();
    expect(
      screen.queryByRole('link', { name: /^View your public profile/ }),
    ).toBeNull();
  });

  it('keeps the data-protection routes while suspended', () => {
    // UK GDPR access and erasure rights do not lapse because somebody was
    // suspended, and a right nobody can find is not meaningfully available.
    render(<AccountLinks account={SUSPENDED} />);

    expect(hrefOf(/^Account activity/)).toBe('/account/activity');
    expect(hrefOf(/^Download your data/)).toBe('/account/data');
    expect(hrefOf(/^Delete your account/)).toBe('/account/delete');
  });

  it('keeps the device list reachable while suspended', () => {
    // Deliberately unlike the two dropped links, and the reason is the point:
    // nothing on that page calls our API, so nothing refuses it — and somebody
    // suspended over activity they do not recognise is exactly who needs to see
    // what is signed in to their account.
    render(<AccountLinks account={SUSPENDED} />);

    expect(hrefOf(/devices/i)).toBe('/account/email');
  });
});

/**
 * The one irreversible action here, set apart from the everyday ones
 * (slice 2.8b, restyled in D4).
 *
 * Until 2.8b, "Delete your account" was the sixth bullet in a list of six,
 * carrying exactly the same weight as "Download your data". **The design of
 * 13 August puts it back inside the card as a red row**; these assertions are
 * what stopped that happening.
 */
describe('the danger zone', () => {
  it('is a region of its own with its own heading', () => {
    render(<AccountLinks account={ACTIVE} />);

    // By role rather than by class: the separation that matters is the one a
    // screen reader gets too, and colour alone would carry the meaning in a
    // single channel (WCAG 1.4.1).
    expect(
      screen.getByRole('heading', { name: /delete your account/i }),
    ).toBeInTheDocument();
  });

  it('keeps deletion out of the ordinary list of links', () => {
    render(<AccountLinks account={ACTIVE} />);

    const everydayLinks = screen
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');

    expect(everydayLinks.some((text) => /delete your account/i.test(text))).toBe(false);
  });

  it('warns that it is immediate and takes the listings, before the link', () => {
    render(<AccountLinks account={ACTIVE} />);

    const zone = screen.getByRole('heading', { name: /delete your account/i })
      .parentElement as HTMLElement;

    expect(zone.textContent).toMatch(/cannot be undone/i);
    // Named explicitly, because "your account" is not a phrase most people read
    // as including the listings they spent an evening writing.
    expect(zone.textContent).toMatch(/every listing/i);
  });

  it('is still reachable while suspended', () => {
    // Erasure rights do not lapse on suspension (ADR 0024), and restyling must
    // not have quietly dropped it for suspended accounts.
    render(<AccountLinks account={SUSPENDED} />);

    expect(hrefOf(/^Delete your account/)).toBe('/account/delete');
  });
});
