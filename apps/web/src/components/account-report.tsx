import type { AccountOutcome } from '../lib/account';

/**
 * Renders one account outcome.
 *
 * Presentational and exhaustive: every branch of `AccountOutcome` is handled, so
 * adding a case to that union is a type error here rather than a silently blank
 * panel.
 *
 * The distinction it exists to preserve is between *signed out* and *we could
 * not tell*. Collapsing the two would show a signed-in person a sign-in prompt
 * whenever the API hiccuped, and they would keep signing in against a service
 * that cannot answer.
 */
export function AccountReport({ outcome }: { outcome: AccountOutcome }) {
  switch (outcome.kind) {
    case 'signed-in':
      return (
        <section aria-labelledby="account">
          <h2 id="account">Your account</h2>
          <dl>
            <div>
              <dt>Email</dt>
              <dd>{outcome.account.email}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{outcome.account.role}</dd>
            </div>
            <div>
              {/* Ours, not Clerk's. This is the value every listing, booking and
                  ledger entry will reference from Phase 2 onward. */}
              <dt>Account ID</dt>
              <dd>{outcome.account.id}</dd>
            </div>
          </dl>
        </section>
      );

    case 'signed-out':
      return (
        <section aria-labelledby="account">
          <h2 id="account">Not signed in</h2>
          <p>Sign in to see your account.</p>
        </section>
      );

    case 'unreachable':
      return (
        <section aria-labelledby="account">
          <h2 id="account">Account unavailable</h2>
          {/* Deliberately not "you are signed out". We do not know that, and
              saying so would be a lie that costs the reader a pointless sign-in. */}
          <p>
            You may still be signed in — the service that holds your account did not
            answer, so we cannot tell.
          </p>
          <p>{outcome.reason}</p>
        </section>
      );

    case 'malformed':
      return (
        <section aria-labelledby="account">
          <h2 id="account">Account unavailable</h2>
          <p>
            The API answered with something this version of the site does not
            understand. If a deploy is in progress, this should clear on its own.
          </p>
          <p>{outcome.reason}</p>
        </section>
      );
  }
}
