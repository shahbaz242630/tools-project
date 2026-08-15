import { SignUp } from '@clerk/nextjs';
import styles from '../../auth-page.module.css';

/**
 * The sign-in page's twin, and everything said there applies here — the title,
 * the `noindex` over a catch-all Clerk routes its whole flow underneath, the
 * `<main>` landmark, and the shared module that replaced an inline
 * `min-height: 100vh` inside a layout that already draws a header and a footer.
 *
 * *Create an account*, matching the label the header and footer use for the link
 * that leads here. A tab reading "Sign up" beside a control reading "Create an
 * account" is a small thing to get wrong twice.
 */
export const metadata = {
  title: 'Create an account',
  robots: { index: false, follow: false },
};

export default function SignUpPage() {
  return (
    <main className={styles.page}>
      <SignUp />
    </main>
  );
}
