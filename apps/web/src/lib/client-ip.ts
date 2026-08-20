/**
 * Working out which address actually belongs to the person making the request.
 *
 * The web app is the only service on the edge network, so it is the only place
 * this can be answered at all — the API is called server-side and its view of
 * the connection is always this container. Whatever is decided here is what the
 * audit log will record as fact, which is why the reasoning is written down
 * rather than assumed.
 */

import { loadProxyEnv } from '@platform/config';

/**
 * How many proxies we control sit in front of this app.
 *
 * **Zero by default, and zero means "trust nothing".** A default of one would be
 * the old behaviour preserved as a setting — and the direction a mistake should
 * fail in is towards recording no address, never towards recording one a
 * stranger chose.
 */
let cachedHops: number | undefined;

function trustedHops(): number {
  // Read once. The topology cannot change while the process runs, and this is on
  // the path of every audited request — the API reads its own `.env` only at
  // boot for the same reason.
  cachedHops ??= loadProxyEnv().TRUSTED_PROXY_HOPS;
  return cachedHops;
}

/**
 * The entry a proxy we control appended, counted back from the end.
 *
 * This is the part people get wrong. The header is a list that each proxy
 * appends to, and a client is free to send one to begin with — so the *first*
 * entry is whatever the caller chose to claim, and trusting it means logging an
 * attacker-supplied address as evidence.
 *
 * ## The trust is configuration now, and it fails closed
 *
 * **This function used to take the last entry unconditionally**, on the stated
 * assumption of *"exactly one trusted proxy in front, which is what we deploy"*.
 * That assumption has never been true: `infra/compose`'s Caddy ingress **has
 * never run** — it is deliberately down until a domain exists, because bringing
 * it up would put plain HTTP on a dialable public IP (§10.2).
 *
 * With no proxy appending anything, *every* entry is one the caller typed,
 * including the last. So this returned an **attacker-controlled** address, and
 * it is written to `audit_logs.ipAddress` as *evidence* — forged provenance in
 * a record §10 keeps for six years. Not exploitable yet, only because nothing is
 * publicly reachable; the fix belongs before that changes rather than after.
 *
 * Next 16 offers no alternative: `NextRequest.ip` was removed and the shipped
 * docs under `node_modules/next/dist/docs/` mention no peer address at all. **An
 * address cannot be known without something trustworthy in front**, so the
 * honest answer when nothing is in front is *"we do not know"*.
 *
 * ## Why a count rather than a boolean
 *
 * Each proxy appends the peer **it** observed, so where the real client sits
 * depends on how many trusted hops there are — and that moves as the deployment
 * changes:
 *
 * | In front | `X-Forwarded-For` | Real client |
 * | --- | --- | --- |
 * | nothing | `spoofed` | unknowable |
 * | Caddy | `spoofed, realIP` | last |
 * | Cloudflare → Caddy | `spoofed, realIP, cloudflareIP` | second from last |
 *
 * ADR 0017 already warned that adding a CDN *"adds a hop and makes the last
 * entry the CDN's — and nothing will fail loudly when that happens, it will
 * simply start recording the wrong address."* A count makes that a value
 * somebody sets when they change the topology, rather than a code change nobody
 * remembers. **The Cloudflare Tunnel §10.2 requires is exactly the second row
 * becoming the third.**
 */
export function clientIpFrom(
  forwardedFor: string | null | undefined,
  hopsInFront: number = trustedHops(),
): string | null {
  if (typeof forwardedFor !== 'string') return null;

  const hops = forwardedFor
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '');

  /*
   * Each trusted proxy appended one entry, so the real client is that many from
   * the end. **The fail-closed case falls out of the arithmetic rather than
   * needing a branch of its own**: with no trusted hops the index lands past the
   * end of the list, so there is nothing to return — which is the right answer,
   * not an edge case.
   *
   * The guard is `>= 0` *and* `< length` deliberately. `hops.at(-1)` wraps to the
   * end when a proxy we expected did not append — somebody reaching the app past
   * the ingress — and would hand back a caller-supplied entry as though a proxy
   * had vouched for it. Same class of bug as trusting the first entry, arriving
   * through the back door.
   */
  const index = hops.length - hopsInFront;
  if (index < 0 || index >= hops.length) return null;

  const nearest = hops[index];
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
