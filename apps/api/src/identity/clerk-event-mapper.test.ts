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
      mapClerkEvent(
        type,
        {
          id: 'user_1',
          primary_email_address_id: ADDRESS.id,
          email_addresses: [ADDRESS],
        },
        undefined,
      ),
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
    const event = mapClerkEvent(
      'user.updated',
      {
        id: 'user_1',
        primary_email_address_id: ADDRESS.id,
        email_addresses: [OTHER, ADDRESS],
      },
      undefined,
    );

    expect(event).toMatchObject({ email: 'alice@example.com' });
  });

  it('falls back to the sole address when no primary is named', () => {
    expect(
      mapClerkEvent(
        'user.created',
        { id: 'user_1', email_addresses: [ADDRESS] },
        undefined,
      ),
    ).toMatchObject({ email: ADDRESS.email_address });
  });

  it('refuses to guess between several addresses with no primary named', () => {
    // An account mid-change legitimately has more than one. Picking arbitrarily
    // would mirror the wrong address and, from Phase 6, send notifications to it.
    expect(() =>
      mapClerkEvent(
        'user.updated',
        { id: 'user_1', email_addresses: [ADDRESS, OTHER] },
        undefined,
      ),
    ).toThrow(ClerkEventMappingError);
  });

  it('rejects a user event carrying no address at all', () => {
    expect(() =>
      mapClerkEvent('user.created', { id: 'user_1', email_addresses: [] }, undefined),
    ).toThrow(ClerkEventMappingError);
  });

  it('maps user.deleted', () => {
    expect(
      mapClerkEvent('user.deleted', { id: 'user_1', deleted: true }, undefined),
    ).toEqual({
      type: 'user.deleted',
      clerkUserId: 'user_1',
    });
  });

  it.each([
    ['organization.created'],
    ['email.created'],
    ['sms.created'],
    // A real Clerk event, in its catalogue but absent from the SDK's
    // `SessionWebhookEvent` union. We deliberately do not subscribe to it, and
    // this pins that a delivery arriving anyway is an ordinary no-op rather
    // than a mapping failure — Clerk's pending-session state is for
    // post-sign-in tasks this domain does not have (ADR 0025).
    ['session.pending'],
  ])('ignores %s rather than failing', (type) => {
    // Clerk delivers whatever the endpoint is subscribed to, and subscriptions
    // are widened from a dashboard. Treating an unknown type as an error turns
    // a settings change into an endless retry loop.
    //
    // `session.created` was in this list until slice 1.11a and is now mapped,
    // so the claim was rewritten rather than the assertion — the surviving
    // rule is about types we genuinely do not act on, not about this one.
    expect(mapClerkEvent(type, { id: 'x' }, undefined)).toBeNull();
  });

  it.each([
    ['no id', { email_addresses: [ADDRESS], primary_email_address_id: ADDRESS.id }],
    ['an empty id', { id: '', email_addresses: [ADDRESS] }],
  ])('rejects a user payload with %s', (_case, data) => {
    expect(() => mapClerkEvent('user.created', data, undefined)).toThrow(
      ClerkEventMappingError,
    );
  });

  it('rejects a delete payload with no id', () => {
    expect(() => mapClerkEvent('user.deleted', { deleted: true }, undefined)).toThrow(
      ClerkEventMappingError,
    );
  });

  it('names the event type in the failure', () => {
    // A mapping failure means Clerk changed shape. Whoever reads that log line
    // needs to know which event to go and look at.
    expect(() => mapClerkEvent('user.deleted', {}, undefined)).toThrow(/user\.deleted/);
  });
});

describe('mapClerkEvent — session events', () => {
  /**
   * A real `session.created` delivery, captured from the development instance
   * on 2 August 2026 and reduced to the fields the mapper reads.
   *
   * **Captured from a webhook, not from the Backend API**, and that distinction
   * is the whole reason this fixture was rewritten. The first version of these
   * tests used `clerk api /sessions`, whose session object carries a
   * `latest_activity` with a parsed browser, device, city and country. A real
   * delivery has no such field. It carries `event_attributes` — a **sibling of
   * `data`** — holding a client IP and a raw user agent, and nothing else.
   */
  const SESSION = {
    object: 'session',
    id: 'sess_3HLxjF0HYDfQZIos9CtuJASfCKa',
    user_id: 'user_3HDhyHhToMvFEvYk1PFXtiYzAEm',
    client_id: 'client_3HDX1r4Lp4T9DB1XDj0G5TSdKdJ',
    status: 'active',
    created_at: 1785661283293,
    updated_at: 1785661283331,
    last_active_at: 1785661283293,
    expire_at: 1786266083293,
    abandon_at: 1788253283293,
  };

  const ATTRIBUTES = {
    http_request: {
      client_ip: '2.49.99.113',
      user_agent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
    },
  };

  it('maps session.created to a started event, with the address and device', () => {
    expect(mapClerkEvent('session.created', SESSION, ATTRIBUTES)).toEqual({
      type: 'session.recorded',
      clerkUserId: 'user_3HDhyHhToMvFEvYk1PFXtiYzAEm',
      clerkSessionId: 'sess_3HLxjF0HYDfQZIos9CtuJASfCKa',
      event: 'started',
      occurredAt: new Date('2026-08-02T09:01:23.293Z'),
      activity: {
        ipAddress: '2.49.99.113',
        browserName: 'Edge',
        browserVersion: '150',
        deviceType: 'Windows',
        isMobile: false,
      },
    });
  });

  it('takes the address from event_attributes, not from data', () => {
    // The bug this test exists for: `data` alone was forwarded, so every
    // recorded sign-in had a timestamp and nothing else. Everything answered
    // 200 and the security record was simply empty.
    expect(mapClerkEvent('session.created', SESSION, undefined)).toMatchObject({
      event: 'started',
      activity: { ipAddress: null, browserName: null, deviceType: null },
    });
  });

  it.each([
    ['session.ended', 'ended'],
    ['session.removed', 'removed'],
    ['session.revoked', 'revoked'],
  ])('maps %s to %s', (type, event) => {
    expect(mapClerkEvent(type, SESSION, ATTRIBUTES)).toMatchObject({
      type: 'session.recorded',
      event,
    });
  });

  it('dates a sign-in from created_at and an ending from updated_at', () => {
    // Clerk carries no explicit ended-at; the update *is* the ending. Using
    // created_at for all four would date every sign-out to the sign-in before
    // it, which reads as "you were never signed out" on a page whose only job
    // is showing that you were.
    expect(mapClerkEvent('session.created', SESSION, ATTRIBUTES)).toMatchObject({
      occurredAt: new Date('2026-08-02T09:01:23.293Z'),
    });
    expect(mapClerkEvent('session.ended', SESSION, ATTRIBUTES)).toMatchObject({
      occurredAt: new Date('2026-08-02T09:01:23.331Z'),
    });
  });

  it('records the event even when the user agent is unrecognisable', () => {
    // A sign-in we cannot describe is still a sign-in, and it is the line
    // somebody scanning for an intrusion most needs to see.
    expect(
      mapClerkEvent('session.created', SESSION, {
        http_request: { client_ip: '203.0.113.7', user_agent: 'curl/8.4.0' },
      }),
    ).toMatchObject({
      event: 'started',
      activity: {
        ipAddress: '203.0.113.7',
        browserName: null,
        deviceType: null,
        isMobile: null,
      },
    });
  });

  it('survives event_attributes of an unexpected shape', () => {
    // Parsed leniently on purpose: a change here should cost us the device, not
    // the event. Anything else makes a provider tweak a stream of failed
    // deliveries for a record that was perfectly storable.
    expect(
      mapClerkEvent('session.created', SESSION, { http_request: 'not an object' }),
    ).toMatchObject({
      event: 'started',
      activity: { ipAddress: null },
    });
  });

  it.each([
    ['no user_id', { id: 'sess_1', created_at: 1, updated_at: 1 }],
    ['no id', { user_id: 'user_1', created_at: 1, updated_at: 1 }],
    ['no timestamps', { id: 'sess_1', user_id: 'user_1' }],
  ])('rejects a session payload with %s', (_case, data) => {
    // Loudly, because a shape change in `data` must not become a silent hole in
    // a security record — unlike `event_attributes`, where it costs a detail.
    expect(() => mapClerkEvent('session.created', data, ATTRIBUTES)).toThrow(
      ClerkEventMappingError,
    );
  });

  it('names the event type in a session failure', () => {
    expect(() => mapClerkEvent('session.revoked', {}, undefined)).toThrow(
      /session\.revoked/,
    );
  });
});
