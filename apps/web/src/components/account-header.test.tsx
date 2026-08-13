import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MeResponse, MyProfile } from '@platform/contracts';
import { AccountHeader, avatarLetter } from './account-header';

const ACCOUNT: MeResponse = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alice@example.com',
  role: 'USER',
  suspendedAt: null,
  suspensionReason: null,
  adminMfaBypassed: false,
};

const PROFILE: MyProfile = {
  displayName: 'Sam A.',
  phone: '07700 900123',
  address: {
    line1: '14 Milton Road',
    line2: null,
    town: 'London',
    postcode: 'SW11 4AB',
  },
  ownerStatus: 'private_owner',
  updatedAt: '2026-08-12T10:00:00.000Z',
};

describe('avatarLetter', () => {
  it('takes the first letter, capitalised', () => {
    expect(avatarLetter('Sam A.')).toBe('S');
    expect(avatarLetter('alice@example.com')).toBe('A');
  });

  it('falls back to a neutral mark rather than an empty circle', () => {
    expect(avatarLetter('   ')).toBe('·');
    expect(avatarLetter('')).toBe('·');
  });
});

describe('AccountHeader', () => {
  it('leads with the display name once there is one', () => {
    render(<AccountHeader account={ACCOUNT} profile={PROFILE} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sam A.');
  });

  it('publishes the district, never the full postcode', () => {
    /*
     * This page only ever answers for its own owner, so the whole postcode would
     * be defensible — but the header's job is to reflect what a neighbour sees,
     * and BRD §8.4.1 is the rule the rest of the application obeys. Getting it
     * wrong here would teach somebody the opposite of what the profile form
     * spends three paragraphs explaining.
     */
    render(<AccountHeader account={ACCOUNT} profile={PROFILE} />);

    expect(document.body.textContent).toContain('SW11');
    expect(document.body.textContent).not.toContain('SW11 4AB');
    expect(document.body.textContent).not.toContain('4AB');
  });

  it('names the town and the email beside it', () => {
    render(<AccountHeader account={ACCOUNT} profile={PROFILE} />);
    expect(document.body.textContent).toContain('alice@example.com');
    expect(document.body.textContent).toContain('London');
  });

  it('stands up before a profile exists', () => {
    // The state every brand-new account is in. A header that renders
    // "undefined · undefined" for its first visitor is worse than one that
    // renders an email.
    render(<AccountHeader account={ACCOUNT} profile={null} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Your account');
    expect(document.body.textContent).toContain('alice@example.com');
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('stands up when a profile has no address', () => {
    render(<AccountHeader account={ACCOUNT} profile={{ ...PROFILE, address: null }} />);

    expect(document.body.textContent).toContain('alice@example.com');
    expect(document.body.textContent).not.toContain('·  ·');
  });

  it('drops the district rather than the page when a stored postcode will not parse', () => {
    /*
     * `Postcode.outwardCode` throws on anything it does not recognise, which is
     * right where a listing publishes one. Here the value has already passed the
     * API's validation, so a throw would mean our contract and our parser
     * disagree — worth knowing about, but not by taking down the page somebody
     * would use to correct their address.
     */
    render(
      <AccountHeader
        account={ACCOUNT}
        profile={{
          ...PROFILE,
          address: { ...PROFILE.address!, postcode: 'not a postcode' },
        }}
      />,
    );

    expect(document.body.textContent).toContain('London');
    expect(document.body.textContent).not.toContain('not a postcode');
  });
});
