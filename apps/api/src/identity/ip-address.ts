import { isIP } from 'node:net';

/**
 * The one place an IP address is validated before it reaches an `inet` column.
 *
 * **Shared rather than duplicated, deliberately.** Two callers need this — the
 * guard, reading the address the web app forwarded, and the authentication
 * event store, reading the address Clerk observed — and slice 1.7's lesson was
 * that two copies of a rule drift on exactly the rule that was missing from
 * both. Here that rule is subtle enough to be worth stating once:
 *
 * - **Fastify joins a repeated header into one comma-separated string**, so
 *   `x-client-ip` sent twice arrives as `"a,b"` — a string, not an array, and
 *   therefore past any `typeof` check. `isIP` rejects it, which is the point:
 *   two values means something sits between us and the sender, and picking one
 *   would record a guess as fact.
 * - **`inet` throws on a malformed value.** On the guard's path the audit write
 *   is fail-closed, so that throw would 500 the request it was auditing; on the
 *   webhook path it would become a delivery the provider retries forever. Both
 *   turn a bad string into an outage.
 * - **IPv4 and IPv6 both pass.** Real values are frequently IPv6, so a check
 *   written for dotted quads would discard most genuine addresses.
 *
 * Null is the honest answer to "we cannot tell", and it keeps a bad value from
 * becoming an incident.
 */
export function validIpOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return isIP(trimmed) === 0 ? null : trimmed;
}
