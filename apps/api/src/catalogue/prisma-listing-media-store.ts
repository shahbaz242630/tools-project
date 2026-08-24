import type { PrismaClient } from '@platform/database';
import { MODERATION_STATES } from '@platform/contracts';
import type { ModerationState } from '@platform/contracts';
import type {
  ListingMediaRecord,
  ListingMediaStore,
  NewListingMedia,
} from './listing-media-store.js';

/**
 * `listing_media` in Postgres.
 *
 * Small, because the table is: no encryption, no joins, no raw SQL. What is
 * worth reading here is the ordering — the total order the missing unique
 * constraint depends on — and `reorder`, which is the one operation that has to
 * be a transaction.
 */
export class PrismaListingMediaStore implements ListingMediaStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listFor(listingId: string): Promise<readonly ListingMediaRecord[]> {
    const rows = await this.prisma.listingMedia.findMany({
      where: { listingId },
      orderBy: inOwnersOrder(),
    });

    return rows.map(toRecord);
  }

  async listForListings(
    listingIds: readonly string[],
  ): Promise<readonly ListingMediaRecord[]> {
    // An empty `in` is a query that returns nothing, but it is still a round
    // trip, and erasure calls this for every account including the ones with no
    // listings at all.
    if (listingIds.length === 0) return [];

    const rows = await this.prisma.listingMedia.findMany({
      where: { listingId: { in: [...listingIds] } },
      orderBy: inOwnersOrder(),
    });

    return rows.map(toRecord);
  }

  async append(media: NewListingMedia): Promise<ListingMediaRecord> {
    /*
     * Read the highest position, then write one past it.
     *
     * **Not serialisable, and that is a decision rather than an oversight.** Two
     * uploads racing can read the same maximum and both write it. Making it safe
     * would need either a unique constraint — which the migration explains this
     * table cannot have, because it would make a reorder inexpressible — or a
     * lock held across an image encode and a network PUT, which is the wrong
     * thing to hold a lock across.
     *
     * What makes the race harmless is that a duplicate position is not an error
     * here: both rows exist, both are reachable, and `inOwnersOrder` breaks the
     * tie by `createdAt` and then `id`, so every reader sees the same order. The
     * owner sees two photographs in an order they did not choose and drags one,
     * which is the whole cost.
     */
    const last = await this.prisma.listingMedia.findFirst({
      where: { listingId: media.listingId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const row = await this.prisma.listingMedia.create({
      data: {
        listingId: media.listingId,
        position: last === null ? 0 : last.position + 1,
        displayKey: media.displayKey,
        thumbnailKey: media.thumbnailKey,
        contentType: media.contentType,
        byteSize: media.byteSize,
        width: media.width,
        height: media.height,
        thumbnailWidth: media.thumbnailWidth,
        thumbnailHeight: media.thumbnailHeight,
        sha256: media.sha256,
      },
    });

    return toRecord(row);
  }

  async remove(listingId: string, mediaId: string): Promise<ListingMediaRecord | null> {
    /*
     * Read scoped by **both** ids, then delete by primary key, in one
     * transaction.
     *
     * The listing is what proves ownership — a media row has no owner column —
     * so matching on the media id alone would delete somebody else's photograph
     * for anyone who guessed a UUID. The read has to happen first and inside the
     * transaction, because the caller needs the storage keys to delete the bytes
     * and they are unreadable once the row is gone.
     */
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.listingMedia.findFirst({
        where: { id: mediaId, listingId },
      });

      if (row === null) return null;

      await tx.listingMedia.delete({ where: { id: row.id } });
      return toRecord(row);
    });
  }

  async reorder(listingId: string, mediaIds: readonly string[]): Promise<void> {
    /*
     * One transaction, every row rewritten.
     *
     * Rewriting all of them rather than only the ones that moved: the set is
     * capped at ten, so the saving is nothing, and "only the ones that moved" is
     * a diff whose edge cases are exactly where an ordering bug lives.
     *
     * Each update is scoped by `listingId` as well as by media id, so a caller
     * that slipped somebody else's media id past the service's validation
     * changes nothing rather than reordering a stranger's listing.
     */
    await this.prisma.$transaction(
      mediaIds.map((id, position) =>
        this.prisma.listingMedia.updateMany({
          where: { id, listingId },
          data: { position },
        }),
      ),
    );
  }

  async deleteFor(listingIds: readonly string[]): Promise<void> {
    if (listingIds.length === 0) return;

    await this.prisma.listingMedia.deleteMany({
      where: { listingId: { in: [...listingIds] } },
    });
  }
}

/**
 * The total order every read uses.
 *
 * Three keys, and the second two are what make the absent unique constraint on
 * `(listingId, position)` safe: `position` alone stops being a total order the
 * moment two rows share one, and an unstable sort would show a listing's
 * photographs in a different sequence on every refresh.
 *
 * **A function returning a fresh array rather than a shared `as const`
 * constant.** Prisma's generated `orderBy` type is a *mutable* array, so a
 * `readonly` tuple cannot be assigned to it — while dropping `as const`
 * altogether widens `'asc'` to `string`, which it also refuses. Per-property
 * `as const` keeps the literals without freezing the array, and a fresh array
 * per call means no caller can reorder the ordering.
 */
function inOwnersOrder() {
  return [
    { position: 'asc' as const },
    { createdAt: 'asc' as const },
    { id: 'asc' as const },
  ];
}

interface MediaRow {
  id: string;
  listingId: string;
  position: number;
  displayKey: string;
  thumbnailKey: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
  sha256: string;
  moderationState: string;
  createdAt: Date;
}

function toRecord(row: MediaRow): ListingMediaRecord {
  return {
    id: row.id,
    listingId: row.listingId,
    position: row.position,
    displayKey: row.displayKey,
    thumbnailKey: row.thumbnailKey,
    contentType: row.contentType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    thumbnailWidth: row.thumbnailWidth,
    thumbnailHeight: row.thumbnailHeight,
    sha256: row.sha256,
    moderationState: asModerationState(row.moderationState),
    createdAt: row.createdAt,
  };
}

/**
 * The column is `TEXT` with the vocabulary in code and no `CHECK` — slice 2.4a's
 * convention — so this adapter is what makes the vocabulary true.
 *
 * Throwing rather than defaulting to `visible`: a value we do not recognise means
 * the database disagrees with the code about what states exist, and quietly
 * showing the photograph is the one outcome nobody would choose if asked.
 */
function asModerationState(value: string): ModerationState {
  if ((MODERATION_STATES as readonly string[]).includes(value)) {
    return value as ModerationState;
  }

  throw new Error(
    `listing_media.moderationState holds ${value}, which is not one of ${MODERATION_STATES.join(', ')}`,
  );
}
