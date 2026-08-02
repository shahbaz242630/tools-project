import { Time } from '@platform/core';
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
 * The session activity Clerk attaches, when it attaches any.
 *
 * **Every field is optional, and `latest_activity` itself is optional.** That
 * is Clerk's own shape (`SessionActivityJSON` in `@clerk/backend`), not caution
 * on our part: a correctly delivered event can carry none of it. `.nullish()`
 * rather than `.optional()` because a provider that has no value for a field
 * may send it as null rather than omit it, and both mean the same thing here.
 */
const sessionActivitySchema = z.object({
  ip_address: z.string().nullish(),
  city: z.string().nullish(),
  country: z.string().nullish(),
  browser_name: z.string().nullish(),
  browser_version: z.string().nullish(),
  device_type: z.string().nullish(),
  is_mobile: z.boolean().nullish(),
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
  latest_activity: sessionActivitySchema.nullish(),
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

    const activity = parsed.data.latest_activity;

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

      // Absent activity is normal and becomes nulls rather than an error. The
      // event still matters — that a session started is worth recording even
      // when we cannot say from where.
      activity: {
        ipAddress: activity?.ip_address ?? null,
        city: activity?.city ?? null,
        country: activity?.country ?? null,
        browserName: activity?.browser_name ?? null,
        browserVersion: activity?.browser_version ?? null,
        deviceType: activity?.device_type ?? null,
        isMobile: activity?.is_mobile ?? null,
      },
    };
  }

  return null;
}
