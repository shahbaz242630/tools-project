import { describe, expect, it } from 'vitest';
import { publicListingMediaSchema } from './media.js';
import { parsePublicListing } from './listings.js';

/**
 * The public projection of a photograph (slice 2.6b-ii).
 *
 * The owner's shape is covered where the owner's routes are. What is tested
 * here is the *narrowing* — the two things the public type deliberately does
 * not carry, because both are properties nothing else will fail on.
 */
describe('publicListingMediaSchema', () => {
  const IMAGE = {
    url: 'https://account.eu.r2.cloudflarestorage.com/k?X-Amz-Signature=abc',
    width: 1_600,
    height: 1_200,
  };

  const MEDIA = {
    id: '2c9f0a1e-3b4d-4c5e-8f6a-7b8c9d0e1f2a',
    display: IMAGE,
    thumbnail: { ...IMAGE, width: 400, height: 300 },
  };

  it('accepts a photograph with both renditions', () => {
    expect(publicListingMediaSchema.parse(MEDIA).thumbnail.width).toBe(400);
  });

  /*
   * **The narrowing that matters.** `strictObject` is what enforces it: the
   * owner's shape carries `position`, and this one must not, because
   * `listing_media` has no unique constraint on `(listingId, position)` and two
   * rows may legitimately share one. The array order is a total order; a
   * position number beside it is a weaker second statement of the same fact,
   * and the day they disagree it is in public.
   */
  it('refuses a position, which the array order already carries', () => {
    expect(() => publicListingMediaSchema.parse({ ...MEDIA, position: 0 })).toThrow();
  });

  it('refuses a storage key smuggled in beside the signed url', () => {
    expect(() =>
      publicListingMediaSchema.parse({ ...MEDIA, displayKey: 'listings/a/b.webp' }),
    ).toThrow();
  });

  it('refuses a url that is not one', () => {
    expect(() =>
      publicListingMediaSchema.parse({ ...MEDIA, display: { ...IMAGE, url: 'nope' } }),
    ).toThrow();
  });

  it('refuses a rendition with no dimensions, which a page lays out with', () => {
    const noWidth: Record<string, unknown> = { ...IMAGE };
    delete noWidth.width;

    expect(() =>
      publicListingMediaSchema.parse({ ...MEDIA, display: noWidth }),
    ).toThrow();
  });
});

/**
 * `PublicListing.media` on the wire.
 *
 * The gallery is required and `[]` is its sayable empty value, for the reason
 * `appliedExcess` and `originStatus` are given elsewhere: a field the server
 * forgot must not read as a field the server says is empty.
 */
describe('a public listing carries its photographs', () => {
  const LISTING = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Petrol hedge trimmer',
    description: 'Serviced last spring.',
    categorySlug: 'outdoor-gardening',
    categoryName: 'Outdoor and gardening',
    categoryAttributes: [],
    attributes: {},
    transportRequirement: 'car_boot',
    requiresTwoPersonLift: false,
    location: { outwardCode: 'BS7', town: 'Bristol' },
    inclusiveDailyPrice: {
      rate: { amount: 1_800, currency: 'GBP' },
      renterFee: { amount: 144, currency: 'GBP' },
      total: { amount: 1_944, currency: 'GBP' },
      minimumFeeApplied: false,
    },
    rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
    appliedExcess: null,
    media: [],
    ownerStatus: 'private_owner',
  };

  it('accepts a listing with no photographs at all', () => {
    expect(parsePublicListing(LISTING).media).toEqual([]);
  });

  it('accepts a listing with photographs, in the order given', () => {
    const image = {
      url: 'https://account.eu.r2.cloudflarestorage.com/k?X-Amz-Signature=abc',
      width: 8,
      height: 6,
    };
    const parsed = parsePublicListing({
      ...LISTING,
      media: [
        {
          id: '2c9f0a1e-3b4d-4c5e-8f6a-7b8c9d0e1f2a',
          display: image,
          thumbnail: image,
        },
        {
          id: '3d0a1b2c-4e5f-4a6b-9c7d-8e9f0a1b2c3d',
          display: image,
          thumbnail: image,
        },
      ],
    });

    expect(parsed.media.map((item) => item.id)).toEqual([
      '2c9f0a1e-3b4d-4c5e-8f6a-7b8c9d0e1f2a',
      '3d0a1b2c-4e5f-4a6b-9c7d-8e9f0a1b2c3d',
    ]);
  });

  it('refuses a listing with no media field, which is not the same as none', () => {
    const withoutMedia: Record<string, unknown> = { ...LISTING };
    delete withoutMedia.media;

    expect(() => parsePublicListing(withoutMedia)).toThrow();
  });
});
