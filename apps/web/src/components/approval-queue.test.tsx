import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The decision form is a client component importing a server action, so it is
 * stubbed. What matters here is what the queue *says* — and, in one case, what
 * it refuses to say.
 */
vi.mock('./approval-decision-form', () => ({
  ApprovalDecisionForm: ({ canApprove }: { id: string; canApprove: boolean }) => (
    <div data-testid="decision-form">
      {canApprove ? 'can approve' : 'withdraw only'}
    </div>
  ),
}));

const { ApprovalQueue } = await import('./approval-queue');

const PROPOSER = '33333333-3333-4333-8333-333333333333';
const TARGET = '11111111-1111-4111-8111-111111111111';

const APPROVAL = {
  id: '22222222-2222-4222-8222-222222222222',
  action: { kind: 'role.changed' as const, userId: TARGET, role: 'ADMIN' as const },
  targetId: TARGET,
  state: 'pending' as const,
  proposedById: PROPOSER,
  proposedReason: 'support ticket 4821, promoting a colleague',
  proposedAt: '2026-08-01T09:00:00.000Z',
  expiresAt: '2026-08-02T09:00:00.000Z',
  approvedById: null,
  approvedReason: null,
  approvedAt: null,
  cancelledById: null,
  cancelledReason: null,
  cancelledAt: null,
};

describe('ApprovalQueue', () => {
  it('shows what is waiting, and the reason given', () => {
    render(
      <ApprovalQueue
        outcome={{ kind: 'loaded', approvals: [APPROVAL] }}
        viewerId="99999999-9999-4999-8999-999999999999"
      />,
    );

    expect(screen.getByText(APPROVAL.proposedReason)).toBeInTheDocument();
    expect(screen.getByText(PROPOSER)).toBeInTheDocument();
  });

  it('says plainly when nothing is waiting', () => {
    render(
      <ApprovalQueue outcome={{ kind: 'loaded', approvals: [] }} viewerId={null} />,
    );
    expect(screen.getByText('Nothing is waiting.')).toBeInTheDocument();
  });

  it('never reads as "nothing waiting" when the queue could not be read', () => {
    // The distinction this component exists to preserve. An empty queue is a
    // claim about a control; making it because the API timed out is a false
    // reassurance, which is worse than an error.
    render(
      <ApprovalQueue
        outcome={{ kind: 'unavailable', reason: 'connect ECONNREFUSED' }}
        viewerId={null}
      />,
    );

    expect(screen.queryByText('Nothing is waiting.')).not.toBeInTheDocument();
    expect(screen.getByText(/not a record of nothing waiting/i)).toBeInTheDocument();
  });

  it('offers approval on somebody else’s proposal', () => {
    render(
      <ApprovalQueue
        outcome={{ kind: 'loaded', approvals: [APPROVAL] }}
        viewerId="99999999-9999-4999-8999-999999999999"
      />,
    );

    expect(screen.getByTestId('decision-form')).toHaveTextContent('can approve');
  });

  it('explains why you cannot approve your own', () => {
    // Hiding the button is a courtesy so somebody is not refused after pressing
    // it. The API and a database CHECK are what actually stop a self-approval.
    render(
      <ApprovalQueue
        outcome={{ kind: 'loaded', approvals: [APPROVAL] }}
        viewerId={PROPOSER}
      />,
    );

    expect(screen.getByText(/somebody else has to approve it/i)).toBeInTheDocument();
    expect(screen.getByTestId('decision-form')).toHaveTextContent('withdraw only');
  });

  it('tells an administrator without a second factor what is wrong', () => {
    render(<ApprovalQueue outcome={{ kind: 'forbidden' }} viewerId={null} />);
    expect(screen.getByText(/second factor/i)).toBeInTheDocument();
  });

  it('invites a signed-out visitor to sign in', () => {
    render(<ApprovalQueue outcome={{ kind: 'signed-out' }} viewerId={null} />);
    expect(screen.getByText(/sign in to see/i)).toBeInTheDocument();
  });

  it('keeps the exact timestamps in the markup', () => {
    render(
      <ApprovalQueue
        outcome={{ kind: 'loaded', approvals: [APPROVAL] }}
        viewerId={null}
      />,
    );

    const proposed = screen.getByText(/1 Aug 2026/);
    expect(proposed.closest('time')).toHaveAttribute('dateTime', APPROVAL.proposedAt);
  });
});
