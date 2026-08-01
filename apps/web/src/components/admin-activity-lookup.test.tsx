import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The server action is mocked — it imports `@clerk/nextjs/server` and
 * `next/headers`. What matters here is the form's contract with the person
 * using it: that a reason is demanded, that they are told it will be read by
 * the account holder, and that the three outcomes read differently.
 */
const state = vi.hoisted(() => ({
  current: {
    status: 'idle' as 'idle' | 'loaded' | 'error',
    entries: [] as unknown[],
    message: null as string | null,
    userId: '',
    reason: '',
  },
}));

vi.mock('../app/admin/activity/actions', () => ({
  INITIAL_ADMIN_LOOKUP_STATE: state.current,
  lookUpActivityAction: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { AdminActivityLookup } = await import('./admin-activity-lookup');

function withState(next: Partial<typeof state.current>) {
  state.current = { ...state.current, ...next };
}

const ENTRY = {
  id: '22222222-2222-4222-8222-222222222222',
  action: 'profile.updated',
  targetType: 'profile',
  by: 'subject',
  reason: null,
  ipAddress: '203.0.113.7',
  createdAt: '2026-07-31T09:00:00.000Z',
};

describe('AdminActivityLookup', () => {
  it('demands a reason, and marks it required', () => {
    withState({ status: 'idle', entries: [], message: null });
    render(<AdminActivityLookup />);

    expect(screen.getByLabelText(/why you are looking/i)).toBeRequired();
  });

  it('tells the administrator the account holder will read it', () => {
    // What makes a mandatory reason a control rather than a box to clear: the
    // person typing it knows, at that moment, who will read it.
    withState({ status: 'idle', entries: [], message: null });
    render(<AdminActivityLookup />);

    expect(
      screen.getByText(/the person it belongs to can read this/i),
    ).toBeInTheDocument();
  });

  it('keeps what was typed when the lookup was refused', () => {
    // Retyping a support ticket reference after a rejected reason is how people
    // start pasting the same three characters into the box.
    withState({
      status: 'error',
      message: 'Give a reason of at least 12 characters.',
      userId: '11111111-1111-4111-8111-111111111111',
      reason: 'short',
    });
    render(<AdminActivityLookup />);

    expect(screen.getByLabelText(/account id/i)).toHaveValue(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(screen.getByLabelText(/why you are looking/i)).toHaveValue('short');
  });

  it('shows why access was refused', () => {
    withState({
      status: 'error',
      message:
        'You do not have access to this. Administrator access needs a second factor.',
      entries: [],
    });
    render(<AdminActivityLookup />);

    expect(screen.getByRole('alert')).toHaveTextContent(/second factor/i);
  });

  it('lists the entries, including the reason column', () => {
    withState({ status: 'loaded', entries: [ENTRY], message: null });
    render(<AdminActivityLookup />);

    expect(screen.getByText('Profile updated')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
  });

  it('calls the subject the account holder, never "you"', () => {
    // The reader here is the administrator, not the subject. "You" on this
    // screen is how a support worker misreads whose action they are looking at.
    withState({ status: 'loaded', entries: [ENTRY], message: null });
    render(<AdminActivityLookup />);

    expect(screen.getByText('Account holder')).toBeInTheDocument();
    expect(screen.queryByText('You')).not.toBeInTheDocument();
  });

  it('shows a colleague’s earlier access to the same account', () => {
    // Support sees the same history the account holder does, so an enquiry does
    // not start with the two sides describing different pasts.
    withState({
      status: 'loaded',
      message: null,
      entries: [
        {
          ...ENTRY,
          id: '33333333-3333-4333-8333-333333333333',
          action: 'admin.activity_viewed',
          by: 'administrator',
          reason: 'support ticket 4820, earlier query',
          ipAddress: null,
        },
      ],
    });
    render(<AdminActivityLookup />);

    expect(screen.getByText('Account activity viewed')).toBeInTheDocument();
    expect(screen.getByText('An administrator')).toBeInTheDocument();
    expect(screen.getByText('support ticket 4820, earlier query')).toBeInTheDocument();
  });

  it('says plainly when there is nothing recorded', () => {
    // A real answer, and the same answer for an account that does not exist —
    // the API does not distinguish them, and neither should this.
    withState({ status: 'loaded', entries: [], message: null });
    render(<AdminActivityLookup />);

    expect(screen.getByText(/no activity is recorded/i)).toBeInTheDocument();
  });

  it('shows no results table before a lookup has run', () => {
    withState({ status: 'idle', entries: [], message: null });
    render(<AdminActivityLookup />);

    expect(screen.queryByText(/no activity is recorded/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
