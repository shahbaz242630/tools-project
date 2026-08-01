/**
 * Turning an audit entry into words, for both readers of it.
 *
 * The same trail is served to two people — the account holder on
 * `/account/activity`, and an administrator on `/admin/activity` — so the
 * vocabulary lives here rather than in either component. Two copies would drift
 * on exactly the entries that matter least often and are read most carefully.
 */

import type { ActivityActor } from '@platform/contracts';

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
