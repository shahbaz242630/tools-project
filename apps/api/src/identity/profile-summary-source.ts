import type { AdminProfile } from '@platform/contracts';

/**
 * A module's contribution to the administrative account view.
 *
 * The third port Profiles & Trust implements for Identity & Access, alongside
 * `PersonalDataEraser` and `PersonalDataSource`, and it exists for the same
 * reason they do: Identity owns the account and assembles the view, but it does
 * not hold a profile and could not decrypt an address if it did. Reaching into
 * `profiles` from the identity module would be the cross-module read the
 * boundary exists to prevent (BRD §5.1).
 *
 * **It is deliberately not a method on `PersonalDataSource`.** That port answers
 * "everything you hold about this person, for them"; this one answers "the least
 * you can say about this person that helps support". Folding the second into the
 * first would put a subject-access projection and a staff-facing one behind one
 * name, and the day somebody widens the wrong one is the day an administrator
 * starts seeing street lines.
 *
 * ADR 0019 already notes the weak point of this pattern: nothing forces a new
 * module holding personal data to implement any of these ports, and nothing
 * will tell you if it implements none. That is now true of three ports rather
 * than two.
 */
export interface ProfileSummarySource {
  /**
   * What support may see of this module's data about `userId`.
   *
   * Null when it holds nothing — different from holding an empty record, and
   * the distinction is what tells support "they never filled this in" rather
   * than "something is broken".
   */
  summaryFor(userId: string): Promise<AdminProfile>;
}
