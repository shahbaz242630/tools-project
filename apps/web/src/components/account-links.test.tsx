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
};

const SUSPENDED: MeResponse = {
  ...ACTIVE,
  suspendedAt: '2026-08-01T09:00:00.000Z',
  suspensionReason: 'suspected fraud, ticket 4821',
};

/** The link's `href`, so a test proves where it goes and not merely that it exists. */
function hrefOf(name: RegExp): string | null {
  return screen.getByRole('link', { name }).getAttribute('href');
}

describe('AccountLinks', () => {
  it('names devices in the link, so somebody looking for them finds them', () => {
    // The whole slice, in one assertion. Clerk's device list has existed since
    // 1.7 behind a link called "Email and sign-in", which is not a phrase
    // anybody wondering "what is signed in to my account" would ever click.
    render(<AccountLinks account={ACTIVE} />);

    expect(hrefOf(/devices/i)).toBe('/account/email');
  });

  it('offers every account route when the account is active', () => {
    render(<AccountLinks account={ACTIVE} />);

    expect(hrefOf(/edit your profile/i)).toBe('/account/profile');
    expect(hrefOf(/view your public profile/i)).toBe(
      '/users/11111111-1111-4111-8111-111111111111',
    );
    expect(hrefOf(/account activity/i)).toBe('/account/activity');
    expect(hrefOf(/download your data/i)).toBe('/account/data');
    expect(hrefOf(/delete your account/i)).toBe('/account/delete');
  });

  it('drops the two links a suspended account would only be refused', () => {
    // Not cosmetic. The profile form would render and lose the work at the
    // save, and the public profile would 404 — both read as the site being
    // broken rather than as a decision somebody made (ADR 0024).
    render(<AccountLinks account={SUSPENDED} />);

    expect(screen.queryByRole('link', { name: /edit your profile/i })).toBeNull();
    expect(
      screen.queryByRole('link', { name: /view your public profile/i }),
    ).toBeNull();
  });

  it('keeps the data-protection routes while suspended', () => {
    // UK GDPR access and erasure rights do not lapse because somebody was
    // suspended, and a right nobody can find is not meaningfully available.
    render(<AccountLinks account={SUSPENDED} />);

    expect(hrefOf(/account activity/i)).toBe('/account/activity');
    expect(hrefOf(/download your data/i)).toBe('/account/data');
    expect(hrefOf(/delete your account/i)).toBe('/account/delete');
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
