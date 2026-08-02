/**
 * Turning an audit entry into words, for both readers of it.
 *
 * The same trail is served to two people — the account holder on
 * `/account/activity`, and an administrator on `/admin/activity` — so the
 * vocabulary lives here rather than in either component. Two copies would drift
 * on exactly the entries that matter least often and are read most carefully.
 */

import { describeSignInOrigin } from '@platform/contracts';
import type { ActivityActor, SignInEntry } from '@platform/contracts';

/**
 * `profile.updated` → "Profile updated".
 *
 * A lookup rather than a string transform, because the vocabulary is closed and
 * a machine-readable action is not a sentence. An unrecognised action falls
 * back to the raw value: a new action added to the API before this map is a
 * slightly ugly row, not a missing one, and a missing row in an audit trail is
 * the failure that matters.
 */
const DESCRIPTIONS: Record<string, string> = {
  'account.provisioned': 'Account created',
  'account.deletion_requested': 'Account deletion requested',
  'account.email_changed': 'Email address changed',
  'account.exported': 'Data export downloaded',
  'admin.activity_viewed': 'Account activity viewed',
  'profile.created': 'Profile created',
  'profile.erased': 'Profile erased',
  'profile.updated': 'Profile updated',
};

export function describeAction(action: string): string {
  return DESCRIPTIONS[action] ?? action;
}

/**
 * Who did it, as the account holder reads it.
 *
 * "An administrator" names a role rather than a person on purpose: the subject
 * is entitled to know their account was read and why, and is not entitled to
 * the identity of the support worker who read it.
 */
export function describeActor(by: ActivityActor): string {
  switch (by) {
    case 'subject':
      return 'You';
    case 'administrator':
      return 'An administrator';
    case 'system':
      // No actor at all — a change applied from the identity provider with
      // nobody holding a session. Saying "an administrator" would name someone
      // who was not involved.
      return 'Automatic';
  }
}

/**
 * The same column, as an administrator reads somebody else's trail.
 *
 * "You" would be wrong here — the subject is not the reader — and getting that
 * backwards on an admin screen is how a support worker misreads whose action
 * they are looking at.
 */
export function describeActorForAdmin(by: ActivityActor): string {
  return by === 'subject' ? 'Account holder' : describeActor(by);
}

/**
 * Which device each sign-in was made from, keyed by session.
 *
 * **The correlation happens here, in the page's own code, and that placement is
 * the decision rather than an accident.** The activity trail belongs to Audit
 * and the sign-in history to Identity & Access; having Audit resolve a device
 * would mean it reading back from Identity and closing a cycle between two
 * modules (ADR 0025). The page already holds both lists — it fetches them
 * concurrently for its own reasons — so joining them costs nothing and keeps
 * the modules acyclic.
 *
 * **Entries with no device are skipped rather than recorded as "unknown".** One
 * session produces several rows — a `started` and later an `ended` — and only
 * some carry request attributes. Taking the first row that actually knows the
 * device means a sign-out with nothing attached does not erase what the sign-in
 * told us.
 *
 * Entries arrive newest first, so "first match wins" means the most recent
 * description of a session, which is the right one if it ever changes.
 */
export function devicesBySession(
  entries: readonly SignInEntry[],
): ReadonlyMap<string, string> {
  const devices = new Map<string, string>();

  for (const entry of entries) {
    if (entry.browserName === null && entry.deviceType === null) continue;
    if (devices.has(entry.sessionId)) continue;
    devices.set(entry.sessionId, describeSignInOrigin(entry));
  }

  return devices;
}

/**
 * Where an audited action was taken from, in one phrase.
 *
 * The device comes from the sign-in it shares a session with, the address from
 * the entry itself. Both are optional and the three shapes read differently on
 * purpose — a reader scanning for something they do not recognise should not
 * have to work out whether a blank means "not us" or "not known".
 *
 * **Falls back silently and identically for four different causes**: an action
 * with no session behind it, an entry older than the column, a sign-in whose
 * webhook never arrived, and an administrator's action whose session is
 * deliberately withheld. To the reader they all mean the same thing — we cannot
 * say which sign-in — and inventing a distinction between them would be
 * claiming knowledge we do not have.
 *
 * On the administrative view of somebody's trail this resolves nothing at all,
 * which is correct rather than a gap: an administrator has no access to that
 * person's sign-in list (ADR 0022 and ADR 0025 both refuse it), so the map is
 * empty and every row falls back to the address. The narrowing needs no code
 * because the data is simply not there.
 */
export function describeActivityOrigin(
  entry: { readonly sessionId: string | null; readonly ipAddress: string | null },
  devices: ReadonlyMap<string, string>,
): string {
  const device = entry.sessionId === null ? undefined : devices.get(entry.sessionId);

  if (device === undefined) return entry.ipAddress ?? 'Not recorded';
  if (entry.ipAddress === null) return device;

  return `${device} · ${entry.ipAddress}`;
}
