import { UserProfile } from '@clerk/nextjs';
import Link from 'next/link';

/**
 * Correcting your email address and sign-in details.
 *
 * **Clerk's own screen, deliberately** (ADR 0020). The email address is a
 * credential, and changing one means proving you hold the new address before
 * it takes effect — verification, a code, a rollback if it is never confirmed.
 * ADR 0015 put credentials at Clerk precisely so we do not write that; building
 * our own form here would mean either duplicating the verification flow or
 * skipping it, and skipping it turns an email change into account takeover.
 *
 * A catch-all segment because Clerk routes its own sub-pages beneath this one,
 * the same pattern the sign-in and sign-up pages use.
 */
export const metadata = {
  title: 'Email and sign-in',
  robots: { index: false, follow: false },
};

export default function AccountEmailPage() {
  return (
    <main>
      <h1>Email and sign-in</h1>

      <p>
        Change the email address you sign in with, or update your password. You will be
        asked to confirm a new address before it takes effect.
      </p>

      <p>
        {/* Worth saying plainly: people reasonably expect one "change my email"
            to change everything, and the profile is a separate thing. */}
        This does not change your <Link href="/account/profile">profile</Link> — your
        display name, phone number and address are edited there.
      </p>

      <UserProfile />

      <p>
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
