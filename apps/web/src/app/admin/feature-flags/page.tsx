import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { AdminFeatureFlag } from '@platform/contracts';
import { FeatureFlagSwitch } from '../../../components/feature-flag-switch';
import { AdminNav } from '../../../components/admin-nav';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchFeatureFlags } from '../../../lib/admin-feature-flags';
import type { AdminFeatureFlagOutcome } from '../../../lib/admin-feature-flags';
import { webEnv } from '../../../lib/env';

/**
 * Never prerendered, and never cached.
 *
 * More important here than on any other admin page: a cached kill switch is one
 * that appears not to have worked, and the response to that during an incident
 * is to throw it again.
 */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Feature flags',
  robots: { index: false, follow: false },
};

/**
 * Feature flags and the emergency kill switches BRD §9 asks for.
 *
 * **The page does not check the role**, the same as every other admin page. The
 * API does, on every request, with the second factor (ADR 0021).
 *
 * What this page has to communicate is narrow and it is not obvious from the
 * controls: a flag is **not** versioned configuration. Categories are, because a
 * booking keeps the terms it was made under; nothing pins a flag, so switching
 * one changes what the platform does from that moment and changes nothing about
 * what already happened. An administrator who expects the category page's
 * semantics here would be wrong in a way that matters.
 */
export default async function FeatureFlagsPage() {
  const { getToken } = await auth();
  const token = await getToken();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await fetchFeatureFlags(
    webEnv().API_BASE_URL,
    token,
    undefined,
    clientIp,
  );

  return (
    <main>
      <h1>Feature flags</h1>

      <p>
        Switches for capabilities that are incomplete or high-risk, and the{' '}
        <strong>emergency stops</strong> for ones that are working but should not be
        right now. A change takes effect within about ten seconds, everywhere, for
        everybody.
      </p>

      <p>
        <strong>A flag is not versioned configuration.</strong> A category is — a
        booking keeps the terms it was made under — but nothing pins a flag. Switching
        one changes what the platform does from that moment and changes nothing about
        what has already happened: listings published before you switch publishing off
        stay published.
      </p>

      <p>
        Every change is recorded with who made it, when, and the reason you give. The
        reason is for whoever reviews the incident afterwards — including you, at the
        point when you no longer remember.
      </p>

      <p>
        The set of switches is part of the build, so this list is not something you add
        to here. If a capability needs a switch it does not have, that is a change to
        the code.
      </p>

      <section aria-labelledby="switches">
        <h2 id="switches">Switches</h2>
        <FlagList outcome={outcome} />
      </section>

      <AdminNav current="/admin/feature-flags" />
    </main>
  );
}

function FlagList({
  outcome,
}: {
  readonly outcome: AdminFeatureFlagOutcome<readonly AdminFeatureFlag[]>;
}) {
  if (outcome.kind === 'signed-out') {
    // The state first, the likeliest cause second — an expiry stated as fact is
    // a claim about a session we cannot vouch for.
    return (
      <p role="status">
        You are not signed in. Your session may have expired —{' '}
        <Link href="/sign-in">sign in</Link> to see the switches.
      </p>
    );
  }

  if (outcome.kind === 'forbidden') {
    /*
     * The read refused, so the switches are not rendered beneath it.
     *
     * Slice 2.1 fixed exactly this on the categories page and the gap list still
     * records `/admin/users` doing it wrong: a page whose read is refused must
     * not go on to draw controls that will refuse too. A dead control is worse
     * on this page than anywhere — somebody would press it during an incident
     * and conclude the platform was unresponsive rather than that they lacked
     * access.
     */
    return (
      <p role="status">
        You do not have access to this. Administrator access needs a second factor
        verified in the last 12 hours.
      </p>
    );
  }

  if (outcome.kind !== 'loaded') {
    return (
      <p role="alert">
        The switches could not be read, so none are shown —{' '}
        {'reason' in outcome ? outcome.reason : 'the API rejected the request'}.{' '}
        <strong>This does not mean anything has changed.</strong> Flags stay exactly as
        they were.
      </p>
    );
  }

  if (outcome.value.length === 0) {
    return <p>This build declares no feature flags.</p>;
  }

  return (
    <ul>
      {outcome.value.map((flag) => (
        <li key={flag.key}>
          <FeatureFlagSwitch flag={flag} />
        </li>
      ))}
    </ul>
  );
}
