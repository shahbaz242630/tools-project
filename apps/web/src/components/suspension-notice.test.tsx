import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SuspensionNotice } from './suspension-notice';

const ACTIVE = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alice@example.com',
  role: 'USER' as const,
  suspendedAt: null,
  suspensionReason: null,
};

const SUSPENDED = {
  ...ACTIVE,
  suspendedAt: '2026-08-01T09:00:00.000Z',
  suspensionReason: 'suspected fraud, ticket 4821',
};

describe('SuspensionNotice', () => {
  it('renders nothing at all for an account that is not suspended', () => {
    // A greyed-out or empty banner would worry people for no reason.
    const { container } = render(<SuspensionNotice account={ACTIVE} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says plainly that the account is suspended', () => {
    render(<SuspensionNotice account={SUSPENDED} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/this account is suspended/i);
  });

  it('shows the reason in the administrator’s own words', () => {
    // The same bargain ADR 0021 struck for administrative reads: whoever writes
    // it knows the person will read it.
    render(<SuspensionNotice account={SUSPENDED} />);
    expect(screen.getByText(SUSPENDED.suspensionReason)).toBeInTheDocument();
  });

  it('still renders without a reason rather than breaking', () => {
    // The CHECK constraint makes this unreachable from the database, but an
    // older API could serve it during a deploy skew, and a page that threw
    // would tell somebody nothing at all.
    render(<SuspensionNotice account={{ ...SUSPENDED, suspensionReason: null }} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/this account is suspended/i);
  });

  it('points at the rights that still work', () => {
    // Data-protection rights do not lapse on suspension, and saying so here is
    // what makes them reachable in practice rather than only in principle.
    render(<SuspensionNotice account={SUSPENDED} />);

    expect(screen.getByRole('link', { name: /download everything/i })).toHaveAttribute(
      'href',
      '/account/data',
    );
    expect(screen.getByRole('link', { name: /delete your account/i })).toHaveAttribute(
      'href',
      '/account/delete',
    );
  });

  it('keeps the exact timestamp in the markup', () => {
    render(<SuspensionNotice account={SUSPENDED} />);

    const when = screen.getByText(/1 Aug 2026/);
    expect(when.closest('time')).toHaveAttribute('dateTime', SUSPENDED.suspendedAt);
  });

  it('says what is no longer possible', () => {
    // Somebody who thinks the site is broken keeps retrying instead of
    // responding, so the notice has to read as a decision rather than a fault.
    render(<SuspensionNotice account={SUSPENDED} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot list, book or change/i);
  });
});
