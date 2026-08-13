import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const { ProfileForm, DistrictPreview } = await import('./profile-form');

const PROFILE = {
  displayName: 'Sarah M.',
  phone: '+447700900123',
  address: {
    line1: '12 Acacia Avenue',
    line2: 'Flat 3',
    town: 'Bristol',
    postcode: 'BS7 8AA',
  },
  ownerStatus: null,
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

/**
 * The live district preview (slice D5).
 *
 * **The most reassuring thing on the page**, because it turns "only the first
 * part is published" from a promise into something somebody can watch happen
 * while they type. That makes it worth testing as behaviour rather than as copy.
 */
describe('the district preview', () => {
  it('explains the rule before anything is typed', () => {
    render(<DistrictPreview postcode="" />);
    expect(document.body.textContent).toContain('the part before the space');
  });

  it('shows the actual district once the postcode is valid', () => {
    render(<DistrictPreview postcode="BS7 8AA" />);

    expect(document.body.textContent).toContain('BS7');
    // The whole point: the half that stays private must not appear in a sentence
    // about what is published.
    expect(document.body.textContent).not.toContain('8AA');
  });

  it.each([
    ['half-typed', 'SW1'],
    ['nonsense', 'not a postcode'],
    ['only whitespace', '   '],
  ])('falls back to the rule for %s rather than showing an error', (_case, typed) => {
    /*
     * "SW1" on the way to "SW11 4AB" is not a mistake, and telling somebody off
     * mid-word is the fastest way to make a form feel hostile. It is also why
     * validity is checked before `Postcode.outwardCode`, which throws.
     */
    render(<DistrictPreview postcode={typed} />);
    expect(document.body.textContent).toContain('the part before the space');
  });

  it('updates as somebody types into the real field', async () => {
    const user = userEvent.setup();
    render(<ProfileForm profile={null} />);

    await user.type(screen.getByLabelText(/postcode/i), 'BS7 8AA');

    expect(screen.getByText(/only the district/i).textContent).toContain('BS7');
  });

  it('is announced rather than only shown', () => {
    // A line whose whole purpose is that it changes while you type is useless to
    // somebody who is never told it changed.
    render(<ProfileForm profile={null} />);
    expect(screen.getByText(/only the district/i)).toHaveAttribute(
      'aria-live',
      'polite',
    );
  });
});

/**
 * The private-owner or professional-trader declaration (slice 2.13, BRD §8.3).
 *
 * **Nothing here is a styling assertion.** The question is a legal one, the
 * answer appears on a page strangers read, and the failure mode is a form that
 * quietly answers it for somebody.
 */
describe('how you list', () => {
  it('offers both answers and preselects neither', () => {
    /*
     * **The assertion this field exists for.** A default of "private" would be
     * the platform answering a legal question on somebody's behalf — and
     * because it is the likely answer it would be wrong rarely and invisibly,
     * which is the worst frequency there is.
     */
    render(<ProfileForm profile={null} />);

    const chosen = screen
      .getAllByRole('radio')
      .filter((radio) => (radio as HTMLInputElement).checked);

    expect(screen.getByLabelText(/private individual/)).toBeTruthy();
    expect(screen.getByLabelText(/a business/)).toBeTruthy();
    expect(chosen).toHaveLength(0);
  });

  it('shows back what somebody already answered', () => {
    render(<ProfileForm profile={{ ...PROFILE, ownerStatus: 'private_owner' }} />);

    expect(
      (screen.getByLabelText(/private individual/) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('shows back a business answer too, rather than resetting it', () => {
    // Somebody who told us the truth and cannot publish must still see what
    // they said. Silently clearing it would look like the platform disagreeing.
    render(
      <ProfileForm profile={{ ...PROFILE, ownerStatus: 'professional_trader' }} />,
    );

    expect((screen.getByLabelText(/a business/) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('says why it is being asked', () => {
    render(<ProfileForm profile={null} />);

    expect(document.body.textContent).toContain('different legal rights');
  });

  it('warns that a business cannot publish, before they find out at publish', () => {
    // Discovering the limit three screens later is the thing that makes people
    // stop trusting a platform. It also says why we still want the answer.
    render(<ProfileForm profile={null} />);

    expect(document.body.textContent).toContain('only accept listings from private');
    expect(document.body.textContent).toContain('demand for it');
  });
});
