import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProfileFormStatus } from './profile-form-status';
import type { ProfileFormState } from '../app/account/profile/state';

const state = (overrides: Partial<ProfileFormState>): ProfileFormState => ({
  status: 'idle',
  issues: [],
  message: null,
  ...overrides,
});

describe('ProfileFormStatus', () => {
  it('says nothing before anything has been submitted', () => {
    const { container } = render(<ProfileFormStatus state={state({})} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('confirms a save', () => {
    render(<ProfileFormStatus state={state({ status: 'saved' })} />);
    expect(screen.getByRole('status')).toHaveTextContent(/has been saved/i);
  });

  it('lists every field problem', () => {
    render(
      <ProfileFormStatus
        state={state({
          status: 'invalid',
          issues: [
            'postcode: must be a valid UK postcode',
            'phone: must be a UK number',
          ],
        })}
      />,
    );

    expect(screen.getByText(/must be a valid UK postcode/)).toBeInTheDocument();
    expect(screen.getByText(/must be a UK number/)).toBeInTheDocument();
  });

  it('shows the message for a failure that is nobody’s fault', () => {
    render(
      <ProfileFormStatus
        state={state({ status: 'error', message: 'You are not signed in.' })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('You are not signed in.');
  });

  it('still says it was not saved when there is no message to show', () => {
    // The failure mode this component exists to prevent. Silence after a failed
    // submit reads as success, and somebody who believes their address is
    // stored finds out at a handover.
    render(<ProfileFormStatus state={state({ status: 'error' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/not saved/i);
  });

  it.each([
    ['invalid', state({ status: 'invalid', issues: ['displayName: is required'] })],
    ['error', state({ status: 'error', message: 'socket hang up' })],
  ])('never claims a save happened when the state is %s', (_case, given) => {
    render(<ProfileFormStatus state={given} />);
    expect(screen.queryByText(/has been saved/i)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
