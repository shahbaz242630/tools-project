import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { ProfileForm } from '../../../components/profile-form';
import { SuspensionNotice } from '../../../components/suspension-notice';
import { fetchAccount } from '../../../lib/account';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchMyProfile } from '../../../lib/profile';
import { webEnv } from '../../../lib/env';

/**
 * Never prerendered — the answer depends on who is asking, and a build-time
 * render would bake one person's profile into a static file.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Your profile' };

/**
 * **Two reads, and the second one is what stops this page lying to somebody.**
 *
 * `GET /me/profile` opts in to `@AllowsSuspended` and `PUT` deliberately does
 * not (ADR 0024) — a suspended person may see what we hold and take a copy of
 * it, and may not change what other people would see. Reading the profile alone
 * therefore succeeds for them, and this page used to draw the complete, enabled
 * form on the strength of it. Pressing Save produced *"Your profile was not
 * saved — API answered 403"*: the site blamed for a decision an administrator
 * made, with the reason for it sitting unread on their account page.
 *
 * So the form is drawn only when the account is known to be able to use it. The
 * same rule slice 2.1 learned on `/admin/categories`, arrived at from the other
 * side: there the read refused and the form stayed enabled; here the read
 * succeeded and the *write* was the thing that would refuse.
 *
 * Concurrent, because they are independent — and an unreadable `/me` withholds
 * the form rather than guessing, because "we could not tell whether you may
 * edit this" has exactly one safe rendering.
 */
export default async function ProfilePage() {
  const { getToken } = await auth();
  const token = await getToken();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));
  const api = webEnv().API_BASE_URL;

  const [outcome, account] = await Promise.all([
    fetchMyProfile(api, token, undefined, clientIp),
    fetchAccount(api, token, undefined, clientIp),
  ]);

  const suspended =
    account.kind === 'signed-in' && account.account.suspendedAt !== null;
  const editable = account.kind === 'signed-in' && !suspended;

  return (
    <main>
      <h1>Your profile</h1>

      {/* Above everything, because "why can I not do anything" is the question
          a suspended person arrives with. It carries the administrator's reason
          verbatim, which is the part this page was withholding. */}
      {account.kind === 'signed-in' ? (
        <SuspensionNotice account={account.account} />
      ) : null}

      {suspended ? (
        <p role="status">
          Your profile cannot be edited while your account is suspended. What is stored
          is still shown to you on <Link href="/account/data">your data download</Link>,
          and nothing here has been altered or removed.
        </p>
      ) : null}

      {outcome.kind === 'loaded' && editable ? (
        <>
          <p>
            What other people see is your display name, your town and the first part of
            your postcode. Your phone number and full address are shared only with
            someone you have agreed a rental with.
          </p>
          <ProfileForm profile={outcome.profile} />
        </>
      ) : null}

      {outcome.kind === 'signed-out' || account.kind === 'signed-out' ? (
        <p>
          You are not signed in. Your session may have expired —{' '}
          <Link href="/sign-in">sign in</Link> to edit your profile.
        </p>
      ) : null}

      {outcome.kind === 'forbidden' ? (
        // Not reachable through `GET`, which allows a suspended caller. Handled
        // because the compiler is right to insist: the day this route stops
        // opting in, a silent fall-through would leave a blank page.
        <p role="alert">
          Your profile is not available to you at the moment. If your account has been
          suspended, the reason is on your <Link href="/account">account page</Link>.
        </p>
      ) : null}

      {outcome.kind === 'unreachable' || outcome.kind === 'malformed' ? (
        // No form. Rendering an empty one would invite somebody to retype their
        // address into something that cannot save it, and a blank form beside a
        // profile that exists reads as "we lost your details".
        <p role="alert">
          Your profile could not be loaded, so it cannot be edited right now —{' '}
          {outcome.reason}
        </p>
      ) : null}

      {outcome.kind === 'loaded' &&
      (account.kind === 'unreachable' || account.kind === 'malformed') ? (
        // The form is withheld rather than drawn hopefully. Whether this account
        // may save anything is a question only `/me` answers, and a form offered
        // on a guess is the dead control slice 2.1 exists to prevent.
        <p role="alert">
          We could not check your account, so the form is not shown — {account.reason}.
          Nothing has been changed. Reload in a moment.
        </p>
      ) : null}

      <p>
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
