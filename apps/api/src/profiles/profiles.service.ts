import { Postcode } from '@platform/core';
import type { MyProfile, ProfileInput, PublicProfile } from '@platform/contracts';
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
  async saveMine(userId: string, input: ProfileInput): Promise<MyProfile> {
    const saved = await this.profiles.save(userId, {
      displayName: input.displayName,
      phone: input.phone,
      address: input.address,
    });

    return toMyProfile(saved);
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
