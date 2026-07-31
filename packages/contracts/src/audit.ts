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
 * One thing that happened, as its own actor may read it back.
 *
 * Deliberately without the before/after digests. They are not useful to the
 * person reading their own activity and are not theirs to reason about;
 * serving them would put them in an HTTP response for no purpose.
 */
export const activityEntrySchema = z.object({
  id: z.uuid(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  /** Null when it was not known — see `CLIENT_IP_HEADER`. */
  ipAddress: z.string().nullable(),
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
