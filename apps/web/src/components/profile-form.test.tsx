import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The server action is mocked, not exercised.
 *
 * It imports `@clerk/nextjs/server` and `next/cache`, neither of which loads
 * outside a Next request. What is worth testing here is the form itself — the
 * fields, and the copy that tells somebody which of their details will be
 * published. That copy is a promise the platform is making to a person handing
 * over a home address, so it is asserted rather than assumed.
 */
vi.mock('../app/account/profile/actions', () => ({
  INITIAL_PROFILE_FORM_STATE: { status: 'idle', issues: [], message: null },
  saveProfileAction: vi.fn(),
}));

const { ProfileForm } = await import('./profile-form');

const PROFILE = {
  displayName: 'Sarah M.',
  phone: '+447700900123',
  address: {
    line1: '12 Acacia Avenue',
    line2: 'Flat 3',
    town: 'Bristol',
    postcode: 'BS7 8AA',
  },
  updatedAt: '2026-07-31T09:00:00.000Z',
};

describe('ProfileForm', () => {
  it('renders an empty form for somebody with no profile', () => {
    render(<ProfileForm profile={null} />);

    expect(screen.getByLabelText(/display name/i)).toHaveValue('');
    expect(screen.getByLabelText(/phone number/i)).toHaveValue('');
    expect(screen.getByLabelText(/postcode/i)).toHaveValue('');
  });

  it('fills every field from an existing profile', () => {
    render(<ProfileForm profile={PROFILE} />);

    expect(screen.getByLabelText(/display name/i)).toHaveValue('Sarah M.');
    expect(screen.getByLabelText(/phone number/i)).toHaveValue('+447700900123');
    expect(screen.getByLabelText(/address line 1/i)).toHaveValue('12 Acacia Avenue');
    expect(screen.getByLabelText(/address line 2/i)).toHaveValue('Flat 3');
    expect(screen.getByLabelText(/town or city/i)).toHaveValue('Bristol');
    expect(screen.getByLabelText(/postcode/i)).toHaveValue('BS7 8AA');
  });

  it('handles a profile that has a name but no address', () => {
    render(<ProfileForm profile={{ ...PROFILE, phone: null, address: null }} />);

    expect(screen.getByLabelText(/display name/i)).toHaveValue('Sarah M.');
    expect(screen.getByLabelText(/address line 1/i)).toHaveValue('');
  });

  it('separates public fields from private ones, and says which is which', () => {
    // The reason the form is grouped at all. Somebody is being asked for a home
    // address by a platform that will send strangers to their door; a form that
    // collects that silently is asking for trust it has not earned.
    render(<ProfileForm profile={null} />);

    expect(screen.getByText(/public — anyone can see this/i)).toBeInTheDocument();
    expect(
      screen.getByText(/private — shared only when you agree a rental/i),
    ).toBeInTheDocument();
  });

  it('tells the reader their postcode is not published in full', () => {
    // The single most important sentence on the page: it is what makes asking
    // for a full postcode honest. If it disappears, the form is collecting
    // something under an implication it no longer states.
    render(<ProfileForm profile={null} />);

    expect(screen.getByText(/only the district/i)).toBeInTheDocument();
    expect(screen.getByText(/never shown in full/i)).toBeInTheDocument();
  });

  it('warns that the town is public, because that is not obvious', () => {
    render(<ProfileForm profile={null} />);
    expect(screen.getByText(/this one is public/i)).toBeInTheDocument();
  });

  it('offers a submit control that is enabled', () => {
    // No dead controls: the button submits to a real action.
    render(<ProfileForm profile={null} />);
    expect(screen.getByRole('button', { name: /save profile/i })).toBeEnabled();
  });
});
