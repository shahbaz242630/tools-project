import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SignInList } from './sign-in-list';
import type { SignInEntry } from '@platform/contracts';
import type { SignInsOutcome } from '../lib/sign-ins';

// Typed as the contract rather than `as const`: the literal types that produces
// make every override below a type error, and vitest transpiles without
// checking so the suite would stay green while `pnpm typecheck` went red.
const ENTRY: SignInEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  event: 'started',
  sessionId: 'sess_3HDhyL6953Z755UaiBQzqU9maQA',
  occurredAt: '2026-07-30T10:53:19.422Z',
  ipAddress: '2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e',
  browserName: 'Edge',
  browserVersion: '150.0.0.0',
  deviceType: 'Windows',
  isMobile: false,
};

const loaded = (...entries: SignInEntry[]): SignInsOutcome => ({
  kind: 'loaded',
  entries: [...entries],
});

describe('SignInList', () => {
  it('shows the device and the address', () => {
    render(<SignInList outcome={loaded(ENTRY)} />);

    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText('Edge on Windows')).toBeInTheDocument();
    expect(
      screen.getByText('2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e'),
    ).toBeInTheDocument();
  });

  it('renders an IPv6 address in full', () => {
    // Clerk sends either IP family. Nothing truncates, and a
    // table that quietly cut one would make two different addresses look alike.
    render(<SignInList outcome={loaded(ENTRY)} />);

    const cell = screen.getByText('2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e');
    expect(cell.textContent).toBe('2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e');
  });

  it.each([
    ['started', 'Signed in'],
    ['ended', 'Signed out'],
    ['removed', 'Session removed'],
    ['revoked', 'Session revoked'],
  ] as const)('describes %s as "%s"', (event, expected) => {
    render(<SignInList outcome={loaded({ ...ENTRY, event })} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('keeps revoked distinct from signed out', () => {
    // The line somebody scanning for an intrusion is looking for: a session
    // deliberately killed, possibly not by them. Collapsing the two would hide
    // it among ordinary sign-outs.
    render(
      <SignInList
        outcome={loaded(
          { ...ENTRY, event: 'ended' },
          { ...ENTRY, id: '22222222-2222-4222-8222-222222222222', event: 'revoked' },
        )}
      />,
    );

    expect(screen.getByText('Signed out')).toBeInTheDocument();
    expect(screen.getByText('Session revoked')).toBeInTheDocument();
  });

  it('says a missing device is not recorded', () => {
    render(
      <SignInList
        outcome={loaded({
          ...ENTRY,
          browserName: null,
          deviceType: null,
          ipAddress: null,
        })}
      />,
    );

    expect(screen.getByText('Device not recorded')).toBeInTheDocument();
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
  });

  it('does not claim nobody signed in when the list is empty', () => {
    // The reader plainly did sign in. An empty list means we have no record
    // yet, which is a different claim and the only honest one.
    render(<SignInList outcome={{ kind: 'loaded', entries: [] }} />);

    expect(screen.getByText(/No sign-ins recorded yet/)).toBeInTheDocument();
    expect(screen.getByText(/not evidence that nobody signed in/)).toBeInTheDocument();
  });

  it.each([
    [{ kind: 'unreachable', reason: 'ECONNREFUSED' } as const],
    [{ kind: 'malformed', reason: 'bad shape' } as const],
  ])('never renders a failure as an empty history', (outcome) => {
    // The most misleading thing this page could do is show "no sign-ins"
    // because a fetch timed out.
    render(<SignInList outcome={outcome} />);

    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.getByText(/not a record of nobody signing in/)).toBeInTheDocument();
    expect(screen.queryByText(/No sign-ins recorded yet/)).not.toBeInTheDocument();
  });

  it('names the reason a load failed', () => {
    render(<SignInList outcome={{ kind: 'unreachable', reason: 'ECONNREFUSED' }} />);
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
  });

  it('asks for a sign-in when signed out', () => {
    render(<SignInList outcome={{ kind: 'signed-out' }} />);
    expect(screen.getByText(/Sign in to see the sign-in history/)).toBeInTheDocument();
  });

  it('takes somebody to the devices, rather than telling them to go there', () => {
    // This test used to be named for an action and assert only that a sentence
    // existed. It passed for five slices over copy that named a destination and
    // linked to nothing — the §10 lesson that a test's name is documentation
    // and only its assertion is evidence. The assertion is now the `href`.
    render(<SignInList outcome={loaded(ENTRY)} />);

    expect(screen.getByText(/Do not recognise one of these/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /devices signed in to your account/i }),
    ).toHaveAttribute('href', '/account/email/security');
  });

  it('lands on the devices themselves, not the tab in front of them', () => {
    // `/account/email` opens Clerk's Profile tab, which is a list of email
    // addresses. A link that promises devices and delivers an email form has
    // simply moved the problem along by one page — found by opening it, which
    // no assertion about the bare path would have caught.
    render(<SignInList outcome={loaded(ENTRY)} />);

    const href = screen
      .getByRole('link', { name: /devices signed in to your account/i })
      .getAttribute('href');

    expect(href?.endsWith('/security')).toBe(true);
  });

  it('keeps the machine-readable timestamp in the markup', () => {
    const { container } = render(<SignInList outcome={loaded(ENTRY)} />);
    expect(
      container.querySelector('time[datetime="2026-07-30T10:53:19.422Z"]'),
    ).not.toBeNull();
  });
});
