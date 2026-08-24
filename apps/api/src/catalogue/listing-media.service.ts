import { randomUUID } from 'node:crypto';
import type { Logger } from '@platform/observability';
import { LISTING_MEDIA_LIMIT } from '@platform/contracts';
import type { ListingMediaRefusal, OwnerListingMedia } from '@platform/contracts';
import { ImageRejectedError, prepareImage } from './prepare-image.js';
import { ObjectStoreUnavailableError, SIGNED_URL_TTL_SECONDS } from './object-store.js';
import type { ObjectStore } from './object-store.js';
import type { ListingMediaRecord, ListingMediaStore } from './listing-media-store.js';
import type { ListingStore } from './listing-store.js';

/**
 * A listing's photographs (slice 2.6b-i).
 *
 * **Its own service rather than more methods on `ListingsService`**, which is
 * already 1,575 lines and answers a different question. This one owns three
 * rules and one sequencing problem, and the sequencing problem is the reason to
 * read it: bytes live in two places that cannot be written atomically, so every
 * operation here has to choose which side of a crash to lose.
 *
 * ## The order of operations, and what each choice loses
 *
 * **Adding: objects first, then the row.** A crash between them leaks two
 * objects nothing references — invisible, and recoverable by nothing today. The
 * alternative loses worse: a row written before its bytes exist is a permanently
 * broken photograph in the owner's gallery that they have to notice and delete.
 * Wasted bytes are cheaper than a broken page, and the owner's retry simply
 * works.
 *
 * **Removing: the row first, then the objects.** The reverse, and for the
 * reverse reason. The owner asked for it gone, so the row going is what they
 * are owed; a failed object delete then leaks bytes, which is the recoverable
 * direction. Deleting objects first and failing to delete the row would leave a
 * row pointing at nothing, which is the broken-page failure again.
 *
 * **Erasing: objects first, then rows — the opposite of removing.** Here the
 * bytes are the obligation. A photograph of somebody's garden, driveway or front
 * door is their personal data, and §10.1 requires it gone; the row is only the
 * record of where it is. Deleting rows first would destroy the only handle on
 * bytes that must not survive, with `ObjectStore` deliberately offering no
 * `list` to find them again. Objects first means a failure leaves the row
 * behind and the next attempt finishes the job — which is exactly what
 * `PersonalDataEraser`'s idempotency requirement is for.
 */

/** Why an upload or a reorder was refused. */
export class ListingMediaRefusedError extends Error {
  constructor(
    readonly reason: ListingMediaRefusal,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ListingMediaRefusedError';
    this.cause = cause;
  }
}

export class ListingMediaService {
  constructor(
    private readonly listings: ListingStore,
    private readonly media: ListingMediaStore,
    private readonly objects: ObjectStore,
    private readonly logger: Logger,
  ) {}

  /**
   * This listing's photographs, or null if it is not this owner's.
   *
   * Null rather than an empty array for an unknown listing: an owner with no
   * photographs and a stranger asking about somebody else's listing must not be
   * distinguishable, and `[]` for both would be — the caller turns null into a
   * 404 and `[]` into a 200.
   */
  async listFor(
    listingId: string,
    ownerId: string,
  ): Promise<readonly OwnerListingMedia[] | null> {
    if (!(await this.listings.existsOwnedBy(listingId, ownerId))) return null;

    return this.sign(await this.media.listFor(listingId));
  }

  /**
   * Store a photograph against a listing.
   *
   * Returns null if the listing is not this owner's. Throws
   * `ListingMediaRefusedError` for anything we will not store — never for a
   * merely unlucky file, which is an ordinary refusal rather than a 500.
   */
  async add(
    listingId: string,
    ownerId: string,
    bytes: Buffer,
  ): Promise<OwnerListingMedia | null> {
    if (!(await this.listings.existsOwnedBy(listingId, ownerId))) return null;

    /*
     * The count cap is checked before the image is decoded, deliberately.
     *
     * Decoding and re-encoding a 15 MB photograph twice is by far the most
     * expensive thing on this path, and an owner at their limit would otherwise
     * pay it in full before being told no. It is a cheap indexed read against a
     * set of at most ten.
     *
     * It is checked here and not in the store because a count is not a
     * constraint the database holds — there is no CHECK that can count rows —
     * so this is the only place it exists. Two simultaneous uploads at the limit
     * can therefore both pass; the outcome is eleven photographs rather than a
     * failure, which is a cap doing its job to within one.
     */
    const existing = await this.media.listFor(listingId);
    if (existing.length >= LISTING_MEDIA_LIMIT) {
      throw new ListingMediaRefusedError(
        'too-many-photographs',
        `A listing may have ${String(LISTING_MEDIA_LIMIT)} photographs, and this one already has ${String(existing.length)}`,
      );
    }

    const prepared = await prepareImage(bytes).catch((error: unknown) => {
      // Every refusal `prepareImage` raises is already a closed-union reason, so
      // it is carried through rather than flattened to "bad image" — the owner
      // is told their photograph is too large rather than that it is broken.
      if (error instanceof ImageRejectedError) {
        throw new ListingMediaRefusedError(error.reason, error.message, error);
      }
      throw error;
    });

    const mediaId = randomUUID();
    const displayKey = objectKey(listingId, mediaId, 'display');
    const thumbnailKey = objectKey(listingId, mediaId, 'thumbnail');

    try {
      await this.objects.put(displayKey, prepared.display.bytes, prepared.contentType);
      await this.objects.put(
        thumbnailKey,
        prepared.thumbnail.bytes,
        prepared.contentType,
      );
    } catch (error) {
      if (error instanceof ObjectStoreUnavailableError) {
        /*
         * The first PUT may have succeeded. That object is now unreferenced and
         * nothing will ever collect it — recorded rather than retried, because a
         * cleanup delete against a store that just failed is unlikely to fare
         * better and would double the time the owner waits to be told.
         */
        this.logger.error('Could not store a photograph', {
          listingId,
          reason: 'object-store-unavailable',
        });
        throw new ListingMediaRefusedError(
          'storage-unavailable',
          'The photograph could not be stored. Please try again.',
          error,
        );
      }
      throw error;
    }

    const record = await this.media.append({
      listingId,
      displayKey,
      thumbnailKey,
      contentType: prepared.contentType,
      byteSize: prepared.display.byteSize,
      width: prepared.display.width,
      height: prepared.display.height,
      thumbnailWidth: prepared.thumbnail.width,
      thumbnailHeight: prepared.thumbnail.height,
      sha256: prepared.sha256,
    });

    const [signed] = await this.sign([record]);
    // `sign` maps one record to one projection, so this cannot be undefined —
    // but the compiler cannot see that and a non-null assertion would be a claim
    // rather than a check.
    if (signed === undefined) {
      throw new Error('A stored photograph produced no projection');
    }
    return signed;
  }

  /**
   * Remove a photograph. Null when the listing is not this owner's, false when
   * it holds no such photograph.
   *
   * The two are distinguished because they mean different things to the caller
   * and both are 404 on the wire — but conflating them here would make the
   * service unable to say which, and the tests would stop being able to tell a
   * broken ownership check from a missing row.
   */
  async remove(
    listingId: string,
    ownerId: string,
    mediaId: string,
  ): Promise<boolean | null> {
    if (!(await this.listings.existsOwnedBy(listingId, ownerId))) return null;

    const removed = await this.media.remove(listingId, mediaId);
    if (removed === null) return false;

    await this.discard([removed], 'removed by its owner');
    return true;
  }

  /**
   * Put this listing's photographs in the given order.
   *
   * Null when the listing is not this owner's. Throws
   * `ListingMediaRefusedError` when the ids are not exactly what the listing
   * holds.
   */
  async reorder(
    listingId: string,
    ownerId: string,
    mediaIds: readonly string[],
  ): Promise<readonly OwnerListingMedia[] | null> {
    if (!(await this.listings.existsOwnedBy(listingId, ownerId))) return null;

    const existing = await this.media.listFor(listingId);

    /*
     * Exactly the same set, no more and no less.
     *
     * A partial order is refused rather than applied to the subset, because
     * "put these three first" and "these are all of them" are different
     * instructions and the request cannot say which it meant. Refusing is also
     * what makes the operation safe against a stale tab: an order listing
     * photographs that have since been deleted is one the owner did not mean.
     */
    const held = new Set(existing.map((media) => media.id));
    const asked = new Set(mediaIds);
    const sameSet =
      asked.size === mediaIds.length &&
      held.size === asked.size &&
      [...held].every((id) => asked.has(id));

    if (!sameSet) {
      throw new ListingMediaRefusedError(
        'not-an-image',
        'The order must list exactly this listing’s photographs, once each',
      );
    }

    await this.media.reorder(listingId, mediaIds);
    return this.sign(await this.media.listFor(listingId));
  }

  /**
   * Erase every photograph of these listings — bytes first, then rows.
   *
   * **Called by `ListingsService.eraseFor` before it erases the listings
   * themselves**, and it must stay that way. The cascade from `listings` would
   * remove these rows for a *deleted* listing, but §10.1 keeps a listing a
   * booking references and collapses it instead — so the cascade never fires
   * for those, and their photographs would survive an erasure request.
   *
   * Idempotent, as `PersonalDataEraser` requires: called twice, the second call
   * finds nothing and succeeds.
   */
  async eraseForListings(listingIds: readonly string[]): Promise<void> {
    const media = await this.media.listForListings(listingIds);
    if (media.length === 0) return;

    await this.discard(media, 'erased with its owner’s account');
    await this.media.deleteFor(listingIds);
  }

  /**
   * Delete the bytes behind these records, recording anything that would not go.
   *
   * **A failure here never propagates**, and that is the decision. On the
   * erasure path the caller must still delete the rows or an account deletion —
   * a statutory obligation — would fail on a storage outage. On the owner's
   * delete path the row is already gone and the owner is owed an answer. What is
   * lost either way is bytes nothing references, in a bucket that is
   * deliberately never enumerated, so the log line is the only trace there will
   * ever be. It names the key, because that is the one thing that would let
   * somebody delete it by hand.
   */
  private async discard(
    media: readonly ListingMediaRecord[],
    why: string,
  ): Promise<void> {
    for (const item of media) {
      for (const key of [item.displayKey, item.thumbnailKey]) {
        // `try`/`catch` rather than `.catch()`, which handles a rejection but
        // not a synchronous throw. The port returns a promise, so an
        // implementation that throws is already misbehaving — and this is the
        // erasure path, where a statutory obligation must not fail because one
        // did.
        try {
          await this.objects.delete(key);
        } catch (error) {
          this.logger.error('A stored photograph could not be deleted', {
            key,
            why,
            reason:
              error instanceof ObjectStoreUnavailableError
                ? 'object-store-unavailable'
                : 'unexpected',
          });
        }
      }
    }
  }

  /**
   * Turn stored records into something a browser can fetch.
   *
   * Two signed URLs per photograph, minted per response and valid for minutes.
   * They are not addresses and nothing may store them — see
   * `ListingMediaImage`.
   */
  private async sign(
    media: readonly ListingMediaRecord[],
  ): Promise<readonly OwnerListingMedia[]> {
    return Promise.all(
      media.map(async (item) => ({
        id: item.id,
        position: item.position,
        display: {
          url: await this.objects.signedUrl(item.displayKey, SIGNED_URL_TTL_SECONDS),
          width: item.width,
          height: item.height,
        },
        thumbnail: {
          url: await this.objects.signedUrl(item.thumbnailKey, SIGNED_URL_TTL_SECONDS),
          width: item.thumbnailWidth,
          height: item.thumbnailHeight,
        },
      })),
    );
  }
}

/**
 * Where a photograph's bytes live.
 *
 * `listings/<listingId>/<mediaId>/<rendition>.webp`. The listing id is public —
 * it is in the URL of the page — but the media id is a fresh UUID, so a signed
 * URL that leaks discloses nothing about the photographs beside it. Access never
 * rests on a key being unguessable; it rests on the bucket being private and the
 * URL being signed and short-lived. The prefix exists so that a human looking at
 * the bucket during an incident can tell what they are looking at.
 */
function objectKey(
  listingId: string,
  mediaId: string,
  rendition: 'display' | 'thumbnail',
): string {
  return `listings/${listingId}/${mediaId}/${rendition}.webp`;
}
