import { Time } from '@platform/core';
import { parseUserAgent } from './user-agent.js';
import { z } from 'zod';
import type { AuthenticationEventType } from './authentication-events.js';
import type { IdentityEvent } from './identity.service.js';

/**
 * Translating Clerk's webhook payloads into our own vocabulary.
 *
 * The single place in the codebase that understands Clerk's event shape. Every
 * layer above this one speaks `IdentityEvent`, so replacing the provider is a
 * new mapper rather than a search for every place that knew what
 * `primary_email_address_id` meant.
 */

/**
 * Clerk sends every address the account holds and names the primary separately,
 * so picking `[0]` is wrong roughly as often as a person has a second address.
 */
const userPayloadSchema = z.object({
  id: z.string().min(1),
  primary_email_address_id: z.string().min(1).nullish(),
  email_addresses: z
    .array(z.object({ id: z.string(), email_address: z.string() }))
    .default([]),
});

const deletedPayloadSchema = z.object({ id: z.string().min(1) });

/**
 * Clerk's four `session.*` events, in our vocabulary.
 *
 * `created` becomes `started` rather than being kept verbatim, because the
 * provider's word for it is the provider's business — the same reason
 * `user.created` and `user.updated` both become `user.upserted`.
 */
const SESSION_EVENTS: Readonly<Record<string, AuthenticationEventType>> = {
  'session.created': 'started',
  'session.ended': 'ended',
  'session.removed': 'removed',
  'session.revoked': 'revoked',
};

/**
 * Where a webhook says the request came from.
 *
 * **`event_attributes` is a sibling of `data` in Clerk's envelope**, not a field
 * inside it, and it is the only place a webhook carries the request context.
 *
 * This is where slice 1.11a was wrong. The Backend API's `Session` object has a
 * `latest_activity` holding a parsed browser, device, city and country, and the
 * mapper was written against that — verified with `clerk api /sessions`, which
 * proved only what it exercised. A real delivery carries no `latest_activity`
 * at all; it carries this, with a raw user agent and an IP. Confirmed against
 * live `session.created` and `session.removed` deliveries on 2 August 2026.
 *
 * **City and country are simply not available to us.** They exist only on the
 * Backend API's view, which needs `CLERK_SECRET_KEY` — the key ADR 0015 keeps
 * out of the API on purpose. So the sign-in history says where from by address
 * and device, not by city.
 */
const eventAttributesSchema = z.object({
  http_request: z
    .object({
      client_ip: z.string().nullish(),
      user_agent: z.string().nullish(),
    })
    .nullish(),
});

/**
 * Clerk's session payload.
 *
 * Timestamps are Unix **milliseconds**, which is why `Time.fromEpochMs` exists
 * — the numbers are indistinguishable from seconds by inspection and getting it
 * wrong lands the row in 1970 rather than failing.
 */
const sessionPayloadSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  created_at: z.number(),
  updated_at: z.number(),
});

/** Raised when a payload we should understand does not parse. */
export class ClerkEventMappingError extends Error {
  constructor(type: string, issues: readonly string[]) {
    super(
      `clerk ${type} payload did not match the expected shape: ${issues.join('; ')}`,
    );
    this.name = 'ClerkEventMappingError';
  }
}

function primaryEmail(payload: z.infer<typeof userPayloadSchema>): string | null {
  const { email_addresses: addresses, primary_email_address_id: primaryId } = payload;

  const primary =
    primaryId == null
      ? undefined
      : addresses.find((address) => address.id === primaryId);

  // Falling back to the only address when no primary is named is safe; guessing
  // among several is not, and an account mid-change legitimately has more than
  // one. Returning null makes the caller decide rather than picking silently.
  const chosen = primary ?? (addresses.length === 1 ? addresses[0] : undefined);

  return chosen?.email_address ?? null;
}

/**
 * Map a verified Clerk event.
 *
 * Returns `null` for event types we do not act on. Clerk delivers whatever the
 * endpoint is subscribed to and subscriptions get widened from a dashboard, so
 * an unknown type must be an ordinary no-op — treating it as an error would
 * turn a settings change into a stream of failed deliveries and retries.
 */
export function mapClerkEvent(
  type: string,
  data: Record<string, unknown>,
  /**
   * Clerk's `event_attributes`, from beside `data` rather than inside it.
   *
   * **Required in position, nullable in value, and that is deliberate.** It was
   * optional for about ten minutes and the controller silently did not pass it
   * — every test passed, the build was clean, and the sign-in history recorded
   * nothing but timestamps. That is the exact failure this parameter exists to
   * fix, reintroduced by the parameter itself. Required means forgetting is a
   * compile error; `undefined` is still a legitimate value, because every
   * `user.*` delivery genuinely has no attributes.
   *
   * A session event that arrives without it still maps — the sign-in is worth
   * recording even when we cannot say where from — so this is never a reason to
   * reject a delivery.
   */
  eventAttributes: Record<string, unknown> | undefined,
): IdentityEvent | null {
  if (type === 'user.created' || type === 'user.updated') {
    const parsed = userPayloadSchema.safeParse(data);
    if (!parsed.success) {
      throw new ClerkEventMappingError(
        type,
        parsed.error.issues.map((issue) => issue.message),
      );
    }

    const email = primaryEmail(parsed.data);
    if (email === null) {
      throw new ClerkEventMappingError(type, ['no primary email address']);
    }

    return { type: 'user.upserted', clerkUserId: parsed.data.id, email };
  }

  if (type === 'user.deleted') {
    const parsed = deletedPayloadSchema.safeParse(data);
    if (!parsed.success) {
      throw new ClerkEventMappingError(
        type,
        parsed.error.issues.map((issue) => issue.message),
      );
    }

    return { type: 'user.deleted', clerkUserId: parsed.data.id };
  }

  const sessionEvent = SESSION_EVENTS[type];
  if (sessionEvent !== undefined) {
    const parsed = sessionPayloadSchema.safeParse(data);
    if (!parsed.success) {
      throw new ClerkEventMappingError(
        type,
        parsed.error.issues.map((issue) => issue.message),
      );
    }

    // Parsed leniently and never fatally: a shape change here costs us the
    // device, not the event. The sign-in itself is the part that must not be
    // lost, because "somebody signed in and we cannot say from where" is still
    // the answer to the question this record exists for.
    const attributes = eventAttributesSchema.safeParse(eventAttributes ?? {});
    const request = attributes.success ? attributes.data.http_request : null;
    const agent = parseUserAgent(request?.user_agent);

    return {
      type: 'session.recorded',
      clerkUserId: parsed.data.user_id,
      clerkSessionId: parsed.data.id,
      event: sessionEvent,

      // `created_at` for a session that just started; `updated_at` for one that
      // stopped, because Clerk carries no explicit ended-at and the update *is*
      // the ending. Using `created_at` for all four would date every sign-out
      // to the sign-in that preceded it, which reads as "you were never signed
      // out" on a page whose whole job is showing that you were.
      occurredAt: Time.fromEpochMs(
        sessionEvent === 'started' ? parsed.data.created_at : parsed.data.updated_at,
      ),

      // Absent attributes are normal and become nulls rather than an error.
      activity: {
        ipAddress: request?.client_ip ?? null,
        browserName: agent.browserName,
        browserVersion: agent.browserVersion,
        deviceType: agent.deviceType,
        isMobile: agent.isMobile,
      },
    };
  }

  return null;
}
