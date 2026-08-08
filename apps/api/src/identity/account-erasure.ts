import { Time } from '@platform/core';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import { auditableAccount } from './auditable-account.js';
import type { AuthenticationEvents } from './authentication-events.js';
import type { PersonalDataEraser } from './personal-data-eraser.js';
import type { MirroredUser, UserDirectory } from './user-directory.js';

/**
 * The address a deleted account's row keeps.
 *
 * `.invalid` is reserved by RFC 2606 and can never be a real domain, and our
 * own row id makes it unique without a lookup. Replacing the address frees the
 * real one for genuine re-registration — a retained unique row would otherwise
 * lock that person out of the platform permanently — and drops personal data
 * we no longer have a purpose for.
 */
export function tombstoneEmail(userId: string): string {
  return `deleted+${userId}@deleted.invalid`;
}

/**
 * Everything a deletion does, in the order ADR 0018 requires.
 *
 * **Its own collaborator from slice H4, and the reason is the reason it was a
 * shared private method before.** Two paths start a deletion — the person's own
 * request, and Clerk's `user.deleted` webhook — and after the split those live
 * in two different services. Leaving the work in either one would make the other
 * call a sibling service to perform it, which is the shape that invites somebody
 * to write "just two lines" locally instead.
 *
 * That is not hypothetical here. **Until slice 1.5c the webhook branch had
 * exactly that**: its own two-line version that tombstoned the email and
 * stopped — no erasure, no redaction, no `deletionRequestedAt`, no audit entry.
 * It was written on the assumption that `user.deleted` only ever *follows* our
 * own route, and Clerk's account screen made that false. Somebody deleting
 * through it was told their data was gone while the profile, the address
 * ciphertext and the sign-in history all survived.
 *
 * The same failure slice 1.7 fixed for `account.email_changed`, where two copies
 * of a rule drifted on the one thing missing from both. The answer is the same:
 * one implementation, two callers, no second copy to forget.
 */
export class AccountErasure {
  constructor(
    private readonly users: UserDirectory,
    private readonly audit: AuditService,
    private readonly eraser: PersonalDataEraser,
    private readonly authenticationEvents: AuthenticationEvents,
  ) {}

  /**
   * Erase, then tombstone.
   *
   * **Order is the decision** (ADR 0018). The reverse leaves somebody locked out
   * of an account that still holds their address, with no way to authenticate
   * and ask again. This way a failure leaves the account usable and the request
   * repeatable — which matters more on the webhook path, where nobody is
   * watching a page for an error.
   */
  async eraseAndTombstone(user: MirroredUser, actor: Actor): Promise<void> {
    // Each module writes its own entry for what it removed, so this produces
    // the `profile.erased` line in the trail.
    await this.eraser.erase(actor);

    // Identity's own personal data, erased directly rather than through the
    // eraser port — that port is how *other* modules contribute, and this
    // module reaching for it to erase its own table would be indirection with
    // no boundary behind it.
    //
    // Redaction, not deletion: the rows stay and lose their activity columns.
    // §10.1 retains security logs six years, and "a session started at 14:02"
    // is what can honestly be retained once the device and address are gone.
    await this.authenticationEvents.eraseActivity(user.id);

    const at = Time.nowUtc();
    const deleted = await this.users.update(user.id, {
      deletedAt: at,

      // Set on both paths. It answers "when did they ask", which is the
      // question a data-protection enquiry actually puts — and a deletion that
      // started at Clerk was still asked for, just not here.
      deletionRequestedAt: at,
      email: tombstoneEmail(user.id),
    });

    // Recorded last, so the entry describes a completed deletion rather than an
    // attempted one. It is retained after the erasure it describes — that is
    // the point of §10.1, and it survives because it holds digests, not values.
    await this.audit.record({
      actor,
      action: 'account.deletion_requested',
      targetType: 'user',
      targetId: user.id,
      before: auditableAccount(user),
      after: auditableAccount(deleted),
    });
  }
}
