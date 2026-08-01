import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  current: {
    status: 'idle' as 'idle' | 'done' | 'error',
    message: null as string | null,
    reason: '',
  },
}));

vi.mock('../app/admin/users/actions', () => ({
  INITIAL_SUSPENSION_STATE: state.current,
  decideSuspensionAction: vi.fn(),
  INITIAL_ADMIN_USER_STATE: {},
  lookUpAccountAction: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { SuspensionControls } = await import('./suspension-controls');

function withState(next: Partial<typeof state.current>) {
  state.current = { ...state.current, ...next };
}

const USER = '11111111-1111-4111-8111-111111111111';

describe('SuspensionControls', () => {
  it('offers exactly one button, matching the current state', () => {
    // Both would be a control the API refuses, and a button that answers 409
    // reads as a fault in the site rather than a decision about the account.
    withState({ status: 'idle', message: null });
    render(<SuspensionControls userId={USER} suspended={false} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent('Suspend');
  });

  it('offers reinstatement for a suspended account', () => {
    withState({ status: 'idle', message: null });
    render(<SuspensionControls userId={USER} suspended />);

    expect(screen.getByRole('button')).toHaveTextContent('Reinstate');
  });

  it('demands a reason either way', () => {
    withState({ status: 'idle', message: null });
    render(<SuspensionControls userId={USER} suspended={false} />);

    expect(screen.getByLabelText(/^why$/i)).toBeRequired();
  });

  it('tells the administrator the person will read it', () => {
    // This is the one admin action not behind a second administrator, so the
    // reason and its audience are the whole control (ADR 0024).
    withState({ status: 'idle', message: null });
    render(<SuspensionControls userId={USER} suspended={false} />);

    expect(screen.getByText(/something you would say to them/i)).toBeInTheDocument();
  });

  it('warns before the button is pressed that data rights survive', () => {
    // Said in advance, not after. An administrator who believes suspension cuts
    // somebody off entirely will be surprised by an export request from them.
    withState({ status: 'idle', message: null });
    render(<SuspensionControls userId={USER} suspended={false} />);

    expect(screen.getByText(/do not lapse on suspension/i)).toBeInTheDocument();
  });

  it('does not repeat that warning when lifting a suspension', () => {
    withState({ status: 'idle', message: null });
    render(<SuspensionControls userId={USER} suspended />);

    expect(screen.queryByText(/do not lapse on suspension/i)).not.toBeInTheDocument();
  });

  it('carries the account id, so the decision cannot land on another', () => {
    withState({ status: 'idle', message: null });
    const { container } = render(
      <SuspensionControls userId={USER} suspended={false} />,
    );

    expect(container.querySelector('input[name="userId"]')).toHaveValue(USER);
    expect(container.querySelector('input[name="decision"]')).toHaveValue('suspend');
  });

  it('reports a refusal as an alert', () => {
    withState({
      status: 'error',
      message: 'you cannot suspend yourself — you would not be able to undo it',
    });
    render(<SuspensionControls userId={USER} suspended={false} />);

    expect(screen.getByRole('alert')).toHaveTextContent(/cannot suspend yourself/i);
  });

  it('says what suspension left the person able to do', () => {
    withState({
      status: 'done',
      message:
        'Suspended. They can still sign in to read and download their data, and to delete the account.',
    });
    render(<SuspensionControls userId={USER} suspended={false} />);

    expect(screen.getByRole('status')).toHaveTextContent(/still sign in/i);
  });
});
