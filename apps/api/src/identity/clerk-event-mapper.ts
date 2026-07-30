import { z } from 'zod';
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

  return null;
}
