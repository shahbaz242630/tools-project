/**
 * The identity contract between the API and the web app.
 *
 * Validated at runtime for the reason set out in `health.ts`: the two services
 * deploy independently, so there is always a window where one is talking to the
 * other's previous version. That matters more here than for a health probe — a
 * mis-shaped identity response renders as a signed-in page belonging to nobody,
 * rather than as an obvious error.
 */

import { z } from 'zod';
import { parseWith } from './parse.js';

/** Where the API serves this. Callers should not spell the path themselves. */
export const ME_PATH = '/me';

/**
 * The header the web app forwards a Clerk session token in.
 *
 * Named here so both sides agree. The API verifies the token's signature — it
 * does not trust any header claiming who the caller is.
 */
export const AUTHORIZATION_HEADER = 'authorization';

export const userRoleSchema = z.enum(['USER', 'ADMIN']);
export type UserRole = z.infer<typeof userRoleSchema>;

/**
 * The signed-in account, as the API reports it.
 *
 * `id` is *our* identifier, not Clerk's, and that is the whole point of the
 * mirror: everything the platform owns hangs off this value. `clerkUserId` is
 * deliberately absent — the web app has no use for it, and a field nobody needs
 * is a field that ends up in a URL.
 */
export const meResponseSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: userRoleSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * Where the API accepts identity events forwarded by the web app.
 *
 * `/internal/` is a statement of intent, not a mechanism. What actually keeps
 * this off the internet is the network topology: only `web` joins the `edge`
 * network and CI asserts the API is unreachable from it. The path prefix exists
 * so nobody adds an ingress rule for `/internal/*` without noticing.
 */
export const CLERK_EVENTS_PATH = '/internal/identity/clerk-events';

/**
 * A Clerk webhook the web app has already verified, on its way inward.
 *
 * The split of responsibility is deliberate. Signature verification happens in
 * the web app because that is where the delivery arrives and where a raw,
 * unparsed body still exists — forwarding raw bytes through a second service
 * just to re-verify them adds a place for the payload to be re-encoded and the
 * signature to stop matching, for no gain.
 *
 * The *meaning* of the event stays with the API. `data` is passed through
 * unexamined so that Clerk's payload shape is interpreted in exactly one place,
 * the identity module, rather than being understood in two services that then
 * have to be changed together.
 */
export const clerkEventForwardSchema = z.object({
  /**
   * The provider's delivery identifier — `svix-id`. Stable across retries,
   * which is what makes it usable as an idempotency key on the far side.
   */
  deliveryId: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});
export type ClerkEventForward = z.infer<typeof clerkEventForwardSchema>;

/** What the API answers, so a duplicate delivery is visible in the web's logs. */
export const clerkEventResultSchema = z.object({
  outcome: z.enum(['applied', 'duplicate', 'ignored']),
});
export type ClerkEventResult = z.infer<typeof clerkEventResultSchema>;

export function parseMeResponse(raw: unknown): MeResponse {
  return parseWith(meResponseSchema, 'The identity response', raw);
}
