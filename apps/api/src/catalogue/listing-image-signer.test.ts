import { describe, expect, it } from 'vitest';
import { ListingImageSigner } from './listing-image-signer.js';
import { MemoryObjectStore } from './memory-object-store.js';
import { SIGNED_URL_TTL_SECONDS } from './object-store.js';
import type { PublicListingMediaRecord } from './listing-store.js';

/**
 * Object keys turned into URLs a browser may fetch (slice 2.6b-ii).
 *
 * `MemoryObjectStore` signs without a lookup, exactly as the real one does —
 * presigning is arithmetic over a key and a credential, not a question asked of
 * the bucket — so these tests exercise the same control flow production takes.
 */
describe('ListingImageSigner', () => {
  const media = (over: Partial<PublicListingMediaRecord> = {}) => ({
    id: '2c9f0a1e-3b4d-4c5e-8f6a-7b8c9d0e1f2a',
    display: { key: 'listings/a/b/display.webp', width: 1_600, height: 1_200 },
    thumbnail: { key: 'listings/a/b/thumbnail.webp', width: 400, height: 300 },
    ...over,
  });

  const signer = () => new ListingImageSigner(new MemoryObjectStore());

  it('signs a rendition, carrying its dimensions through unchanged', async () => {
    const signed = await signer().sign(media().thumbnail);

    expect(signed?.url).toContain('listings/a/b/thumbnail.webp');
    expect(signed?.width).toBe(400);
    expect(signed?.height).toBe(300);
  });

  /*
   * The null passthrough is not a convenience. Most listings have no photograph,
   * so the absent case is the common one — and a signer that threw or demanded a
   * branch at every call site would put that branch in two public read paths
   * where forgetting it is a 500 on the busiest route in the system.
   */
  it('signs nothing when there is nothing, rather than refusing', async () => {
    expect(await signer().sign(null)).toBeNull();
  });

  it('signs for the shared TTL, not a duration invented here', async () => {
    const signed = await signer().sign(media().display);

    expect(signed?.url).toContain(String(SIGNED_URL_TTL_SECONDS));
  });

  it('signs both renditions of every photograph in a gallery', async () => {
    const signed = await signer().signAll([media()]);

    expect(signed[0]?.display.url).toContain('display.webp');
    expect(signed[0]?.thumbnail.url).toContain('thumbnail.webp');
    expect(signed[0]?.id).toBe('2c9f0a1e-3b4d-4c5e-8f6a-7b8c9d0e1f2a');
  });

  /*
   * **Order is the whole of the ordering.** `PublicListingMedia` carries no
   * position — the array order is the owner's order — so a signer that
   * reordered while awaiting would shuffle a gallery with nothing to restore it
   * from. `Promise.all` over `map` preserves it; a `for await` accumulating into
   * an array would too, but a `Promise.race` or an unordered pool would not, and
   * this is the test that would fail if somebody 'optimised' it into one.
   */
  it('keeps the gallery in the order it was given', async () => {
    const ids = [
      '2c9f0a1e-3b4d-4c5e-8f6a-7b8c9d0e1f2a',
      '3d0a1b2c-4e5f-4a6b-9c7d-8e9f0a1b2c3d',
      '4e1b2c3d-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
    ];
    const signed = await signer().signAll(
      ids.map((id, index) =>
        media({
          id,
          display: {
            key: `listings/a/${id}/display.webp`,
            width: index + 1,
            height: 1,
          },
        }),
      ),
    );

    expect(signed.map((item) => item.id)).toEqual(ids);
    expect(signed.map((item) => item.display.width)).toEqual([1, 2, 3]);
  });

  it('signs an empty gallery to an empty gallery', async () => {
    expect(await signer().signAll([])).toEqual([]);
  });

  /*
   * **No caching, asserted rather than assumed.** A signed URL expires, so a
   * cache keyed by object key would eventually serve a dead one — a broken image
   * with nothing in any log. Two calls must each mint afresh. `MemoryObjectStore`
   * signs deterministically, so what this can prove is that the store is asked
   * twice rather than that the strings differ.
   */
  it('mints on every call rather than remembering an expiring URL', async () => {
    let signings = 0;
    const counting = new ListingImageSigner({
      put: () => Promise.reject(new Error('not used')),
      delete: () => Promise.reject(new Error('not used')),
      signedUrl: (key: string) => {
        signings += 1;
        return Promise.resolve(`https://signed.invalid/${key}`);
      },
    });

    await counting.sign(media().display);
    await counting.sign(media().display);

    expect(signings).toBe(2);
  });
});
