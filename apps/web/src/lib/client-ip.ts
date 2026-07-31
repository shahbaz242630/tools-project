/**
 * Working out which address actually belongs to the person making the request.
 *
 * The web app is the only service on the edge network, so it is the only place
 * this can be answered at all — the API is called server-side and its view of
 * the connection is always this container. Whatever is decided here is what the
 * audit log will record as fact, which is why the reasoning is written down
 * rather than assumed.
 */

/**
 * The **last** entry of `X-Forwarded-For`, not the first.
 *
 * This is the part people get wrong. The header is a list that each proxy
 * appends to, and a client is free to send one to begin with — so the *first*
 * entry is whatever the caller chose to claim, and trusting it means logging an
 * attacker-supplied address as evidence. The last entry is the one our own
 * ingress appended, which is the peer it genuinely observed.
 *
 * **That holds for exactly one trusted proxy in front, which is what we
 * deploy** (browser → Caddy → web). Putting a CDN in front of Caddy would add a
 * hop and make the last entry the CDN's, at which point this function has to
 * change with it. ADR 0017 records that, because nothing here will fail
 * loudly — it will simply start recording the wrong address.
 *
 * Returns null rather than guessing when there is no header, which is the
 * normal case in local development where no proxy exists.
 */
export function clientIpFrom(forwardedFor: string | null | undefined): string | null {
  if (typeof forwardedFor !== 'string') return null;

  const hops = forwardedFor
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '');

  const nearest = hops.at(-1);
  if (nearest === undefined) return null;

  // Strip a port if one is present — `192.0.2.1:54321` is legal in this header
  // and is not an address the API's `inet` column will accept. IPv6 arrives
  // bracketed when it carries a port, which is what makes the two separable.
  return stripPort(nearest);
}

function stripPort(value: string): string | null {
  // `[2001:db8::1]:443` → `2001:db8::1`
  const bracketed = /^\[(?<address>.+)\](?::\d+)?$/.exec(value);
  if (bracketed?.groups?.['address'] !== undefined) return bracketed.groups['address'];

  // A bare IPv6 address contains colons and has no port; only split when there
  // is exactly one colon, which makes it unambiguously IPv4 with a port.
  const colons = value.split(':');
  const candidate = colons.length === 2 ? colons[0] : value;

  return candidate === undefined || candidate === '' ? null : candidate;
}
