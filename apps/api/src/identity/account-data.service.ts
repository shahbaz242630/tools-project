import { Paging, Time } from '@platform/core';
import { EXPORT_SCHEMA_VERSION } from '@platform/contracts';
import type {
  DataExport,
  ExportedListingsSection,
  ExportedProfile,
} from '@platform/contracts';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import { AccountErasure } from './account-erasure.js';
import type {
  AuthenticationEvents,
  RecordedAuthenticationEvent,
} from './authentication-events.js';
import type { PersonalDataSource } from './personal-data-source.js';
import type { UserDirectory } from './user-directory.js';

/**
 * What the platform holds about somebody, and what they may do with it.
 *
 * **One of the four services `identity.service.ts` split into in slice H4.**
 * This is BRD §10.1's half of the module: the export, the sign-in history a
 * person reads about their own account, and the deletion they can ask for. It
 * is grouped by *whose* question it answers rather than by which table it
 * touches — every method here is the account holder asking about themselves,
 * which is why none of them takes a target id.
 *
 * The three administrative services are its opposite: somebody acting on an
 * account that is not theirs, which is why those record a reason and these do
 * not.
 */

/**
 * How many sign-ins a data export carries.
 *
 * Higher than the activity page's fifty, because the two answer different
 * questions: a page is something you scan, an export is the copy you keep and
 * the one a subject-access request is answered with. Bounded all the same —
 * nothing prunes `authentication_events`, so an account signing in daily for
 * five years would otherwise assemble two thousand rows into a synchronous
 * response, and the export is already the most expensive endpoint we serve.
 *
 * The cut is recorded in the document rather than left silent, so nobody reads
 * a truncated file as a complete one.
 */
export const EXPORTED_SIGN_IN_LIMIT = 500;

/** How many sign-ins the page shows. Matches the activity trail's fifty. */
export const DEFAULT_SIGN_IN_LIMIT = 50;

/**
 * The largest page anyone may ask for.
 *
 * An engineering bound on one query's cost, mirroring `MAX_ACTIVITY_LIMIT`.
 * There is no pagination yet and nothing prunes this table, so an unbounded
 * caller would read a whole sign-in history into memory to render fifty rows.
 */
export const MAX_SIGN_IN_LIMIT = 200;

/**
 * Clamp a caller-supplied limit into range, rejecting nonsense quietly.
 *
 * Delegates to the shared clamp from slice H2. This copy was the guarded one —
 * the audit module's was not — and consolidating kept this behaviour rather
 * than the other.
 */
export function boundedSignInLimit(limit: number): number {
  return Paging.boundedLimit(limit, {
    fallback: DEFAULT_SIGN_IN_LIMIT,
    max: MAX_SIGN_IN_LIMIT,
  });
}

export class AccountDataService {
  constructor(
    private readonly users: UserDirectory,
    private readonly audit: AuditService,
    private readonly profileSource: PersonalDataSource<ExportedProfile>,
    /**
     * Catalogue's section — the listings this person wrote, and the collection
     * addresses on them (slice 2.5a).
     *
     * A **second** source rather than a wider first one, because each module
     * supplies what it holds and knows how to make readable. Its erasure travels
     * through the `PersonalDataEraser` port, composed at the composition root
     * and reached here through `AccountErasure`.
     */
    private readonly listingSource: PersonalDataSource<ExportedListingsSection>,
    private readonly authenticationEvents: AuthenticationEvents,
    /**
     * Shared with the mirror, which performs the same erasure when Clerk
     * reports a deletion that started at its end (slice 1.5c, H4).
     */
    private readonly erasure: AccountErasure,
  ) {}

  /**
   * Assemble everything the platform holds about somebody.
   *
   * Identity assembles it because it owns the account, but it does not *hold*
   * most of it — each module supplies its own section through a port, for the
   * same reason erasure works that way. Reaching into `profiles` from here
   * would be the cross-module read the boundary exists to prevent, and this
   * module has no way to decrypt an address in any case.
   *
   * **Audited.** This is the one bulk disclosure the platform performs and the
   * only path by which a decrypted address leaves the database. An access log
   * with a hole exactly where the sensitive operation is would be worse than
   * none (ADR 0019). Recorded before the document is returned, so a disclosure
   * that happened cannot fail to be recorded.
   */
  async exportFor(actor: Actor): Promise<DataExport | null> {
    const user = await this.users.findById(actor.userId);
    if (user === null) return null;

    const [profile, activity, signIns, listings] = await Promise.all([
      this.profileSource.exportFor(user.id),
      this.audit.listForActor(user.id),
      // One more than we will serve, so "there were more" is measured rather
      // than inferred from the page being full — a count that equals the limit
      // exactly is otherwise indistinguishable from a truncated one.
      this.authenticationEvents.listFor(user.id, Paging.probe(EXPORTED_SIGN_IN_LIMIT)),
      this.listingSource.exportFor(user.id),
    ]);

    // The same probe-and-fit the listings section performs for itself, now
    // through the shared helper rather than open-coded here (slice H2).
    const signInPage = Paging.fitTo(signIns, EXPORTED_SIGN_IN_LIMIT);
    const signInsTruncated = signInPage.truncated;
    const includedSignIns = signInPage.items;

    const exportedAt = Time.toIsoUtc(Time.nowUtc());

    await this.audit.record({
      actor,
      action: 'account.exported',
      targetType: 'user',
      targetId: user.id,
      // No before or after: nothing changed. An export is a disclosure, not a
      // mutation, and inventing a state transition for it would make the two
      // indistinguishable in the trail.
    });

    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt,
      account: {
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: Time.toIsoUtc(user.createdAt),
        deletedAt: user.deletedAt === null ? null : Time.toIsoUtc(user.deletedAt),
        deletionRequestedAt:
          user.deletionRequestedAt === null
            ? null
            : Time.toIsoUtc(user.deletionRequestedAt),
      },
      profile,
      // The export itself is deliberately absent from the activity it contains
      // — it is recorded above, so it appears in the *next* export. Including
      // it would mean a document describing its own creation, which reads as a
      // bug to anyone comparing two exports.
      activity: activity.map((entry) => ({
        action: entry.action,
        targetType: entry.targetType,
        ipAddress: entry.ipAddress,
        createdAt: Time.toIsoUtc(entry.createdAt),
      })),

      // A separate section rather than folded into `activity`, because they are
      // different kinds of record and flattening them would lose that. An
      // activity entry is something somebody chose to do; a sign-in is
      // something that happened to the account, and it carries a device and a
      // place that no activity entry has.
      //
      // The Clerk session id is included on purpose: it is what lets somebody
      // match a line here against a device in Clerk's own list, and Article 15
      // is about the data we hold — which includes the reference we hold.
      // Stated in the file, because a truncated export that does not say so is
      // one somebody reads as the whole record. Only ever true for an account
      // with more than five hundred sign-ins.
      signInsTruncated,
      signIns: includedSignIns.map((entry) => ({
        event: entry.event,
        sessionId: entry.clerkSessionId,
        occurredAt: Time.toIsoUtc(entry.occurredAt),
        ipAddress: entry.activity.ipAddress,
        browserName: entry.activity.browserName,
        browserVersion: entry.activity.browserVersion,
        deviceType: entry.activity.deviceType,
        isMobile: entry.activity.isMobile,
      })),

      // Catalogue's section (slice 2.5a). Supplied by that module rather than
      // read from here, for the same reason as the profile: it is the module
      // holding the key, and this one has no way to decrypt an address.
      //
      // **This is the third bulk disclosure in the document**, after the
      // decrypted profile address and the sign-in history, and it is one more
      // reason the whole endpoint is audited (ADR 0019). Somebody with several
      // listings has several addresses in this file.
      //
      // **The section arrives with its own truncation flag** rather than as a
      // bare array (slice H2). Catalogue applied the bound, so Catalogue is the
      // only thing that knows whether it bit — inferring it here from a length
      // would be the guess `Paging.probe` exists to remove.
      listings: listings.listings,
      listingsTruncated: listings.truncated,
    };
  }

  /**
   * The caller's own sign-in history.
   *
   * **Not audited, and that is the deliberate difference from `exportFor`.**
   * Reading your own security history is not a disclosure — nothing leaves the
   * platform, and the reader is the subject. Recording it would put a row in
   * the trail every time somebody checked the trail, which grows without bound
   * and buries the entries that matter. The export is audited because it hands
   * over a file; this renders a page.
   *
   * No id parameter, the same reasoning as `/me/profile`: the actor comes from
   * the verified session, so there is no way to address anybody else's.
   */
  async signInsFor(
    userId: string,
    limit: number = DEFAULT_SIGN_IN_LIMIT,
  ): Promise<readonly RecordedAuthenticationEvent[]> {
    return this.authenticationEvents.listFor(userId, boundedSignInLimit(limit));
  }

  /**
   * Act on a request to be deleted.
   *
   * **Order is the decision here** (ADR 0018). Personal data is erased first,
   * then the account is tombstoned. The reverse — tombstone, then erase — means
   * a failure between the two leaves somebody locked out of an account that
   * still holds their address, with no way to ask again. This way a failure
   * leaves the account usable and the request repeatable.
   *
   * Deleting the credential at Clerk happens afterwards, in the web app, which
   * is the only service holding a key that can (ADR 0015). Clerk's own
   * `user.deleted` webhook then arrives and applies against an already-deleted
   * row, which `apply` treats as a success.
   *
   * **Idempotent.** A second request is a success and records nothing new: the
   * state asked for is already the state.
   *
   * The work itself is in `eraseAndTombstone`, shared with the webhook path —
   * see there for why that sharing is not optional.
   */
  async requestDeletion(actor: Actor): Promise<void> {
    const user = await this.users.findById(actor.userId);

    // Already gone, or never existed. Both are the requested state, and both
    // must answer success — a retry after a partial failure has to finish
    // rather than be told it is too late.
    if (user === null) return;
    if (user.deletedAt !== null) return;

    await this.erasure.eraseAndTombstone(user, actor);
  }
}
