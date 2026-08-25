import {
  LISTING_MEDIA_ACCEPT,
  LISTING_MEDIA_ACCEPT_TYPES,
  LISTING_MEDIA_MAX_BYTES,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { ACCEPTED_INPUT_FORMATS, MAX_INPUT_BYTES } from './prepare-image.js';

/**
 * The picker's hint against the pipeline's actual allowlist (slice 2.6c).
 *
 * `LISTING_MEDIA_ACCEPT_TYPES` is a *hint* — a file input's `accept` filters a
 * dialog every platform lets you override, so `ACCEPTED_INPUT_FORMATS` remains
 * the only thing that decides. That is exactly why it is safe to state twice and
 * exactly why it needs this file: a hint that drifts is worse than no hint,
 * because it hides a format the platform accepts, or offers one it does not and
 * turns a refusal into a surprise at the end of an upload.
 *
 * **The mapping is stated here rather than in the contract**, because it is
 * knowledge about libvips format names, and the contracts package should not
 * have to hold any.
 */
const MIME_FOR_FORMAT: Record<
  (typeof ACCEPTED_INPUT_FORMATS)[number],
  readonly string[]
> = {
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  webp: ['image/webp'],
  gif: ['image/gif'],
  // One container, two names platforms disagree about. An iPhone photograph is
  // the case that matters and omitting either is how it stops appearing.
  heif: ['image/heic', 'image/heif'],
  tiff: ['image/tiff'],
};

describe('the file picker hint', () => {
  it('offers exactly the formats the pipeline accepts', () => {
    const expected = ACCEPTED_INPUT_FORMATS.flatMap(
      (format) => MIME_FOR_FORMAT[format],
    );

    expect([...LISTING_MEDIA_ACCEPT_TYPES].sort()).toEqual([...expected].sort());
  });

  it('names every accepted format, so adding one to the pipeline fails here', () => {
    // Guards the direction the test above cannot: a format added to
    // ACCEPTED_INPUT_FORMATS without a mapping would be `undefined` in the flat
    // map and quietly contribute nothing.
    for (const format of ACCEPTED_INPUT_FORMATS) {
      expect(MIME_FOR_FORMAT[format]).toBeDefined();
      expect(MIME_FOR_FORMAT[format].length).toBeGreaterThan(0);
    }
  });

  it('is a comma-separated attribute a file input can take', () => {
    expect(LISTING_MEDIA_ACCEPT).toBe(LISTING_MEDIA_ACCEPT_TYPES.join(','));
    expect(LISTING_MEDIA_ACCEPT).toContain('image/jpeg');
    expect(LISTING_MEDIA_ACCEPT).not.toContain(' ');
  });

  it('refuses SVG, which libvips would otherwise rasterise happily', () => {
    // The one absence worth a test rather than a comment: an SVG is a document
    // that can carry script and fetch external resources, and it decodes.
    expect(LISTING_MEDIA_ACCEPT).not.toContain('svg');
    expect(ACCEPTED_INPUT_FORMATS).not.toContain('svg');
  });
});

describe('the byte cap', () => {
  it('is one number, shared by the pipeline and the page', () => {
    // The alias is what lets the pipeline keep reading in its own vocabulary.
    // If these ever differ, a browser is promising something the API refuses.
    expect(MAX_INPUT_BYTES).toBe(LISTING_MEDIA_MAX_BYTES);
  });

  it('clears a phone photograph with room to spare', () => {
    expect(LISTING_MEDIA_MAX_BYTES).toBe(15 * 1024 * 1024);
    expect(LISTING_MEDIA_MAX_BYTES).toBeGreaterThan(8 * 1024 * 1024);
  });
});
