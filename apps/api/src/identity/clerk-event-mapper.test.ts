import { describe, expect, it } from 'vitest';
import { ClerkEventMappingError, mapClerkEvent } from './clerk-event-mapper.js';

const ADDRESS = { id: 'idn_primary', email_address: 'alice@example.com' };
const OTHER = { id: 'idn_other', email_address: 'old@example.com' };

describe('mapClerkEvent', () => {
  it.each([['user.created'], ['user.updated']])('maps %s to an upsert', (type) => {
    // Both collapse into one case: they differ only in what Clerk believed
    // about its own state, and webhooks are not ordered, so an `updated` can
    // legitimately arrive before the `created` it follows.
    expect(
      mapClerkEvent(type, {
        id: 'user_1',
        primary_email_address_id: ADDRESS.id,
        email_addresses: [ADDRESS],
      }),
    ).toEqual({
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: ADDRESS.email_address,
    });
  });

  it('picks the primary address, not the first', () => {
    // Clerk sends every address the account holds and names the primary
    // separately. Taking [0] is wrong as often as a person has two addresses —
    // and the order is not guaranteed to put the primary first.
    const event = mapClerkEvent('user.updated', {
      id: 'user_1',
      primary_email_address_id: ADDRESS.id,
      email_addresses: [OTHER, ADDRESS],
    });

    expect(event).toMatchObject({ email: 'alice@example.com' });
  });

  it('falls back to the sole address when no primary is named', () => {
    expect(
      mapClerkEvent('user.created', {
        id: 'user_1',
        email_addresses: [ADDRESS],
      }),
    ).toMatchObject({ email: ADDRESS.email_address });
  });

  it('refuses to guess between several addresses with no primary named', () => {
    // An account mid-change legitimately has more than one. Picking arbitrarily
    // would mirror the wrong address and, from Phase 6, send notifications to it.
    expect(() =>
      mapClerkEvent('user.updated', {
        id: 'user_1',
        email_addresses: [ADDRESS, OTHER],
      }),
    ).toThrow(ClerkEventMappingError);
  });

  it('rejects a user event carrying no address at all', () => {
    expect(() =>
      mapClerkEvent('user.created', { id: 'user_1', email_addresses: [] }),
    ).toThrow(ClerkEventMappingError);
  });

  it('maps user.deleted', () => {
    expect(mapClerkEvent('user.deleted', { id: 'user_1', deleted: true })).toEqual({
      type: 'user.deleted',
      clerkUserId: 'user_1',
    });
  });

  it.each([['organization.created'], ['email.created'], ['sms.created']])(
    'ignores %s rather than failing',
    (type) => {
      // Clerk delivers whatever the endpoint is subscribed to, and subscriptions
      // are widened from a dashboard. Treating an unknown type as an error turns
      // a settings change into an endless retry loop.
      //
      // `session.created` was in this list until slice 1.11a and is now mapped,
      // so the claim was rewritten rather than the assertion — the surviving
      // rule is about types we genuinely do not act on, not about this one.
      expect(mapClerkEvent(type, { id: 'x' })).toBeNull();
    },
  );

  it.each([
    ['no id', { email_addresses: [ADDRESS], primary_email_address_id: ADDRESS.id }],
    ['an empty id', { id: '', email_addresses: [ADDRESS] }],
  ])('rejects a user payload with %s', (_case, data) => {
    expect(() => mapClerkEvent('user.created', data)).toThrow(ClerkEventMappingError);
  });

  it('rejects a delete payload with no id', () => {
    expect(() => mapClerkEvent('user.deleted', { deleted: true })).toThrow(
      ClerkEventMappingError,
    );
  });

  it('names the event type in the failure', () => {
    // A mapping failure means Clerk changed shape. Whoever reads that log line
    // needs to know which event to go and look at.
    expect(() => mapClerkEvent('user.deleted', {})).toThrow(/user\.deleted/);
  });
});

describe('mapClerkEvent — session events', () => {
  // Field-for-field the shape of a real delivery: these values were read off
  // the dev instance's only live session via the Clerk Backend API, so the
  // fixture is Clerk's actual layout rather than a guess at it. Timestamps are
  // Unix **milliseconds**, which is the trap `Time.fromEpochMs` exists for.
  const SESSION = {
    object: 'session',
    id: 'sess_3HDhyL6953Z755UaiBQzqU9maQA',
    user_id: 'user_3HDhyHhToMvFEvYk1PFXtiYzAEm',
    client_id: 'client_1',
    status: 'active',
    created_at: 1785408799422,
    updated_at: 1785495199422,
    last_active_at: 1785495199422,
    expire_at: 1786013599422,
    abandon_at: 1788000799422,
    latest_activity: {
      object: 'session_activity',
      id: 'sess_activity_3HDhw2tsgrCWBaarkzt2haxbXAR',
      device_type: 'Windows',
      is_mobile: false,
      browser_name: 'Edge',
      browser_version: '150.0.0.0',
      ip_address: '2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e',
      city: 'Dubai',
      country: 'United Arab Emirates',
    },
  };

  it('maps session.created to a started event, with the device and place', () => {
    expect(mapClerkEvent('session.created', SESSION)).toEqual({
      type: 'session.recorded',
      clerkUserId: 'user_3HDhyHhToMvFEvYk1PFXtiYzAEm',
      clerkSessionId: 'sess_3HDhyL6953Z755UaiBQzqU9maQA',
      event: 'started',
      occurredAt: new Date('2026-07-30T10:53:19.422Z'),
      activity: {
        ipAddress: '2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e',
        city: 'Dubai',
        country: 'United Arab Emirates',
        browserName: 'Edge',
        browserVersion: '150.0.0.0',
        deviceType: 'Windows',
        isMobile: false,
      },
    });
  });

  it.each([
    ['session.ended', 'ended'],
    ['session.removed', 'removed'],
    ['session.revoked', 'revoked'],
  ])('maps %s to %s', (type, event) => {
    expect(mapClerkEvent(type, SESSION)).toMatchObject({
      type: 'session.recorded',
      event,
    });
  });

  it('dates a sign-in from created_at and an ending from updated_at', () => {
    // Clerk carries no explicit ended-at; the update *is* the ending. Using
    // created_at for all four would date every sign-out to the sign-in before
    // it, which reads as "you were never signed out" on a page whose only job
    // is showing that you were.
    const started = mapClerkEvent('session.created', SESSION);
    const ended = mapClerkEvent('session.ended', SESSION);

    expect(started).toMatchObject({ occurredAt: new Date('2026-07-30T10:53:19.422Z') });
    expect(ended).toMatchObject({ occurredAt: new Date('2026-07-31T10:53:19.422Z') });
  });

  it('maps a session carrying no activity at all', () => {
    // `latest_activity` is optional in Clerk's own type, so a correctly
    // delivered event can carry none of it. The event still matters — that a
    // session started is worth recording even when we cannot say from where.
    const withoutActivity: Record<string, unknown> = { ...SESSION };
    delete withoutActivity['latest_activity'];

    expect(mapClerkEvent('session.created', withoutActivity)).toMatchObject({
      event: 'started',
      activity: {
        ipAddress: null,
        city: null,
        country: null,
        browserName: null,
        browserVersion: null,
        deviceType: null,
        isMobile: null,
      },
    });
  });

  it('maps a session whose activity is partly filled in', () => {
    // Every field inside `latest_activity` is optional again, so a partial
    // object is normal rather than malformed.
    expect(
      mapClerkEvent('session.created', {
        ...SESSION,
        latest_activity: { id: 'a', is_mobile: true, country: 'United Kingdom' },
      }),
    ).toMatchObject({
      activity: {
        ipAddress: null,
        city: null,
        country: 'United Kingdom',
        browserName: null,
        isMobile: true,
      },
    });
  });

  it.each([
    ['no user_id', { id: 'sess_1', created_at: 1, updated_at: 1 }],
    ['no id', { user_id: 'user_1', created_at: 1, updated_at: 1 }],
    ['no timestamps', { id: 'sess_1', user_id: 'user_1' }],
  ])('rejects a session payload with %s', (_case, data) => {
    // Loudly, because a shape change at the provider must not become a silent
    // hole in a security record.
    expect(() => mapClerkEvent('session.created', data)).toThrow(
      ClerkEventMappingError,
    );
  });

  it('names the event type in a session failure', () => {
    expect(() => mapClerkEvent('session.revoked', {})).toThrow(/session\.revoked/);
  });
});
