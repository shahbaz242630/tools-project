import Link from 'next/link';
import { PublicProfileCard } from '../../../components/public-profile-card';
import { fetchPublicProfile } from '../../../lib/profile';
import { webEnv } from '../../../lib/env';

/**
 * Somebody's public profile.
 *
 * Dynamic because the profile can change and there is no revalidation story
 * yet; a prerendered page would keep serving a display name its owner has
 * already changed, and — more seriously — would keep serving a profile after
 * the account was deleted.
 */
export const dynamic = 'force-dynamic';

/**
 * Deliberately not indexed.
 *
 * BRD §8.17 wants listings discoverable; nothing there asks for user profiles
 * to be. Until that is a decided product question rather than a side effect of
 * having built a page, the safe default for a page carrying a real person's
 * name and postal district is to stay out of search results.
 */
export const metadata = {
  title: 'Profile',
  robots: { index: false, follow: false },
};

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  const outcome = await fetchPublicProfile(webEnv().API_BASE_URL, userId);

  return (
    <main>
      <h1>Profile</h1>

      <PublicProfileCard outcome={outcome} />

      <p>
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
