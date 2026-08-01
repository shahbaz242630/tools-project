import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The server action is mocked — it imports `@clerk/nextjs/server` and
 * `next/headers`. What matters here is the form's contract with the
 * administrator using it: that a reason is demanded, that the wording does not
 * imply the change has happened, and that they are told who reads it.
 */
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
  proposeRoleChangeAction: vi.fn(),
  decideApprovalAction: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { RoleChangeForm } = await import('./role-change-form');

function withState(next: Partial<typeof state.current>) {
  state.current = { ...state.current, ...next };
}

describe('RoleChangeForm', () => {
  it('demands a reason, and marks it required', () => {
    withState({ status: 'idle', message: null });
    render(<RoleChangeForm />);

    expect(screen.getByLabelText(/^why$/i)).toBeRequired();
  });

  it('says Propose, never Save or Apply', () => {
    // Not wording for its own sake. An administrator who believes they have
    // just changed a role will not go looking for the second approver, and the
    // proposal sits in a queue nobody clears.
    withState({ status: 'idle', message: null });
    render(<RoleChangeForm />);

    const button = screen.getByRole('button');
    expect(button).toHaveTextContent(/propose/i);
    expect(button).not.toHaveTextContent(/save|apply|change/i);
  });

  it('tells the administrator who will read the reason', () => {
    withState({ status: 'idle', message: null });
    render(<RoleChangeForm />);

    expect(screen.getByText(/another administrator reads this/i)).toBeInTheDocument();
  });

  it('offers both roles', () => {
    withState({ status: 'idle', message: null });
    render(<RoleChangeForm />);

    expect(screen.getByRole('option', { name: /administrator/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /ordinary user/i })).toBeInTheDocument();
  });

  it('reports success without implying the change has happened', () => {
    withState({
      status: 'done',
      message:
        'Proposed. Nothing has changed yet — another administrator has to agree, and it cannot be you.',
    });
    render(<RoleChangeForm />);

    expect(screen.getByRole('status')).toHaveTextContent(/nothing has changed yet/i);
  });

  it('keeps what was typed when the proposal was refused', () => {
    // Retyping a support ticket reference after a refusal is how people start
    // pasting the same three characters into the box.
    withState({
      status: 'error',
      message: 'that account is already ADMIN',
      userId: '11111111-1111-4111-8111-111111111111',
      reason: 'support ticket 4821, promoting a colleague',
    });
    render(<RoleChangeForm />);

    expect(screen.getByLabelText(/account id/i)).toHaveValue(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/already ADMIN/);
  });
});
