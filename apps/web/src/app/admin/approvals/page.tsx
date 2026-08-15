import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { ApprovalQueue } from '../../../components/approval-queue';
import type { QueueOutcome } from '../../../components/approval-queue';
import { RoleChangeForm } from '../../../components/role-change-form';
import { AdminNav } from '../../../components/admin-nav';
import { AdminAccessNotice, accessFrom } from '../admin-access';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchPendingApprovals } from '../../../lib/admin-approvals';
import { fetchAccount } from '../../../lib/account';
import { webEnv } from '../../../lib/env';

/** Never prerendered — the queue changes under you, and it is admin-only. */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Role changes and approvals',
  robots: { index: false, follow: false },
};

/**
 * BRD §8.13's dual approval, and the first place an administrator can change
 * anything at all.
 *
 * Everything before this was a read. That ordering was deliberate: retrofitting
 * approval onto an action people already use is much harder than building the
 * action inside it, so the first administrative write arrives already behind
 * two people (ADR 0023).
 *
 * **The page does not check the role**, the same as every other admin page. The
 * API does, on every request, with the second factor.
 */
export default async function ApprovalsPage() {
  const { getToken } = await auth();
  const token = await getToken();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const api = webEnv().API_BASE_URL;
  const [queue, account] = await Promise.all([
    fetchPendingApprovals(api, token, undefined, clientIp),
    fetchAccount(api, token, undefined, clientIp),
  ]);

  const access = accessFrom(queue);

  return (
    <main>
      <h1>Role changes</h1>

      <p>
        Changing an account&rsquo;s role takes <strong>two administrators</strong>. One
        proposes, a different one agrees, and only then does anything happen. Both
        reasons are recorded, and the account holder can read them.
      </p>

      <p>
        If you are the only administrator, nothing here can be approved &mdash; an
        approver has to be somebody else.{' '}
        <strong>
          The first two administrators are both created directly in the database
        </strong>
        , deliberately, because any way to make one from inside the application would be
        a way round this rule. From the third onwards, every change goes through this
        page.
      </p>

      <section aria-labelledby="propose">
        <h2 id="propose">Propose a change</h2>
        {/*
          Only offered to somebody who could actually use it.

          The queue read above is the gate, so this page pays for no extra
          request: it is refused by exactly the guard that will refuse the
          proposal — the role, a second factor verified in the last 12 hours
          (ADR 0021), and not being suspended (ADR 0024). Until this, the queue
          correctly said "you do not have access" and a complete, enabled form
          sat underneath inviting the same person to propose a role change.
        */}
        {access.kind === 'permitted' ? (
          <RoleChangeForm />
        ) : (
          <AdminAccessNotice access={access} controls="this form" />
        )}
      </section>

      <ApprovalQueue outcome={toQueueOutcome(queue)} viewerId={viewerIdFrom(account)} />

      <AdminNav current="/admin/approvals" />
    </main>
  );
}

/**
 * Narrow the fetch outcome to what the queue can render.
 *
 * `unreachable` and `malformed` collapse into one `unavailable` case because
 * the component's job is to never claim an empty queue it did not see, and the
 * two failures are identical in that respect.
 */
function toQueueOutcome(
  outcome: Awaited<ReturnType<typeof fetchPendingApprovals>>,
): QueueOutcome {
  switch (outcome.kind) {
    case 'loaded':
      return { kind: 'loaded', approvals: outcome.value };
    case 'signed-out':
      return { kind: 'signed-out' };
    case 'forbidden':
      return { kind: 'forbidden' };
    case 'unreachable':
    case 'malformed':
      return { kind: 'unavailable', reason: outcome.reason };
    default:
      // `not-found`, `refused` and `invalid` cannot arise from a plain GET of
      // the queue. Reported honestly rather than rendered as an empty list.
      return { kind: 'unavailable', reason: `unexpected response (${outcome.kind})` };
  }
}

/** Who is reading, so the page can explain why a button is missing. */
function viewerIdFrom(
  account: Awaited<ReturnType<typeof fetchAccount>>,
): string | null {
  return account.kind === 'signed-in' ? account.account.id : null;
}
