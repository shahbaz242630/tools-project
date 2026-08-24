import type { ListingMediaImage, PublicListingMedia } from '@platform/contracts';
import { SIGNED_URL_TTL_SECONDS } from './object-store.js';
import type { ObjectStore } from './object-store.js';
import type { ListingImageRecord, PublicListingMediaRecord } from './listing-store.js';

/**
 * Turns stored object keys into URLs a browser may fetch (slice 2.6b-ii).
 *
 * **A collaborator of its own rather than `ObjectStore` injected wherever a
 * photograph is rendered, and the reason is least authority.** `ObjectStore`
 * offers `put` and `delete` beside `signedUrl`. `ListingsService` renders
 * photographs and must never write or destroy one, so handing it the whole port
 * would give the class that serves the public every capability the bucket has.
 * This exposes one verb.
 *
 * **It is also the second reader of a rule that was already written down once.**
 * `ListingMediaService` had a private `sign` doing exactly this for the owner's
 * projection; a second copy in the public path is how the TTL comes to differ
 * between the two, and how one of them keeps signing after the other stops.
 *
 * **No caching, deliberately.** A signed URL expires, so a cache keyed by object
 * key would serve a dead one to somebody after fifteen minutes — a broken image
 * with nothing in any log. Presigning is a local HMAC with no network call, so
 * there is nothing to save: signing twenty thumbnails for a results page costs
 * twenty hashes.
 */
export class ListingImageSigner {
  constructor(private readonly objects: ObjectStore) {}

  /**
   * One rendition, or null in, null out.
   *
   * The null passthrough is what lets a caller sign an absent thumbnail without
   * a branch at every call site — and most listings have no photograph, so the
   * absent case is the common one rather than the exception.
   */
  async sign(image: ListingImageRecord | null): Promise<ListingMediaImage | null> {
    return image === null ? null : this.signOne(image);
  }

  /**
   * A listing's whole gallery, in the order it was given.
   *
   * **`Promise.all` rather than a sequential loop**, because presigning is
   * local: ten signatures are ten hashes and awaiting them one at a time would
   * be ceremony. Order is preserved by `map`, which matters — the array order
   * *is* the owner's order, and there is no position field to restore it from.
   */
  async signAll(
    media: readonly PublicListingMediaRecord[],
  ): Promise<readonly PublicListingMedia[]> {
    return Promise.all(
      media.map(async (item) => ({
        id: item.id,
        display: await this.signOne(item.display),
        thumbnail: await this.signOne(item.thumbnail),
      })),
    );
  }

  /**
   * The signing itself, over a rendition that is definitely there.
   *
   * **Split from `sign` so a gallery needs no cast.** Every stored row has both
   * renditions, so `signAll` is calling something that cannot return null — and
   * expressing that with `as ListingMediaImage` would be an assertion about
   * data placed exactly where a future nullable column would slip past it. A
   * second method says the same thing in the type system, where it is checked.
   */
  private async signOne(image: ListingImageRecord): Promise<ListingMediaImage> {
    return {
      url: await this.objects.signedUrl(image.key, SIGNED_URL_TTL_SECONDS),
      width: image.width,
      height: image.height,
    };
  }
}
