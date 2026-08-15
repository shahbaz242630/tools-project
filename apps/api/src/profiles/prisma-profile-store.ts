import { Postcode } from '@platform/core';
import { OWNER_STATUSES } from '@platform/contracts';
import type { OwnerStatus } from '@platform/contracts';
import type { PrismaClient } from '@platform/database';
import type { FieldEncryptor } from '../encryption/field-encryption.js';
import { ProfileConflictError } from './profile-store.js';
import type {
  AddressDetail,
  ProfileChanges,
  ProfileStore,
  StoredProfile,
} from './profile-store.js';

/**
 * Postgres-backed profiles, with the address detail encrypted at rest.
 *
 * Prisma is our own persistence layer rather than a third-party provider, so it
 * is imported directly — the BRD §5 adapter rule exists to keep vendor SDKs
 * replaceable, and the database is not a vendor we are hedging against.
 *
 * **Encryption lives here and nowhere else.** The port above speaks plaintext,
 * so no caller can forget to encrypt on a path someone adds later; the only way
 * an address reaches the database is through `save`, and the only way one comes
 * back is through `toStoredProfile`.
 */

/** Prisma reports a unique-constraint violation as `P2002`. See the identity store. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

/**
 * What goes inside the encrypted envelope.
 *
 * The identifying lines, and only those. `town` and `outwardCode` stay in clear
 * columns because they are publishable, and `postcode` stays in clear because
 * Phase 3 has to geocode it — encrypting a value the search index needs would
 * mean decrypting every row to answer "what is near me".
 */
interface EncryptedDetail {
  readonly line1: string;
  readonly line2: string | null;
}

interface ProfileRow {
  id: string;
  userId: string;
  displayName: string;
  phone: string | null;
  /** Widened to `string`, and narrowed by `asOwnerStatus` on the way out. */
  ownerStatus: string | null;
  updatedAt: Date;
}

interface AddressRow {
  postcode: string;
  town: string;
  encryptedDetail: string;
}

export class PrismaProfileStore implements ProfileStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryptor: FieldEncryptor,
  ) {}

  async find(userId: string): Promise<StoredProfile | null> {
    const [profile, address] = await Promise.all([
      this.prisma.profile.findUnique({ where: { userId } }),
      this.prisma.address.findUnique({ where: { userId } }),
    ]);

    if (profile === null) return null;

    return this.toStoredProfile(profile, address);
  }

  /**
   * One query for a whole page of owners.
   *
   * **No `address` join, unlike `find`.** The caller wants one enum per person
   * and this module's rule is to hand out the narrowest fact that answers the
   * question — reading the encrypted address to decide whether somebody is a
   * private individual would decrypt a home address per search result, which is
   * both the slowest and the least defensible way to answer it.
   *
   * An empty input is answered without asking the database: `IN ()` is not
   * something to make Postgres parse, and a page with no results is ordinary.
   */
  async findOwnerStatuses(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, OwnerStatus>> {
    if (userIds.length === 0) return new Map();

    const rows = await this.prisma.profile.findMany({
      where: { userId: { in: [...new Set(userIds)] } },
      select: { userId: true, ownerStatus: true },
    });

    const statuses = new Map<string, OwnerStatus>();
    for (const row of rows) {
      const status = asOwnerStatus(row.ownerStatus, row.userId);
      // Undeclared is absent rather than present-and-null, which is what the
      // port promises and what stops a caller reading "no answer" as an answer.
      if (status !== null) statuses.set(row.userId, status);
    }

    return statuses;
  }

  /**
   * Write the profile and the address as one unit.
   *
   * In a transaction because they are two tables holding one person's answer to
   * one form. Without it, a failure between the two writes leaves a saved name
   * beside a stale address — and the person is looking at a page that says it
   * saved.
   */
  async save(userId: string, changes: ProfileChanges): Promise<StoredProfile> {
    const detail =
      changes.address === null
        ? null
        : this.encrypt(userId, {
            line1: changes.address.line1,
            line2: changes.address.line2,
          });

    try {
      const [profile, address] = await this.prisma.$transaction(async (tx) => {
        const written = await tx.profile.upsert({
          where: { userId },
          create: {
            userId,
            displayName: changes.displayName,
            phone: changes.phone,
            ownerStatus: changes.ownerStatus,
          },
          update: {
            displayName: changes.displayName,
            phone: changes.phone,
            // Written on every save, including when it is null. The form posts
            // the whole profile, so an absent answer means the person cleared
            // it — the same reasoning the address delete below follows.
            ownerStatus: changes.ownerStatus,
          },
        });

        if (changes.address === null || detail === null) {
          // Clearing the address is a deliberate delete rather than a no-op:
          // the form sends the whole profile, so an absent address means the
          // person removed it. `deleteMany` rather than `delete` because there
          // may be no row, and a missing row is not an error here.
          await tx.address.deleteMany({ where: { userId } });
          return [written, null] as const;
        }

        const postcode = Postcode.parse(changes.address.postcode);

        const stored = await tx.address.upsert({
          where: { userId },
          create: {
            userId,
            postcode,
            // Derived on write, from the same value that is stored. This is the
            // one place the two can diverge, so it is the one place that
            // derives one from the other.
            outwardCode: Postcode.outwardCode(postcode),
            town: changes.address.town,
            encryptedDetail: detail,
          },
          update: {
            postcode,
            outwardCode: Postcode.outwardCode(postcode),
            town: changes.address.town,
            encryptedDetail: detail,
          },
        });

        return [written, stored] as const;
      });

      return this.toStoredProfile(profile, address);
    } catch (error) {
      // Two tabs saving a brand-new profile at once. The row now exists, so
      // re-reading is the correct response — surfacing a 500 for a write that
      // succeeded is worse than the extra query.
      if (isUniqueViolation(error)) throw new ProfileConflictError(error);
      throw error;
    }
  }

  /**
   * Remove the profile and the address, as one unit.
   *
   * In a transaction because a half-erased person is the worst outcome
   * available here: an address removed while the display name survives looks
   * like the request was honoured, and nothing will ever revisit it.
   *
   * `deleteMany` rather than `delete` on both, because a missing row is not an
   * error — somebody who never filled in a profile is still entitled to ask for
   * erasure, and a retry after a partial failure must be able to finish.
   */
  async erase(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.address.deleteMany({ where: { userId } });
      await tx.profile.deleteMany({ where: { userId } });
    });
  }

  /**
   * The user id is bound into the ciphertext as additional authenticated data.
   *
   * It means an encrypted address copied onto another person's row fails to
   * decrypt rather than being served as theirs — an attack available to anyone
   * with database write access but no key.
   */
  private encrypt(userId: string, detail: EncryptedDetail): string {
    return this.encryptor.encrypt(JSON.stringify(detail), userId);
  }

  private toStoredProfile(
    profile: ProfileRow,
    address: AddressRow | null,
  ): StoredProfile {
    return {
      id: profile.id,
      userId: profile.userId,
      displayName: profile.displayName,
      phone: profile.phone,
      address: address === null ? null : this.decrypt(profile.userId, address),
      ownerStatus: asOwnerStatus(profile.ownerStatus, profile.userId),
      updatedAt: profile.updatedAt,
    };
  }

  private decrypt(userId: string, address: AddressRow): AddressDetail {
    const detail = JSON.parse(
      this.encryptor.decrypt(address.encryptedDetail, userId),
    ) as EncryptedDetail;

    return {
      line1: detail.line1,
      line2: detail.line2,
      town: address.town,
      postcode: address.postcode,
    };
  }
}

/**
 * The declared status, narrowed on the way out.
 *
 * **Throws rather than reading leniently**, the treatment `asStatus` and
 * `asModerationState` get in the catalogue and for a stronger reason. Falling
 * back to `private_owner` would be the worst available guess: it is the answer a
 * public page renders as a legal disclosure, so a value this build does not
 * recognise — a row from a newer version, a fixture, a hand-edit — would have us
 * telling a renter something untrue about who they are dealing with.
 *
 * Null is a real value and passes through: it means the person has not answered,
 * which the publication gate refuses on.
 */
function asOwnerStatus(value: string | null, userId: string): OwnerStatus | null {
  if (value === null) return null;
  if ((OWNER_STATUSES as readonly string[]).includes(value)) {
    return value as OwnerStatus;
  }
  throw new Error(
    `Profile for ${userId} has an owner status this build does not know: ${value}`,
  );
}
