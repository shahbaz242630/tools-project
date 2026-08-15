'use client';

import { NoticePage } from '../../components/notice-page';

/**
 * When something throws anywhere under `/admin` (Phase 0–3 audit).
 *
 * **Two things are true here that are true nowhere else**, and between them they
 * are why this is not the root boundary repeated:
 *
 * - every action in this section acts on somebody *else's* account or listing —
 *   a role change, a suspension, a moderation decision — and each one is written
 *   to the append-only audit log. An administrator who meets this page needs to
 *   know whether a half-applied decision is now on somebody's record. It is not:
 *   the effect and its audit entry are written in one transaction, so a render
 *   that throws afterwards leaves neither;
 * - an error here can equally be the guard doing its job. The role and
 *   second-factor checks fail closed by design (ADR 0021), and "you are not
 *   allowed" arriving as an exception looks exactly like a broken page. Saying
 *   so is what stops somebody debugging the deployment when the answer is that
 *   the second factor is more than twelve hours old.
 *
 * It does not name which of the two it was, because this component cannot tell —
 * the boundary is handed an error stripped of its message in production, and
 * guessing would be worse than the honest pair.
 *
 * `retry` rather than `reset`, for the reason written out in `app/error.tsx`.
 */
export default function AdminError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <NoticePage
      overline="Administration"
      heading="That didn't load."
      action={
        <button
          type="button"
          onClick={() => {
            retry();
          }}
        >
          Try again
        </button>
      }
    >
      No administrative action was taken and nothing was written to the audit log. If
      trying again does not help, sign in again — administrative pages need a second
      factor verified in the last twelve hours, and an expired one refuses rather than
      explains.
    </NoticePage>
  );
}
