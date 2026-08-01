import { Postcode } from '@platform/core';
import type {
  AdminProfile,
  ExportedProfile,
  MyProfile,
  ProfileInput,
  PublicProfile,
} from '@platform/contracts';
import type { Actor } from '../audit/audit-log.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccountLookup, ProfileStore, StoredProfile } from './profile-store.js';

/**
 * The profiles module's application service.
 *
 * It holds one rule, and the rule is the module: **the same row produces two
 * different answers depending on who is asking.** Everything else here is
 * plumbing around keeping those two projections apart.
 *
 * The projections are built here rather than in the controllers so that no
 * route can assemble its own. A controller that hand-picks fields is one commit
 * away from picking a field it should not, and the diff reads like a template
 * change rather than a disclosure.
 */
export class ProfilesService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly accounts: AccountLookup,
    private readonly audit: AuditService,
  ) {}

  /** The caller's own profile, in full. Null until they first save one. */
  async findMine(userId: string): Promise<MyProfile | null> {
    const stored = await this.profiles.find(userId);
    return stored === null ? null : toMyProfile(stored);
  }

  /**
   * Create or replace the caller's profile.
   *
   * Takes the user id from the guard-resolved session, never from the request
   * body. There is no code path here that writes a profile belonging to anyone
   * but the caller, which is a stronger guarantee than an ownership check —
   * a check can be forgotten on a new route, an absent parameter cannot.
   */
  async saveMine(actor: Actor, input: ProfileInput): Promise<MyProfile> {
    // Read before writing, for two reasons that happen to coincide: the audit
    // entry needs the prior state to digest, and whether one existed is what
    // distinguishes a creation from an edit. Neither is worth a second query.
    const before = await this.profiles.find(actor.userId);

    const saved = await this.profiles.save(actor.userId, {
      displayName: input.displayName,
      phone: input.phone,
      address: input.address,
    });

    // Awaited, and its failure is deliberately not caught. A profile saved with
    // no record of who changed it is the outcome the audit log exists to
    // prevent, and this table shares a database with the row just written — a
    // failure here means that write would have failed too. ADR 0017.
    await this.audit.record({
      actor,
      action: before === null ? 'profile.created' : 'profile.updated',
      targetType: 'profile',
      targetId: saved.id,
      // `undefined` rather than null for a creation: there was no prior state,
      // which is different from a prior state that was empty.
      before: before === null ? undefined : auditableState(before),
      after: auditableState(saved),
    });

    return toMyProfile(saved);
  }

  /**
   * This module's contribution to a data export.
   *
   * The address arrives **decrypted**, which is the whole reason this lives
   * here rather than in the module assembling the document: the encryptor
   * belongs to the profiles store, and handing it out so somebody else could
   * decrypt would put the key in a second place.
   *
   * Reuses the owner's own projection, so the export cannot drift from what a
   * person already sees on their profile page — two shapes for the same data
   * is how one of them ends up missing a field.
   */
  async exportFor(userId: string): Promise<ExportedProfile> {
    const stored = await this.profiles.find(userId);
    return stored === null ? null : toMyProfile(stored);
  }

  /**
   * This module's contribution to the administrative account view.
   *
   * **The narrowest projection here that carries a name**, and the narrowing is
   * the point. `toMyProfile` gives the owner their street lines and phone
   * number; this gives support neither. What support is actually asked is
   * whether a profile exists, whether it is complete enough to list or book
   * (BRD §8.1 gates that on contact details), and roughly where the person is —
   * and all three are answerable without disclosing either (ADR 0022).
   *
   * Built here rather than by the identity module that assembles the view, for
   * the same reason `exportFor` is: the address lives behind this module's
   * encryptor, and a projection assembled elsewhere is a projection whose rules
   * live away from the data they constrain.
   *
   * Unlike `findPublic`, this does **not** check that the account is active.
   * Support is most often asked about an account precisely because something
   * has gone wrong with it, and the deletion state is Identity's to report.
   */
  async adminSummaryFor(userId: string): Promise<AdminProfile> {
    const stored = await this.profiles.find(userId);
    if (stored === null) return null;

    return {
      displayName: stored.displayName,

      // Whether a number is saved, never the digits. Nothing has verified it,
      // so it is not a fact about the person — and the question support has is
      // "did they give us one", which the boolean answers completely.
      hasPhone: stored.phone !== null,

      address:
        stored.address === null
          ? null
          : {
              town: stored.address.town,
              // The district, derived from the stored postcode the same way the
              // public projection derives it. Never the full code, and never a
              // street line — those reach exactly one response, the export.
              outwardCode: Postcode.outwardCode(stored.address.postcode),
            },

      updatedAt: stored.updatedAt.toISOString(),
    };
  }

  /**
   * Remove everything this module holds about somebody.
   *
   * Called through a port by the identity module when a deletion is requested —
   * Profiles & Trust owns this data, so Profiles & Trust is what erases it. The
   * alternative, letting Identity reach into these tables, is the cross-module
   * write CLAUDE.md bans and would put personal-data handling in two places.
   *
   * It writes its own audit entry, for the same reason: the module that knows
   * what was removed is the one that can say so.
   */
  async eraseFor(actor: Actor): Promise<void> {
    const before = await this.profiles.find(actor.userId);

    await this.profiles.erase(actor.userId);

    // Nothing to record when there was nothing to erase. An entry claiming a
    // profile was removed from somebody who never made one is a false line in
    // a trail that is retained for six years.
    if (before === null) return;

    await this.audit.record({
      actor,
      action: 'profile.erased',
      targetType: 'profile',
      targetId: before.id,
      before: auditableState(before),
      // Absent, not empty. There is no resulting state — the row is gone.
      after: undefined,
    });
  }

  /**
   * What a stranger may see.
   *
   * Null when the account does not exist, has been deleted, or has no profile
   * yet — one answer for all three, so a caller cannot use this endpoint to
   * learn which user ids are real. Enumerating accounts is the first step of
   * most scraping, and the ids are UUIDs precisely so it cannot be done by
   * counting.
   */
  async findPublic(userId: string): Promise<PublicProfile | null> {
    // Account first. A profile row can outlive its owner's deletion — the
    // erasure slice that removes it is still to come — so checking the profile
    // alone would keep publishing a deleted person's name.
    const account = await this.accounts.findActive(userId);
    if (account === null) return null;

    const stored = await this.profiles.find(userId);
    if (stored === null) return null;

    return {
      id: account.id,
      displayName: stored.displayName,

      // Derived at the boundary from the stored district, never from the full
      // postcode. `outwardCode` is its own column exactly so this line cannot
      // be the place someone forgets to truncate.
      outwardCode:
        stored.address === null ? null : Postcode.outwardCode(stored.address.postcode),
      town: stored.address?.town ?? null,

      memberSince: toMonth(account.createdAt),
    };
  }
}

/**
 * The part of a profile whose change is worth recording.
 *
 * **`updatedAt` is deliberately excluded.** It moves on every save, so
 * including it would make two saves of identical content produce different
 * digests — and the audit log would claim a change every time somebody opened
 * the form and pressed save without editing anything. That would destroy the
 * one thing comparing digests is for.
 */
function auditableState(profile: StoredProfile): unknown {
  return {
    displayName: profile.displayName,
    phone: profile.phone,
    address: profile.address,
  };
}

/** The owner's view: everything, with timestamps as ISO strings for the wire. */
function toMyProfile(stored: StoredProfile): MyProfile {
  return {
    displayName: stored.displayName,
    phone: stored.phone,
    address: stored.address,
    updatedAt: stored.updatedAt.toISOString(),
  };
}

/**
 * `YYYY-MM`, in UTC.
 *
 * Month precision because an exact signup timestamp is a correlation handle for
 * linking accounts across services, and "member since July 2026" is the whole
 * of what a renter is judging. UTC rather than the platform timezone: this is
 * account metadata, not a rental period, and BRD §6.1 reserves local-time
 * arithmetic for bookings. The worst case is that somebody who signed up at
 * half past midnight on 1 August in British Summer Time reads as July, which
 * changes nothing for anyone.
 */
function toMonth(instant: Date): string {
  return instant.toISOString().slice(0, 7);
}
