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

  it.each([['session.created'], ['organization.created'], ['email.created']])(
    'ignores %s rather than failing',
    (type) => {
      // Clerk delivers whatever the endpoint is subscribed to, and subscriptions
      // are widened from a dashboard. Treating an unknown type as an error turns
      // a settings change into an endless retry loop.
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
