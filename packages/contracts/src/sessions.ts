/**
 * The authentication-events contract between the API and the web app.
 *
 * BRD §8.1's "authentication events" — the sign-ins a person reads to answer
 * "has anybody else been in my account".
 *
 * **A separate path from `/me/activity`, and that is an architecture decision
 * rather than a routing one.** The activity trail is served by the audit
 * module; these rows belong to Identity & Access, which already depends on
 * audit in order to record. Having audit read back from identity would close a
 * cycle between two modules, so each serves what it owns and the page renders
 * one merged timeline from both. ADR 0025.
 */

import { z } from 'zod';
import { parseWith } from './parse.js';

/** Where the API serves the caller's own sign-in history. */
export const ME_SIGN_INS_PATH = '/me/sign-ins';

/**
 * What happened to a session.
 *
 * A closed set on the wire, so an unrecognised value is a parse failure rather
 * than a blank line in a security list. Defaulted deliberately absent: unlike
 * the activity trail's `by`, there is no sensible fallback here — an event we
 * cannot name is one we must not render.
 */
export const sessionEventSchema = z.enum(['started', 'ended', 'removed', 'revoked']);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/**
 * One sign-in or sign-out, as its own account holder reads it.
 *
 * Everything but the event and its timestamp is nullable, because Clerk's
 * `latest_activity` is optional and each field within it is optional again. A
 * row with nothing but a time is a real outcome, not a broken one.
 *
 * **The address is included here and withheld from `DisclosedEntry`**, and the
 * difference is who it belongs to. On an audit disclosure the address is the
 * *administrator's*, and handing that to the account they investigated is a
 * safety problem. Here it is the reader's own, and it is the single most useful
 * field on the page — "was that me?" is answered by the place and the device.
 */
export const signInEntrySchema = z.object({
  id: z.uuid(),
  event: sessionEventSchema,

  /**
   * Clerk's `sess_…`.
   *
   * Served so the page can group events by session, and so somebody can match a
   * line here against a device in Clerk's own list. It is a provider reference,
   * not a credential — holding it grants nothing.
   */
  sessionId: z.string(),

  occurredAt: z.iso.datetime(),
  ipAddress: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  browserName: z.string().nullable(),
  browserVersion: z.string().nullable(),
  deviceType: z.string().nullable(),
  isMobile: z.boolean().nullable(),
});
export type SignInEntry = z.infer<typeof signInEntrySchema>;

export const signInsResponseSchema = z.object({
  entries: z.array(signInEntrySchema),
});
export type SignInsResponse = z.infer<typeof signInsResponseSchema>;

export function parseSignInsResponse(raw: unknown): SignInsResponse {
  return parseWith(signInsResponseSchema, 'The sign-in history', raw);
}

/**
 * A device and place, as one line of prose.
 *
 * Here rather than in the page because the rules are fiddly and worth testing
 * on their own: any part may be missing, and the honest answer when everything
 * is missing is to say so rather than render an empty string that reads like a
 * loading state.
 */
export function describeSignInOrigin(entry: SignInEntry): string {
  const device = [entry.browserName, entry.deviceType].filter(Boolean).join(' on ');
  const place = [entry.city, entry.country].filter(Boolean).join(', ');

  const parts = [device, place].filter((part) => part !== '');
  if (parts.length === 0) return 'Device and location not recorded';

  return parts.join(' — ');
}
