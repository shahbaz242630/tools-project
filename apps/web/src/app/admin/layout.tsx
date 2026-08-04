import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { fetchAccount } from '../../lib/account';
import { clientIpFrom } from '../../lib/client-ip';
import { webEnv } from '../../lib/env';

/**
 * Wraps every administrative page.
 *
 * **It exists for one reason: to say out loud when the second-factor check is
 * off** (ADR 0030). Clerk gates MFA behind a paid plan, so during development
 * the API can be told to admit an administrator without one — and an admin page
 * that simply *works* is otherwise indistinguishable from one whose check was
 * satisfied. Four sessions of handoff notes are not a reliable way to remember
 * which, and "it opened for me" is exactly the evidence somebody would record.
 *
 * A layout rather than a component each page imports, because the point is that
 * **no admin page can be added without it**. That is the same reasoning the
 * guard uses for folding MFA into the role check rather than a per-route
 * decorator: a rule you have to remember to apply is one that eventually is not.
 */
export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { getToken } = await auth();
  const outcome = await fetchAccount(
    webEnv().API_BASE_URL,
    await getToken(),
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  // Only a successful read can report the flag. Every other outcome — signed
  // out, unreachable, malformed — renders no banner and lets the page below
  // explain itself, because a warning about a state we could not read would be
  // a claim we cannot support.
  const bypassed = outcome.kind === 'signed-in' && outcome.account.adminMfaBypassed;

  return (
    <>
      {bypassed ? <SecondFactorDisabledNotice /> : null}
      {children}
    </>
  );
}

/**
 * Deliberately unmissable, and deliberately worded for whoever reads it next.
 *
 * `role="alert"` rather than a styled box, because this project has no styling
 * yet and the thing that must survive is the *meaning*: anything seen working on
 * these pages proves the page, not the authentication in front of it.
 */
function SecondFactorDisabledNotice() {
  return (
    <p role="alert">
      <strong>The second-factor check is switched off in this environment.</strong>{' '}
      These pages opened without proving a second factor, because{' '}
      <code>DANGEROUSLY_ALLOW_ADMIN_WITHOUT_MFA</code> is set — Clerk gates MFA behind a
      paid plan and this is the development stand-in for it (ADR 0030). The API refuses
      to start with this set in production, so you cannot be seeing it anywhere real.{' '}
      <strong>
        Anything verified here is verified about the page, not about the authentication
        in front of it
      </strong>
      , and a note saying an admin surface was &ldquo;checked by using it&rdquo; has to
      say so.
    </p>
  );
}
