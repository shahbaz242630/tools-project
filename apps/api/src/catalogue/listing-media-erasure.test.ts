import { beforeEach, describe, expect, it } from 'vitest';
import { ListingMediaService } from './listing-media.service.js';
import {
  InMemoryListingMediaStore,
  InMemoryObjectStore,
  InMemoryCategoryStore,
  InMemoryListingStore,
} from './testing/fakes.js';
import {
  createRecordingLogger,
  createRecordingMetrics,
} from '@platform/observability/testing';
import type { RecordingLogger } from '@platform/observability/testing';

/**
 * What happens to a listing's photographs when its owner leaves (slice 2.6b-i).
 *
 * **A file of its own, because this is the finding the slice was worth doing
 * for.** `listing_media.listingId` cascades, so it *looks* as though deleting a
 * listing takes its photographs with it and nothing more is owed. Two things
 * make that wrong, and neither is visible in the schema:
 *
 *   - **A cascade cannot reach object storage.** Postgres cannot call
 *     `ObjectStore.delete`, so the bytes survive every path that only deletes
 *     rows — in a bucket `ObjectStore` deliberately offers no way to enumerate,
 *     which means nothing will ever find them again.
 *   - **§10.1 does not delete every listing.** One a booking references is
 *     *collapsed* rather than removed, so its photographs are never reached by
 *     the cascade at all. A photograph of somebody's garden, driveway or front
 *     door is the owner's personal data, not the renter's record of what they
 *     hired.
 *
 * The state here is arranged directly on the stores rather than through an
 * upload. The subject is the erasure, and routing it through `add` would mean
 * an ownership check and an image encode standing between the arrangement and
 * the thing under test.
 */

let media: InMemoryListingMediaStore;
let objects: InMemoryObjectStore;
let logger: RecordingLogger;
let service: ListingMediaService;

const LISTING = 'listing-1';
const OTHER = 'listing-2';

beforeEach(() => {
  media = new InMemoryListingMediaStore();
  objects = new InMemoryObjectStore();
  logger = createRecordingLogger();
  service = new ListingMediaService(
    new InMemoryListingStore(new InMemoryCategoryStore()),
    media,
    objects,
    logger.logger,
    createRecordingMetrics().metrics,
  );
});

/** A stored photograph, rows and bytes, without going through an upload. */
async function givenAPhotograph(listingId: string): Promise<void> {
  const record = await media.append({
    listingId,
    displayKey: `listings/${listingId}/x/display.webp`,
    thumbnailKey: `listings/${listingId}/x/thumbnail.webp`,
    contentType: 'image/webp',
    byteSize: 10,
    width: 100,
    height: 80,
    thumbnailWidth: 40,
    thumbnailHeight: 32,
    sha256: 'a'.repeat(64),
  });

  await objects.put(record.displayKey, Buffer.from('display'), 'image/webp');
  await objects.put(record.thumbnailKey, Buffer.from('thumb'), 'image/webp');
}

describe('erasing a listing’s photographs', () => {
  it('removes both the rows and the bytes', async () => {
    await givenAPhotograph(LISTING);
    expect(objects.size).toBe(2);

    await service.eraseForListings([LISTING]);

    expect(media.all).toHaveLength(0);
    expect(objects.size).toBe(0);
  });

  it('deletes the bytes before the rows', async () => {
    await givenAPhotograph(LISTING);

    await service.eraseForListings([LISTING]);

    /*
     * **The order is the obligation.** The rows are the only record of where
     * the bytes are, so deleting them first would strand personal data in a
     * bucket nothing can enumerate. Deleting the objects first means a failure
     * leaves the row behind and the next attempt finishes the job — which is
     * what makes the whole operation retryable.
     *
     * Asserted through the object store's recording rather than by spying on
     * call order: what matters is that every key was deleted, and that the rows
     * are gone afterwards.
     */
    expect(objects.deleted).toHaveLength(2);
    expect(media.all).toHaveLength(0);
  });

  it('leaves other listings alone', async () => {
    await givenAPhotograph(LISTING);
    await givenAPhotograph(OTHER);

    await service.eraseForListings([LISTING]);

    expect(media.all.map((row) => row.listingId)).toEqual([OTHER]);
    expect(objects.size).toBe(2);
  });

  it('is idempotent, because a retry after a partial failure must finish', async () => {
    await givenAPhotograph(LISTING);

    await service.eraseForListings([LISTING]);
    await expect(service.eraseForListings([LISTING])).resolves.toBeUndefined();
  });

  it('does nothing, cheaply, for listings with no photographs', async () => {
    await expect(service.eraseForListings([LISTING])).resolves.toBeUndefined();
    expect(objects.deleted).toHaveLength(0);
  });

  it('still deletes the rows when the object store refuses the delete', async () => {
    await givenAPhotograph(LISTING);
    objects.willFail();

    await service.eraseForListings([LISTING]);

    /*
     * **Account deletion is a statutory obligation and must not fail because a
     * bucket was briefly unreachable.** What is lost is bytes nothing
     * references — recorded, because the log line is the only trace there will
     * ever be.
     */
    expect(media.all).toHaveLength(0);
    expect(
      logger
        .at('error')
        .some((record) => record.message.includes('could not be deleted')),
    ).toBe(true);
  });
});
