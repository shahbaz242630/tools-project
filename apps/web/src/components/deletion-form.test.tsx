import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The server action is mocked — it imports `@clerk/nextjs/server` and
 * `next/headers`, neither of which loads outside a Next request. What is worth
 * testing here is the confirmation gate and what a person is told afterwards.
 */
const state = vi.hoisted(() => ({
  current: { status: 'idle', message: null as string | null, credentialRemains: false },
}));

vi.mock('../app/account/delete/actions', () => ({
  INITIAL_DELETION_FORM_STATE: state.current,
  deleteAccountAction: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  // `importOriginal` rather than `importActual<typeof import('react')>`, which
  // needs an inline `import()` type the project bans — it erases the metadata
  // NestJS relies on elsewhere, so the rule is on everywhere for consistency.
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Returns whatever the test set, so every branch is reachable without
    // driving a real server action.
    useActionState: () => [state.current, vi.fn(), false],
  };
});

const { DeletionForm } = await import('./deletion-form');

function withState(next: Partial<typeof state.current>) {
  state.current = { ...state.current, ...next };
}

describe('DeletionForm', () => {
  it('asks for a typed confirmation rather than a checkbox', () => {
    // There is no undo and no grace period, so an accidental submit is total.
    // Typing the word is proportionate to a cost that cannot be reversed.
    withState({ status: 'idle', message: null });
    render(<DeletionForm />);

    expect(screen.getByLabelText(/type\s+DELETE\s+to confirm/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('says nothing is deleted until the form is submitted', () => {
    withState({ status: 'idle', message: null });
    render(<DeletionForm />);
    expect(screen.getByText(/nothing is deleted until/i)).toBeInTheDocument();
  });

  it('offers a way out', () => {
    withState({ status: 'idle', message: null });
    render(<DeletionForm />);
    expect(screen.getByRole('link', { name: /cancel/i })).toBeInTheDocument();
  });

  it('shows why nothing happened when the confirmation was wrong', () => {
    withState({
      status: 'error',
      message: 'Type DELETE to confirm. Nothing has been changed.',
    });
    render(<DeletionForm />);

    expect(screen.getByRole('alert')).toHaveTextContent(/nothing has been changed/i);
  });

  it('confirms the deletion when it is done', () => {
    withState({ status: 'deleted', message: null, credentialRemains: false });
    render(<DeletionForm />);

    expect(screen.getByRole('status')).toHaveTextContent(/has been deleted/i);
    // The form is gone — offering it again after success invites a retry that
    // cannot authenticate.
    expect(
      screen.queryByRole('button', { name: /delete my account/i }),
    ).not.toBeInTheDocument();
  });

  it('explains a surviving sign-in rather than leaving it a mystery', () => {
    // Our side is erased and its sessions are refused, so nothing is reachable
    // — but somebody may still look signed in, and finding that out
    // unexplained would be alarming.
    withState({ status: 'deleted', message: null, credentialRemains: true });
    render(<DeletionForm />);

    expect(screen.getByText(/take a little longer to disappear/i)).toBeInTheDocument();
    expect(screen.getByText(/already deleted/i)).toBeInTheDocument();
  });

  it('does not mention a surviving sign-in when there is none', () => {
    withState({ status: 'deleted', message: null, credentialRemains: false });
    render(<DeletionForm />);

    expect(screen.queryByText(/take a little longer/i)).not.toBeInTheDocument();
  });
});
