import Link from 'next/link';
import { ADMIN_SURFACES } from '../../components/admin-nav';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Administration',
  robots: { index: false, follow: false },
};

/**
 * The administrative surface, from the front.
 *
 * **There was no `/admin` at all until this**, so typing the obvious URL 404d,
 * and nothing anywhere in the application linked to any of the six pages beneath
 * it. They were reachable only by typing an exact path from memory — which is
 * how three of them came to carry cross-links that had quietly drifted apart,
 * and how four of them shipped with forms nobody had ever pressed.
 *
 * **It performs no read, and it deliberately draws no control.** Everything here
 * is a link. There is nothing to refuse, so there is nothing that could be shown
 * as working when it is not — the failure this page would otherwise repeat six
 * times over. Each page below asks its own question and says its own answer.
 *
 * **Nothing links here from `/account`.** Whether an ordinary account page should
 * reveal that an administrative surface exists is a product decision, not an
 * engineering one, and it is open. An administrator reaches this by URL until it
 * is settled — which is no worse than before and is now one URL rather than six.
 */
export default function AdminIndexPage() {
  return (
    <main>
      <h1>Administration</h1>

      <p>
        Everything an administrator can do, in one place. Each of these needs the{' '}
        <strong>administrator role</strong> and a{' '}
        <strong>second factor verified in the last 12 hours</strong> (ADR 0021) — the
        API checks both on every request, so a page opening is not the same as a page
        working, and each one says which it is.
      </p>

      <p>
        <strong>Every action below is recorded</strong> with your account, what you did,
        which account or listing it was done to, and the reason you gave (§8.13). The
        person it was done to can read that reason on their own activity page, in your
        words. Write them accordingly.
      </p>

      <ul>
        {ADMIN_SURFACES.map((surface) => (
          <li key={surface.href}>
            <h2>
              <Link href={surface.href}>{surface.label}</Link>
            </h2>
            <p>{surface.blurb}</p>
          </li>
        ))}
      </ul>

      <p>
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
