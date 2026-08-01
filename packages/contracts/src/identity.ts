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
 * Whether a string could be one of our account ids.
 *
 * A shape check, not an existence check — it answers "is it worth asking the
 * database", and the answer is load-bearing for anything that writes before it
 * reads. `users.id` and `audit_logs.targetId` are both `uuid` columns, so
 * Postgres *raises* on a malformed value rather than returning no rows; an
 * audit write is fail-closed, so a path parameter passed straight through turns
 * a wrong URL into a 500 on the action it was meant to record.
 *
 * Exported from the contract rather than re-spelled per module because it is
 * the same question in the API, the store and the test doubles, and three
 * regexes that must agree are two too many.
 */
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID.test(value);
}

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

  /**
   * When an administrator suspended this account, or null.
   *
   * Served to the account holder alone — this route only ever answers for the
   * caller — so it discloses nothing about anybody else. A suspended person can
   * still reach this route, deliberately: they have to be able to find out that
   * they are suspended, and UK GDPR rights do not lapse either (ADR 0024).
   *
   * **Nullable with a default**, so an API that predates suspension stays
   * parseable during a deploy skew. `null` is the honest reading of a response
   * from a version that could not suspend anybody.
   */
  suspendedAt: z.iso.datetime().nullable().default(null),

  /**
   * Why, in the administrator's own words.
   *
   * Shown to the person it was written about — the same bargain ADR 0021 struck
   * for administrative reads. It means a suspension reason has to be something
   * you would be willing to say to their face, which is the right constraint.
   */
  suspensionReason: z.string().nullable().default(null),
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

/**
 * Where the API accepts a request to be deleted.
 *
 * A *request* rather than `DELETE /me`, and the name is the honest one: BRD
 * §14 calls it a deletion request, and what happens is not a hard delete. The
 * personal data is erased, the account row survives as a tombstone because the
 * ledger will need a counterparty from Phase 5, and the audit trail is retained
 * for six years under §10.1. Calling it `DELETE` would promise more than the
 * platform can lawfully do. ADR 0018.
 */
export const ME_DELETION_PATH = '/me/deletion-request';

/**
 * What the API answers once the deletion has been applied.
 *
 * `deleted` covers a first request and a repeat alike — the state asked for is
 * the state, and a caller retrying after a dropped connection needs a success
 * rather than a complaint that it is too late.
 */
export const deletionResponseSchema = z.object({
  outcome: z.literal('deleted'),
});
export type DeletionResponse = z.infer<typeof deletionResponseSchema>;

export function parseDeletionResponse(raw: unknown): DeletionResponse {
  return parseWith(deletionResponseSchema, 'The deletion response', raw);
}

export function parseMeResponse(raw: unknown): MeResponse {
  return parseWith(meResponseSchema, 'The identity response', raw);
}
