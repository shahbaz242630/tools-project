import { SignIn } from '@clerk/nextjs';
import styles from '../../auth-page.module.css';

/**
 * **A title, which this page did not have.** Every tab for every step of the
 * sign-in flow read as the bare brand name, which on a browser holding six tabs
 * is indistinguishable from the home page. It says what the page is and nothing
 * about the product, because the brand is still `BRAND_PLACEHOLDER` (ADR 0005)
 * and baking a name into copy is what that constant exists to prevent.
 *
 * **`noindex, nofollow`, and the reason is the catch-all segment.** Clerk routes
 * its whole flow underneath this one path — factor steps, SSO callbacks,
 * verification — so an indexable `/sign-in` is an indexable URL space of
 * near-identical pages that answer no query anybody types. It is the same
 * crawl-trap reasoning as Browse's `?page=`, and none of §8.17's crawlable
 * surface is here: that is the listing page and the search page.
 */
export const metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  // A real `<main>`, which this page also did not have — it rendered a bare
  // `<div>`, so the document had no main landmark and the layout's skip link
  // landed a keyboard user on a wrapper rather than on the form.
  return (
    <main className={styles.page}>
      <SignIn />
    </main>
  );
}
