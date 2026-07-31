/**
 * Test doubles for the profiles module.
 *
 * Behavioural, not recording spies — the same rule the identity fakes follow.
 * A double that merely stores what it was handed lets a test pass while the
 * mechanism under it is broken, and this project has paid for that lesson once
 * already with the correlation logger.
 *
 * So `InMemoryProfileStore` enforces the one-profile-per-user constraint and
 * replaces rather than merges on save, because both are behaviours the service
 * depends on.
 */

import { Time } from '@platform/core';
import type {
  Account,
  AccountLookup,
  ProfileChanges,
  ProfileStore,
  StoredProfile,
} from '../profile-store.js';
import { createAuditFakes } from '../../audit/testing/fakes.js';
import type { AuditFakes } from '../../audit/testing/fakes.js';
import { ProfilesService } from '../profiles.service.js';

export class InMemoryProfileStore implements ProfileStore {
  private readonly rows = new Map<string, StoredProfile>();
  private nextId = 1;

  /** Deterministic ids: a failing assertion should name a stable value. */
  private mintId(): string {
    return `00000000-0000-4000-9000-${String(this.nextId++).padStart(12, '0')}`;
  }

  /** Fails the next save, to exercise the paths above it. */
  private failure: Error | null = null;

  failNextSave(error: Error): this {
    this.failure = error;
    return this;
  }

  seed(profile: StoredProfile): this {
    this.rows.set(profile.userId, profile);
    return this;
  }

  all(): readonly StoredProfile[] {
    return [...this.rows.values()];
  }

  find(userId: string): Promise<StoredProfile | null> {
    return Promise.resolve(this.rows.get(userId) ?? null);
  }

  erase(userId: string): Promise<void> {
    // A real removal, and idempotent — deleting what is not there is a success.
    this.rows.delete(userId);
    return Promise.resolve();
  }

  save(userId: string, changes: ProfileChanges): Promise<StoredProfile> {
    if (this.failure !== null) {
      const error = this.failure;
      this.failure = null;
      return Promise.reject(error);
    }

    // Replace, not merge. The real store does the same, and a fake that merged
    // would let a test pass while a cleared phone number silently survived.
    const saved: StoredProfile = {
      // Kept across saves — an edit does not replace the row, so the audit
      // trail for a profile has one stable target.
      id: this.rows.get(userId)?.id ?? this.mintId(),
      userId,
      displayName: changes.displayName,
      phone: changes.phone,
      address: changes.address,
      updatedAt: Time.nowUtc(),
    };

    this.rows.set(userId, saved);
    return Promise.resolve(saved);
  }
}

export class InMemoryAccountLookup implements AccountLookup {
  private readonly accounts = new Map<string, Account>();

  /**
   * Fixed date rather than `new Date()`: "member since" is rendered from it,
   * and a test asserting the month must not depend on when the suite runs.
   */
  add(id: string, createdAt = Time.fromIsoUtc('2026-07-15T09:00:00.000Z')): this {
    this.accounts.set(id, { id, createdAt });
    return this;
  }

  /** Removes the account, standing in for deletion as well as absence. */
  remove(id: string): this {
    this.accounts.delete(id);
    return this;
  }

  findActive(userId: string): Promise<Account | null> {
    return Promise.resolve(this.accounts.get(userId) ?? null);
  }
}

export interface ProfileFakes {
  readonly profiles: InMemoryProfileStore;
  readonly accounts: InMemoryAccountLookup;
  readonly service: ProfilesService;
  /** Exposed so a test can assert what the module recorded. */
  readonly audit: AuditFakes;
}

/**
 * A complete profiles module backed by fakes, shaped to drop straight into
 * `AppModule.register` — so a test can boot the real application, with real
 * routing and the real guard, without Postgres.
 */
export function createProfileFakes(audit = createAuditFakes()): ProfileFakes {
  const profiles = new InMemoryProfileStore();
  const accounts = new InMemoryAccountLookup();
  return {
    profiles,
    accounts,
    audit,
    service: new ProfilesService(profiles, accounts, audit.service),
  };
}
