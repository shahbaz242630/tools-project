import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActivityList } from './activity-list';
import type { ActivityOutcome } from '../lib/activity';
import type { ActivityEntry } from '@platform/contracts';

// Typed as the contract rather than `as const`. `as const` freezes every field
// to a literal type, so each override below becomes a type error — and vitest
// transpiles without checking, so the suite stays green while `pnpm typecheck`
// goes red. That cost a while in slice 1.11a and was still here.
const ENTRY: ActivityEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  action: 'profile.updated',
  targetType: 'profile',
  by: 'subject',
  reason: null,
  ipAddress: '203.0.113.7',
  sessionId: 'sess_alice',
  createdAt: '2026-07-31T09:00:00.000Z',
};

const ADMIN_REASON = 'support ticket 4821, account access query';

/**
 * An administrator reading this account.
 *
 * The address *and* the session are withheld by the API — both belong to the
 * administrator, and neither is the subject's to see.
 */
const DISCLOSURE: ActivityEntry = {
  ...ENTRY,
  id: '22222222-2222-4222-8222-222222222222',
  action: 'admin.activity_viewed',
  targetType: 'user',
  by: 'administrator',
  reason: ADMIN_REASON,
  ipAddress: null,
  sessionId: null,
};

/** What the page passes: the sign-in history, indexed by session. */
const DEVICES = new Map([['sess_alice', 'Edge on Windows']]);

describe('ActivityList', () => {
  it('lists an entry in words rather than in machine vocabulary', () => {
    render(<ActivityList outcome={{ kind: 'loaded', entries: [ENTRY] }} />);

    expect(screen.getByText('Profile updated')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('shows an administrator’s read, and why', () => {
    // The row this page existed without. BRD §8.13's reason requirement is only
    // a control because the person it was written about can read it.
    render(<ActivityList outcome={{ kind: 'loaded', entries: [DISCLOSURE] }} />);

    expect(screen.getByText('Account activity viewed')).toBeInTheDocument();
    expect(screen.getByText('An administrator')).toBeInTheDocument();
    expect(screen.getByText(ADMIN_REASON)).toBeInTheDocument();
  });

  it('names the device an action was taken from', () => {
    // The sentence slice 1.11c exists to produce: the audit entry and the
    // sign-in are joined by session, so "something happened at 09:00" becomes
    // "something happened from the device you signed in on".
    render(
      <ActivityList outcome={{ kind: 'loaded', entries: [ENTRY] }} devices={DEVICES} />,
    );

    expect(screen.getByText('Edge on Windows · 203.0.113.7')).toBeInTheDocument();
  });

  it('shows the address alone when no sign-in matches the session', () => {
    // A session.created we never received — bounded and expected (ADR 0025).
    // It must degrade to what this page showed before the join existed.
    render(
      <ActivityList
        outcome={{ kind: 'loaded', entries: [ENTRY] }}
        devices={new Map()}
      />,
    );

    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
  });

  it('never names a device for somebody else’s action', () => {
    // The disclosure carries no session precisely so this cannot happen, but
    // the assertion is at the rendered output because that is where a future
    // change would show up — a component that resolved from a different field
    // would pass every test above and fail this one.
    render(
      <ActivityList
        outcome={{ kind: 'loaded', entries: [DISCLOSURE] }}
        devices={DEVICES}
      />,
    );

    expect(screen.queryByText(/Edge on Windows/)).toBeNull();
  });

  it('names no administrator', () => {
    // The subject is entitled to know their account was read and why. They are
    // not entitled to the identity or the address of the person who read it,
    // and the API sends neither — this pins that the page invents neither.
    render(<ActivityList outcome={{ kind: 'loaded', entries: [DISCLOSURE] }} />);

    expect(screen.getByText('Not recorded')).toBeInTheDocument();
  });

  it('calls an action with no actor automatic rather than administrative', () => {
    // A provider webhook applied it with nobody holding a session. "An
    // administrator" would name somebody who was not involved.
    render(
      <ActivityList
        outcome={{
          kind: 'loaded',
          entries: [{ ...ENTRY, action: 'account.email_changed', by: 'system' }],
        }}
      />,
    );

    expect(screen.getByText('Automatic')).toBeInTheDocument();
  });

  it('falls back to the raw action rather than dropping the row', () => {
    // A new action shipped by the API before this map knows it is a slightly
    // ugly row. A missing row in an audit trail is the failure that matters.
    render(
      <ActivityList
        outcome={{
          kind: 'loaded',
          entries: [{ ...ENTRY, action: 'account.suspended' }],
        }}
      />,
    );
    expect(screen.getByText('account.suspended')).toBeInTheDocument();
  });

  it('says an address was not recorded rather than leaving a blank', () => {
    // Genuinely unknown, not missing — the API never sees a browser directly.
    // A blank cell reads as a bug in the page.
    render(
      <ActivityList
        outcome={{ kind: 'loaded', entries: [{ ...ENTRY, ipAddress: null }] }}
      />,
    );
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
  });

  it('keeps the exact timestamp in the markup while showing a friendly one', () => {
    render(<ActivityList outcome={{ kind: 'loaded', entries: [ENTRY] }} />);

    const when = screen.getByText(/2026/);
    expect(when.closest('time')).toHaveAttribute('dateTime', ENTRY.createdAt);
  });

  it('says plainly when there is nothing recorded yet', () => {
    render(<ActivityList outcome={{ kind: 'loaded', entries: [] }} />);
    expect(screen.getByText(/nothing has been recorded/i)).toBeInTheDocument();
  });

  it.each([
    ['unreachable', { kind: 'unreachable', reason: 'connect ECONNREFUSED' }],
    ['malformed', { kind: 'malformed', reason: 'id: invalid uuid' }],
  ])('never reads as "nothing happened" when %s', (_case, outcome) => {
    // The distinction this component exists to preserve. "Nothing has happened
    // on your account" is a security claim, and rendering it because the API
    // timed out is a false reassurance — worse than an error.
    render(<ActivityList outcome={outcome as ActivityOutcome} />);

    expect(screen.queryByText(/nothing has been recorded/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not a record of nothing happening/i)).toBeInTheDocument();
  });

  it('invites a signed-out visitor to sign in', () => {
    render(<ActivityList outcome={{ kind: 'signed-out' }} />);
    expect(screen.getByText(/sign in to see activity/i)).toBeInTheDocument();
  });

  it('calls a refusal a decision, and still not a record of nothing', () => {
    render(<ActivityList outcome={{ kind: 'forbidden' }} />);

    // Both claims this component must never make: that nothing happened, and
    // that the visitor should sign in again against a token that was accepted.
    expect(screen.queryByText(/nothing has been recorded/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sign in to see activity/i)).not.toBeInTheDocument();

    expect(screen.getByText(/decision about your account/i)).toBeInTheDocument();
    expect(screen.getByText(/account page/i)).toBeInTheDocument();

    // Never a status code at a person.
    expect(screen.queryByText(/403/)).not.toBeInTheDocument();
  });
});
