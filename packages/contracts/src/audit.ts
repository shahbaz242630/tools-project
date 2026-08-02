/**
 * The audit contract between the API and the web app.
 *
 * Two things live here: the header the client's address travels inward on, and
 * the shape of a person's own activity list.
 */

import { z } from 'zod';
import { parseWith } from './parse.js';

/** Where the API serves the caller's own activity. */
export const ME_ACTIVITY_PATH = '/me/activity';

/**
 * The header the web app forwards the client's address on.
 *
 * **The API cannot discover this for itself.** Only the web app is on the edge
 * network; the API is called server-side, so its view of the connection is
 * always the web container. Recording that would put a constant in a security
 * log and call it evidence.
 *
 * A dedicated single-valued header rather than passing `x-forwarded-for`
 * through: that header is a list whose trustworthy element depends on how many
 * proxies are in front, and getting that wrong silently records an
 * attacker-supplied value. One header, one value, set by exactly one caller.
 *
 * What makes trusting it acceptable is the network topology, not the name — the
 * API is unreachable from the internet, so only the web app can set it. That is
 * the same trust the Clerk events endpoint already rests on, and it is written
 * down in ADR 0017 rather than assumed.
 */
export const CLIENT_IP_HEADER = 'x-client-ip';

/**
 * The reason rules and the admin route helpers now live in `admin.ts`.
 *
 * They moved when the administrative surface grew past the single route this
 * file was written around — the whole of what an administrator can reach is
 * worth reading in one sitting. Every one of them is still re-exported from the
 * package root, so no import outside this package changed.
 */

/**
 * One thing that happened, as its own actor may read it back.
 *
 * Deliberately without the before/after digests. They are not useful to the
 * person reading their own activity and are not theirs to reason about;
 * serving them would put them in an HTTP response for no purpose.
 */
/**
 * Who performed the action, from the reader's point of view.
 *
 * `subject` means the account whose trail this is — rendered "You" on a
 * person's own page and "This account" on the administrative one, because the
 * same list is served to both and "you" would be wrong on the second.
 *
 * **Defaulted rather than required**, and the default is the honest one. The
 * services deploy independently, so the web app is briefly talking to the
 * previous API (see `health.ts`); an API without this field served only entries
 * the reader was the actor of, which is precisely `subject`. A required field
 * would turn that skew window into a parse failure on the activity page.
 */
export const activityActorSchema = z
  .enum(['subject', 'administrator', 'system'])
  .default('subject');
export type ActivityActor = z.infer<typeof activityActorSchema>;

export const activityEntrySchema = z.object({
  id: z.uuid(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  by: activityActorSchema,
  /**
   * Why, for actions that owe an explanation.
   *
   * Null for an ordinary user action. Present on administrative ones, where BRD
   * §8.13 requires "actor, reason, target and before/after state" — and visible
   * to the person whose account it was, because being able to read *why*
   * somebody looked at your account is most of the point of recording it.
   */
  reason: z.string().nullable(),
  /**
   * Null when it was not known — see `CLIENT_IP_HEADER` — **and always null
   * when `by` is not `subject`.**
   *
   * On somebody else's action the address is the administrator's, not the
   * reader's. Withholding it is deliberate: a support worker's address handed
   * to the account they were asked to look into is a safety problem, and the
   * reader cannot tell the two cases apart, which is why the page says
   * "not recorded" rather than inventing a distinction.
   */
  ipAddress: z.string().nullable(),
  /**
   * Which of the reader's own sign-ins this happened in — **and null whenever
   * `by` is not `subject`**, for the same reason `ipAddress` is.
   *
   * The join key to `signInEntrySchema.sessionId`, which the sign-in history
   * already serves. Nothing resolves it on the API side and nothing should: the
   * activity trail belongs to Audit and the sign-ins to Identity & Access, and
   * having Audit read back from Identity would close a cycle between two modules
   * (ADR 0025). The page holds both lists and matches them there.
   *
   * **Defaulted rather than required**, the same skew argument as `by`: the
   * services deploy independently, so the web app briefly talks to the previous
   * API. A required field would turn that window into a parse failure on the
   * activity page, and null is exactly what an API that could not record a
   * session means.
   *
   * Null is also the ordinary answer for an action with no session behind it, an
   * entry older than the column, and a sign-in whose webhook never arrived. The
   * page must not distinguish them — to a reader they all mean "we cannot say
   * which sign-in".
   */
  sessionId: z.string().nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const activityResponseSchema = z.object({
  entries: z.array(activityEntrySchema),
});
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

export function parseActivityResponse(raw: unknown): ActivityResponse {
  return parseWith(activityResponseSchema, 'The activity response', raw);
}
