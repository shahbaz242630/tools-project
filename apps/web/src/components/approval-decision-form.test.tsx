import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  current: {
    status: 'idle' as 'idle' | 'done' | 'error',
    message: null as string | null,
    userId: '',
    reason: '',
  },
}));

vi.mock('../app/admin/approvals/actions', () => ({
  INITIAL_APPROVAL_STATE: state.current,
  decideApprovalAction: vi.fn(),
  proposeRoleChangeAction: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { ApprovalDecisionForm } = await import('./approval-decision-form');

function withState(next: Partial<typeof state.current>) {
  state.current = { ...state.current, ...next };
}

const ID = '22222222-2222-4222-8222-222222222222';

describe('ApprovalDecisionForm', () => {
  it('demands a reason for either decision', () => {
    // One reason field shared by both buttons, so whichever is pressed is
    // pressed *with* an explanation. Separate forms would make the one without
    // a reason box the easy path.
    withState({ status: 'idle', message: null });
    render(<ApprovalDecisionForm id={ID} canApprove />);

    expect(screen.getByLabelText(/your reason/i)).toBeRequired();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('carries the proposal id, so the decision cannot be applied to another', () => {
    withState({ status: 'idle', message: null });
    const { container } = render(<ApprovalDecisionForm id={ID} canApprove />);

    expect(container.querySelector('input[name="id"]')).toHaveValue(ID);
  });

  it('sends which decision was pressed', () => {
    withState({ status: 'idle', message: null });
    render(<ApprovalDecisionForm id={ID} canApprove />);

    const values = screen.getAllByRole('button').map((b) => b.getAttribute('value'));
    expect(values).toEqual(['approve', 'cancel']);
  });

  it('offers only withdrawal on your own proposal', () => {
    // A courtesy so nobody presses a button they will be refused for. The API
    // and a database CHECK constraint are what actually stop a self-approval.
    withState({ status: 'idle', message: null });
    render(<ApprovalDecisionForm id={ID} canApprove={false} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(/withdraw/i);
  });

  it('reports a refusal as an alert', () => {
    withState({
      status: 'error',
      message: 'you proposed this, so somebody else has to approve it',
    });
    render(<ApprovalDecisionForm id={ID} canApprove />);

    expect(screen.getByRole('alert')).toHaveTextContent(/somebody else has to/i);
  });

  it('says plainly when the change has taken effect', () => {
    // The counterpart to the propose form's wording: here the change really has
    // happened, and saying so is what stops somebody approving it twice.
    withState({
      status: 'done',
      message: 'Approved, and the change has taken effect.',
    });
    render(<ApprovalDecisionForm id={ID} canApprove />);

    expect(screen.getByRole('status')).toHaveTextContent(/taken effect/i);
  });
});
