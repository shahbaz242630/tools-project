import { UserProfile } from '@clerk/nextjs';
import Link from 'next/link';

/**
 * Your email address, your password, and what is signed in to your account.
 *
 * **Clerk's own screen, deliberately** (ADR 0020). The email address is a
 * credential, and changing one means proving you hold the new address before
 * it takes effect — verification, a code, a rollback if it is never confirmed.
 * ADR 0015 put credentials at Clerk precisely so we do not write that; building
 * our own form here would mean either duplicating the verification flow or
 * skipping it, and skipping it turns an email change into account takeover.
 *
 * **Mounting the component mounts everything in it**, which is why the title
 * names devices. `<UserProfile />` came here in slice 1.7 for the email change
 * and silently brought its whole Security tab — an active-device list showing a
 * browser, an IP and a *city* Clerk resolves client-side, which our server-side
 * webhook cannot see at all (ADR 0025). That list has been the best answer we
 * have to "what is signed in to my account" ever since, behind a link nobody
 * would have clicked to find it. Slice 1.11b renamed the door rather than
 * building a second room.
 *
 * The same accident had a worse half: it also brought a delete-account button,
 * which reached a code path written when no such button existed (ADR 0018's
 * correction). Enumerate what a vendor screen does before mounting it.
 *
 * A catch-all segment because Clerk routes its own sub-pages beneath this one,
 * the same pattern the sign-in and sign-up pages use.
 */
export const metadata = {
  title: 'Email, password and devices',
  robots: { index: false, follow: false },
};

export default function AccountEmailPage() {
  return (
    <main>
      <h1>Email, password and devices</h1>

      <p>
        Change the email address you sign in with, or update your password. You will be
        asked to confirm a new address before it takes effect.
      </p>

      <p>
        {/* Said plainly because the tab is easy to miss, and it is the reason
            somebody arriving from the sign-in history came here at all. */}
        The <strong>Security</strong> section below lists the devices currently signed
        in to your account. If you do not recognise one, sign it out from there and
        change your password.
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
