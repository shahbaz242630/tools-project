import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * The server action is mocked — it imports `@clerk/nextjs/server` and
 * `next/headers`. What matters here is what the screen discloses, and what it
 * refuses to.
 */
const state = vi.hoisted(() => ({
  current: {
    status: 'idle' as 'idle' | 'loaded' | 'error',
    view: null as unknown,
    message: null as string | null,
    userId: '',
    reason: '',
  },
}));

vi.mock('../app/admin/users/actions', () => ({
  INITIAL_ADMIN_USER_STATE: state.current,
  lookUpAccountAction: vi.fn(),
  INITIAL_SUSPENSION_STATE: { status: 'idle', message: null, reason: '' },
  decideSuspensionAction: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { AdminUserLookup } = await import('./admin-user-lookup');

function withState(next: Partial<typeof state.current>) {
  state.current = { ...state.current, ...next };
}

/**
 * The value rendered against a term in the description list.
 *
 * Reading by term rather than by text, because several rows legitimately share
 * a value — "No" answers the phone question and both deletion fields — and
 * `getByText` would either be ambiguous or match the wrong row silently.
 */
function valueFor(term: string): string | null | undefined {
  return screen.getByText(term).nextElementSibling?.textContent;
}

const VIEW = {
  account: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'bob@example.com',
    role: 'USER',
    createdAt: '2026-07-15T09:00:00.000Z',
    deletedAt: null,
    deletionRequestedAt: null,
    suspendedAt: null,
    suspensionReason: null,
  },
  profile: {
    displayName: 'Bob B.',
    hasPhone: true,
    address: { town: 'Bristol', outwardCode: 'BS7' },
    updatedAt: '2026-07-31T09:00:00.000Z',
  },
};

describe('AdminUserLookup', () => {
  it('demands a reason, and marks it required', () => {
    withState({ status: 'idle', view: null, message: null });
    render(<AdminUserLookup />);

    expect(screen.getByLabelText(/why you are looking/i)).toBeRequired();
  });

  it('tells the administrator the account holder will read it', () => {
    withState({ status: 'idle', view: null, message: null });
    render(<AdminUserLookup />);

    expect(
      screen.getByText(/the person it belongs to can read this/i),
    ).toBeInTheDocument();
  });

  it('shows the account and the district', () => {
    withState({ status: 'loaded', view: VIEW, message: null });
    render(<AdminUserLookup />);

    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    expect(screen.getByText('Bob B.')).toBeInTheDocument();
    expect(screen.getByText('Bristol (BS7)')).toBeInTheDocument();
  });

  it('says whether a phone number is saved, never showing one', () => {
    withState({ status: 'loaded', view: VIEW, message: null });
    const { container } = render(<AdminUserLookup />);

    expect(screen.getByText('Yes')).toBeInTheDocument();
    // Asserted over the rendered markup, so a field added to this screen later
    // that happens to carry digits is caught here (ADR 0022).
    expect(container.textContent).not.toMatch(/\+?44\d{9,}|07\d{9}/);
  });

  it('says plainly what it does not show', () => {
    // A support worker who does not know the view is narrowed will read a
    // missing street line as missing data and go looking for it elsewhere.
    withState({ status: 'loaded', view: VIEW, message: null });
    render(<AdminUserLookup />);

    expect(screen.getByText(/does not show street lines/i)).toBeInTheDocument();
  });

  it('distinguishes an account with no profile from a broken lookup', () => {
    withState({
      status: 'loaded',
      view: { ...VIEW, profile: null },
      message: null,
    });
    render(<AdminUserLookup />);

    expect(screen.getByText(/no profile has been created/i)).toBeInTheDocument();
  });

  it('shows a deletion rather than hiding it', () => {
    // Support is asked about a deleted account precisely because it is deleted.
    withState({
      status: 'loaded',
      message: null,
      view: {
        ...VIEW,
        account: {
          ...VIEW.account,
          deletedAt: '2026-07-31T12:00:00.000Z',
          deletionRequestedAt: '2026-07-31T12:00:00.000Z',
        },
        profile: null,
      },
    });
    render(<AdminUserLookup />);

    expect(screen.getAllByText('2026-07-31T12:00:00.000Z')).toHaveLength(2);
  });

  it('says an address is absent rather than leaving a blank', () => {
    withState({
      status: 'loaded',
      message: null,
      view: { ...VIEW, profile: { ...VIEW.profile, address: null, hasPhone: false } },
    });
    render(<AdminUserLookup />);

    expect(screen.getByText('No address saved')).toBeInTheDocument();
    // Read from the term rather than by text — "No" is also the answer to both
    // deletion fields, and `getByText('No')` would pass on the wrong one.
    expect(valueFor('Phone number saved')).toBe('No');
  });

  it('shows why access was refused', () => {
    withState({
      status: 'error',
      view: null,
      message:
        'You do not have access to this. Administrator access needs a second factor.',
    });
    render(<AdminUserLookup />);

    expect(screen.getByRole('alert')).toHaveTextContent(/second factor/i);
  });

  it('keeps what was typed when the lookup was refused', () => {
    withState({
      status: 'error',
      view: null,
      message: 'Give a reason of at least 12 characters.',
      userId: '11111111-1111-4111-8111-111111111111',
      reason: 'short',
    });
    render(<AdminUserLookup />);

    expect(screen.getByLabelText(/account id/i)).toHaveValue(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(screen.getByLabelText(/why you are looking/i)).toHaveValue('short');
  });

  it('shows nothing before a lookup has run', () => {
    withState({ status: 'idle', view: null, message: null });
    render(<AdminUserLookup />);

    expect(screen.queryByText(/^Account$/)).not.toBeInTheDocument();
  });

  it('offers the lookup and suspension, and nothing else', () => {
    // This assertion used to read "no control that changes anything", which was
    // true when the view was purely read-only (ADR 0022) and is deliberately
    // not any more: slice 1.10b adds suspension. What still holds is the rule
    // that mattered — BRD §8.13 prohibits write-capable impersonation at
    // launch, so there is no control here that acts *as* the account holder.
    withState({ status: 'loaded', view: VIEW, message: null });
    render(<AdminUserLookup />);

    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Look up account', 'Suspend']);
  });

  it('offers reinstatement instead once the account is suspended', () => {
    // One button, chosen by the state the account is in. Both would be a
    // control the API refuses, and a button that answers 409 reads as a fault.
    withState({
      status: 'loaded',
      message: null,
      view: {
        ...VIEW,
        account: {
          ...VIEW.account,
          suspendedAt: '2026-08-01T09:00:00.000Z',
          suspensionReason: 'suspected fraud, ticket 4821',
        },
      },
    });
    render(<AdminUserLookup />);

    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Look up account', 'Reinstate']);
    expect(screen.getByText('suspected fraud, ticket 4821')).toBeInTheDocument();
  });

  it('offers no suspension control for a deleted account', () => {
    // The API refuses it, so the button would only ever produce a 409.
    withState({
      status: 'loaded',
      message: null,
      view: {
        ...VIEW,
        account: { ...VIEW.account, deletedAt: '2026-07-31T12:00:00.000Z' },
      },
    });
    render(<AdminUserLookup />);

    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Look up account',
    ]);
  });
});
