import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccountReport } from './account-report';
import type { AccountOutcome } from '../lib/account';

const ACCOUNT = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alice@example.com',
  role: 'USER',
  suspendedAt: null,
  suspensionReason: null,
  adminMfaBypassed: false,
} as const;

describe('AccountReport', () => {
  it('shows the account when signed in', () => {
    render(<AccountReport outcome={{ kind: 'signed-in', account: ACCOUNT }} />);

    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('USER')).toBeInTheDocument();
    expect(screen.getByText(ACCOUNT.id)).toBeInTheDocument();
  });

  it('invites a signed-out visitor to sign in', () => {
    render(<AccountReport outcome={{ kind: 'signed-out' }} />);
    expect(screen.getByText(/sign in to see your account/i)).toBeInTheDocument();
  });

  it.each([
    ['unreachable', { kind: 'unreachable', reason: 'connect ECONNREFUSED' }],
    ['malformed', { kind: 'malformed', reason: 'id: invalid uuid' }],
  ])('does not claim the visitor is signed out when %s', (_case, outcome) => {
    // The distinction this component exists to preserve. Telling a signed-in
    // person they are signed out because the API hiccuped invites them to sign
    // in repeatedly against a service that cannot answer.
    render(<AccountReport outcome={outcome as AccountOutcome} />);
    expect(screen.queryByText(/sign in to see your account/i)).not.toBeInTheDocument();
  });

  it('says plainly that it could not tell, when it could not', () => {
    render(
      <AccountReport
        outcome={{ kind: 'unreachable', reason: 'connect ECONNREFUSED' }}
      />,
    );
    expect(screen.getByText(/may still be signed in/i)).toBeInTheDocument();
    expect(screen.getByText('connect ECONNREFUSED')).toBeInTheDocument();
  });

  it('calls a refusal a decision rather than a fault', () => {
    render(<AccountReport outcome={{ kind: 'forbidden' }} />);

    // Lead with what is certainly true: the token was accepted, so this person
    // is signed in and must not be told to sign in again.
    expect(screen.getByText(/you are signed in/i)).toBeInTheDocument();
    expect(screen.queryByText(/sign in to see your account/i)).not.toBeInTheDocument();

    // Then what to do. The reason lives with the administrator who wrote it,
    // and the activity trail is the one route to it that a refused `/me` does
    // not take away.
    expect(screen.getByText(/account activity/i)).toBeInTheDocument();

    // Never a status code at a person, and never worded as an outage: this is
    // the sentence the audit found in five clients at once.
    expect(screen.queryByText(/403/)).not.toBeInTheDocument();
    expect(screen.queryByText(/did not answer/i)).not.toBeInTheDocument();
  });

  it('names a version skew as the likely cause of a malformed answer', () => {
    render(
      <AccountReport outcome={{ kind: 'malformed', reason: 'id: invalid uuid' }} />,
    );
    expect(screen.getByText(/deploy is in progress/i)).toBeInTheDocument();
  });
});
