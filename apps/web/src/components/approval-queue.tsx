import { Time } from '@platform/core';
import type { AdminApprovalView } from '@platform/contracts';
import { ApprovalDecisionForm } from './approval-decision-form';

/**
 * Proposals waiting for a second administrator.
 *
 * Presentational and exhaustive. The distinction it exists to preserve is the
 * same one the activity list preserves: **an empty queue and a queue that could
 * not be read are different things**, and rendering "nothing is waiting"
 * because the API timed out would be a false reassurance about a control.
 */
export type QueueOutcome =
  | { readonly kind: 'loaded'; readonly approvals: readonly AdminApprovalView[] }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export function ApprovalQueue({
  outcome,
  viewerId,
}: {
  outcome: QueueOutcome;
  /** Whose session is reading this — used to explain, never to enforce. */
  viewerId: string | null;
}) {
  switch (outcome.kind) {
    case 'loaded':
      if (outcome.approvals.length === 0) {
        return (
          <section aria-labelledby="queue">
            <h2 id="queue">Waiting for approval</h2>
            <p>Nothing is waiting.</p>
          </section>
        );
      }

      return (
        <section aria-labelledby="queue">
          <h2 id="queue">Waiting for approval</h2>
          <ul>
            {outcome.approvals.map((approval) => (
              <li key={approval.id}>
                <Proposal approval={approval} viewerId={viewerId} />
              </li>
            ))}
          </ul>
        </section>
      );

    case 'forbidden':
      return (
        <section aria-labelledby="queue">
          <h2 id="queue">Waiting for approval</h2>
          <p>
            You do not have access to this. Administrator access needs a second factor
            verified recently.
          </p>
        </section>
      );

    case 'signed-out':
      return (
        <section aria-labelledby="queue">
          <h2 id="queue">Waiting for approval</h2>
          <p>Sign in to see what is waiting.</p>
        </section>
      );

    case 'unavailable':
      return (
        <section aria-labelledby="queue">
          <h2 id="queue">Queue unavailable</h2>
          {/* Deliberately not "nothing is waiting". We do not know that. */}
          <p>
            The approval queue could not be loaded, so this is not a record of nothing
            waiting — {outcome.reason}
          </p>
        </section>
      );
  }
}

function Proposal({
  approval,
  viewerId,
}: {
  approval: AdminApprovalView;
  viewerId: string | null;
}) {
  const isOwn = viewerId !== null && approval.proposedById === viewerId;

  return (
    <article>
      <h3>
        Make {approval.action.userId} {approval.action.role}
      </h3>

      <dl>
        <dt>Proposed by</dt>
        <dd>{approval.proposedById}</dd>

        <dt>Reason given</dt>
        <dd>{approval.proposedReason}</dd>

        <dt>Proposed</dt>
        <dd>
          <time dateTime={approval.proposedAt}>{formatWhen(approval.proposedAt)}</time>
        </dd>

        <dt>Expires</dt>
        <dd>
          <time dateTime={approval.expiresAt}>{formatWhen(approval.expiresAt)}</time>
        </dd>
      </dl>

      {isOwn ? (
        // Explained here, enforced by the API and by a database constraint under
        // it. Hiding the button is a courtesy so somebody does not press it and
        // be refused; it is emphatically not what stops a self-approval.
        <p>
          You proposed this, so somebody else has to approve it. You can withdraw it.
        </p>
      ) : null}

      <ApprovalDecisionForm id={approval.id} canApprove={!isOwn} />
    </article>
  );
}

function formatWhen(iso: string): string {
  return Time.fromIsoUtc(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  });
}
