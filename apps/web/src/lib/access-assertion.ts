/**
 * Forward Cloudflare Access's assertion inward, on authenticated calls only.
 *
 * Cloudflare sets `Cf-Access-Jwt-Assertion` on every request its policy admits.
 * It arrives here because only `web` is on the edge network; the API never sees
 * a browser. The API verifies it against Cloudflare's rotating public keys and
 * uses it as one of the things that can prove an administrator's second factor
 * (ADR 0053). **This file forwards it and asserts nothing about it** — its
 * presence proves nothing until the signature, issuer and audience have been
 * checked, and all three of those happen at the API.
 *
 * **Why a shared helper rather than the `x-client-ip` pattern.** ADR 0017's
 * address forwarding threads a parameter down through ~40 call sites, because
 * `clientIpFrom` needs environment configuration and per-request parsing of
 * `x-forwarded-for` — it cannot be computed where it is used. This value needs
 * neither: it is one header copied verbatim. Following the older pattern to the
 * letter would have cost ~53 edits and given a new call site forty chances to
 * omit it silently, which is the failure mode that pattern already has.
 *
 * **Why not folded into `correlationHeaders()`, which is spread everywhere.**
 * That would have been one edit and it is the wrong one. `correlationHeaders`
 * is also spread into the public listing read, the public profile, the
 * readiness probe and the Clerk webhook — and this assertion carries an
 * administrator's email address. Putting it on a signed-out stranger's search
 * would send a person's identity on calls that have no use for it, which is the
 * same data-minimisation rule that already keeps `x-client-ip` off those exact
 * four call sites. Authenticated calls only, deliberately.
 *
 * **A missing assertion is absent, never empty.** Same rule as the address and
 * the correlation id: an empty header in a request log invites the reader to
 * think it was looked for and found to be nothing.
 */

import { ACCESS_ASSERTION_HEADER } from '@platform/contracts';
import { headers } from 'next/headers';

export async function accessAssertionHeaders(): Promise<Record<string, string>> {
  let inbound: Awaited<ReturnType<typeof headers>>;
  try {
    inbound = await headers();
  } catch {
    // No request store: a unit test, or a module loaded outside a render. The
    // absence of an assertion is the correct answer, not a swallowed error —
    // `correlationHeaders` takes the same view for the same reason.
    return {};
  }

  const assertion = inbound.get(ACCESS_ASSERTION_HEADER);
  if (assertion === null || assertion === '') return {};

  return { [ACCESS_ASSERTION_HEADER]: assertion };
}
