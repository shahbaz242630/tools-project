/**
 * The administrative surface's contract.
 *
 * Separate from `identity.ts` and `audit.ts` because the authority is
 * different, not because the data is. Everything here is reachable only by an
 * account holding the `ADMIN` role with a second factor verified recently
 * (ADR 0021), and every route it describes writes an audit entry naming the
 * administrator, the account they reached into, and **why**.
 *
 * Keeping it in one file means the whole of what an administrator can see is
 * readable in one sitting — which is the only practical way to notice that a
 * field has been added to it.
 */

import { z } from 'zod';
import { parseWith } from './parse.js';
import { userRoleSchema } from './identity.js';

/**
 * The shortest reason an administrator may give.
 *
 * A bound rather than a judgement of quality — nothing can stop somebody typing
 * "x" twelve times. What it does stop is an empty box being submitted by habit,
 * which is how a mandatory field becomes a meaningless one.
 */
export const MIN_ADMIN_REASON_LENGTH = 12;
export const MAX_ADMIN_REASON_LENGTH = 500;

export const adminReasonSchema = z
  .string()
  .trim()
  .min(
    MIN_ADMIN_REASON_LENGTH,
    `must be at least ${MIN_ADMIN_REASON_LENGTH} characters`,
  )
  .max(MAX_ADMIN_REASON_LENGTH);

export function parseAdminReason(raw: unknown): string {
  return parseWith(adminReasonSchema, 'The reason', raw);
}

/**
 * Where an administrator reads somebody else's activity.
 *
 * A function, so the id is encoded once and the *administrative* path is
 * visibly distinct from `/me/activity` at every call site.
 */
export function adminActivityPath(userId: string, reason: string): string {
  return `/admin/users/${encodeURIComponent(userId)}/activity?reason=${encodeURIComponent(reason)}`;
}

/** The Nest route pattern for the above. Kept beside it so the two cannot drift. */
export const ADMIN_ACTIVITY_ROUTE = '/admin/users/:userId/activity';

/** Where an administrator reads somebody's account state. */
export function adminUserPath(userId: string, reason: string): string {
  return `/admin/users/${encodeURIComponent(userId)}?reason=${encodeURIComponent(reason)}`;
}

export const ADMIN_USER_ROUTE = '/admin/users/:userId';

/**
 * The account itself, as support may see it.
 *
 * Identity facts only. The email is here because it *is* the account — support
 * is almost always answering a message from that address — and because it is
 * the one contact detail a person has already proved they hold.
 *
 * **A deleted account is visible, with its timestamps.** That is a deliberate
 * difference from the public profile route, which collapses "deleted", "never
 * existed" and "no profile" into a single null so the endpoint cannot be used
 * to enumerate accounts. Enumeration is not the threat here — the caller is an
 * administrator, named in an audit entry — and "when was this deleted, and did
 * anyone ask" is precisely the question support is asked after a deletion.
 */
export const adminAccountSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: userRoleSchema,
  createdAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  deletionRequestedAt: z.iso.datetime().nullable(),
});
export type AdminAccount = z.infer<typeof adminAccountSchema>;

/**
 * The profile, as support may see it. **A third projection, and the narrowest
 * of the three that carries a name.**
 *
 * `myProfileSchema` gives the owner everything. `publicProfileSchema` gives a
 * stranger a name and a district. This gives support what it needs to answer a
 * support question and **nothing more**:
 *
 *   - **No street lines.** They are encrypted at rest (ADR 0016) and the data
 *     export is the one path by which a decrypted one leaves the database
 *     (ADR 0019). Support does not need to read somebody's street back to them
 *     — the person asking already knows their own address, and if they want a
 *     copy they can export one. Keeping them out means that claim stays true.
 *   - **No phone number**, for the same reason and one more: nothing has
 *     verified it, so it is not a fact about the person, and Phase 1 has no
 *     handover for support to arrange.
 *
 * What is left answers every question the launch product can raise: is there a
 * profile, is it complete enough to list or book (BRD §8.1 gates that on
 * contact details), and does the address resolve to somewhere sensible.
 */
export const adminProfileSchema = z
  .object({
    displayName: z.string(),

    /**
     * Whether a number is saved, not what it is.
     *
     * The support question is "have they given us one" — it is what §8.1 gates
     * listing and booking on. The digits answer nothing that the boolean does
     * not, and they are somebody's phone number.
     */
    hasPhone: z.boolean(),

    /**
     * The district, or null when no address is saved at all.
     *
     * A nullable object rather than two nullable fields, so "no address" is
     * distinguishable from "an address whose town we somehow lost" — the
     * distinction support actually needs, and one the public projection has no
     * use for and therefore does not draw.
     */
    address: z
      .object({
        town: z.string(),
        /** `BS7`, never `BS7 8AA`. Same rule as the public profile (ADR 0016). */
        outwardCode: z.string(),
      })
      .nullable(),

    updatedAt: z.iso.datetime(),
  })
  .nullable();
export type AdminProfile = z.infer<typeof adminProfileSchema>;

/**
 * Everything the administrative account view discloses.
 *
 * BRD §8.13 asks for a read-only "view as user" from Phase 1 and prohibits
 * write-capable impersonation at launch. This is that capability as a
 * **projection**: the administrator's own session stays their own, no token is
 * ever minted as another person, and there is no request shape here that could
 * change anything (ADR 0022).
 */
export const adminUserViewSchema = z.object({
  account: adminAccountSchema,
  profile: adminProfileSchema,
});
export type AdminUserView = z.infer<typeof adminUserViewSchema>;

export function parseAdminUserView(raw: unknown): AdminUserView {
  return parseWith(adminUserViewSchema, 'The account view', raw);
}
