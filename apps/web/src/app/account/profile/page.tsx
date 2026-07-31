import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { ProfileForm } from '../../../components/profile-form';
import { fetchMyProfile } from '../../../lib/profile';
import { webEnv } from '../../../lib/env';

/**
 * Never prerendered — the answer depends on who is asking, and a build-time
 * render would bake one person's profile into a static file.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Your profile' };

export default async function ProfilePage() {
  const { getToken } = await auth();
  const outcome = await fetchMyProfile(webEnv().API_BASE_URL, await getToken());

  return (
    <main>
      <h1>Your profile</h1>

      {outcome.kind === 'loaded' ? (
        <>
          <p>
            What other people see is your display name, your town and the first part of
            your postcode. Your phone number and full address are shared only with
            someone you have agreed a rental with.
          </p>
          <ProfileForm profile={outcome.profile} />
        </>
      ) : null}

      {outcome.kind === 'signed-out' ? (
        <p>
          <Link href="/sign-in">Sign in</Link> to edit your profile.
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

      <p>
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
