import { Postcode } from '@platform/core';
import type { MeResponse, MyProfile } from '@platform/contracts';
import styles from './account-header.module.css';

/**
 * Who you are, at the top of your own account page (slice D4).
 *
 * **The meta line is assembled from what happens to be known**, which is the
 * only honest way to build it: a brand-new account has an email and nothing
 * else, and a header that renders `undefined · undefined` for its first visitor
 * is worse than one that renders an email.
 *
 * The design shows `s•••@gmail.com · Battersea · SW11`. The masking is not
 * reproduced: this page is only ever shown to the person whose email it is —
 * `fetchAccount` answers for the caller and nobody else — so obscuring it
 * protects nothing and costs somebody the ability to check which account they
 * are signed in to, which is the single most likely reason to look here.
 */
export function AccountHeader({
  account,
  profile,
}: {
  readonly account: MeResponse;
  /** Null before somebody has filled one in, and for a failed read. */
  readonly profile: MyProfile | null;
}) {
  const parts = [
    account.email,
    profile?.address?.town,
    // The district, never the full postcode — the same rule the profile form
    // teaches and the public profile obeys (BRD §8.4.1, ADR 0016). Showing the
    // whole thing here would be defensible, since this page answers only for its
    // own owner, but the header's job is to reflect what a neighbour sees.
    district(profile?.address?.postcode),
  ].filter((part): part is string => typeof part === 'string' && part !== '');

  return (
    <header className={styles.header}>
      <span className={styles.avatar} aria-hidden="true">
        {avatarLetter(profile?.displayName ?? account.email)}
      </span>

      <div>
        {/*
          The display name when there is one, and the level-1 heading either
          way. A page whose only heading is "Account" tells somebody using a
          screen reader nothing about whose.
        */}
        <h1 className={styles.name}>{profile?.displayName ?? 'Your account'}</h1>
        <p className={styles.meta}>{parts.join(' · ')}</p>
      </div>
    </header>
  );
}

/**
 * The postal district, or nothing.
 *
 * **`Postcode.outwardCode` throws on anything it does not recognise**, which is
 * right where it is used — a listing must not publish a plausible-looking
 * district derived from nonsense. Here the value has already been through the
 * API's validation, so a throw would mean a stored postcode that our own
 * contract accepted and our own parser rejects. That is worth knowing about, but
 * not by taking down the page somebody uses to fix their address: it degrades to
 * a meta line that is one part shorter.
 */
function district(postcode: string | undefined): string | undefined {
  if (postcode === undefined || postcode === '') return undefined;
  return Postcode.isValid(postcode) ? Postcode.outwardCode(postcode) : undefined;
}

/**
 * The letter in the avatar.
 *
 * **The display name here, unlike the header in the site bar.** That one takes
 * the email because reading a profile in the root layout would charge every page
 * in the application; this page has already fetched the profile, so it can use
 * the better answer.
 */
export function avatarLetter(from: string): string {
  const first = from.trim().charAt(0);
  return first === '' ? '·' : first.toUpperCase();
}
