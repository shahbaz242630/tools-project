import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_INPUT_FORMATS,
  DISPLAY_MAX_EDGE,
  ImageRejectedError,
  MAX_INPUT_BYTES,
  MAX_INPUT_PIXELS,
  OUTPUT_CONTENT_TYPE,
  THUMBNAIL_MAX_EDGE,
  assertDecodersAvailable,
  prepareImage,
} from './prepare-image.js';

/**
 * Fixtures are generated rather than committed.
 *
 * A checked-in binary is a thing nobody can review: the assertion "this JPEG
 * carries GPS EXIF" would rest on the commit message. Building it here means
 * the property under test is written in the test, and the arrangement fails
 * loudly if a sharp upgrade ever stops producing it.
 */

/** A plain image of the given size, in the given format. */
async function image(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' | 'tiff' | 'gif' = 'jpeg',
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 10, g: 120, b: 60 },
    },
  })
    .toFormat(format)
    .toBuffer();
}

/** Somebody's back garden, as a camera would record it. */
const CAMERA_MAKE = 'PrivacyLeakCam';
const GPS_LATITUDE = '51/1 30/1 26/1';

async function photographWithGpsExif(): Promise<Buffer> {
  return sharp(await image(800, 600))
    .withExif({
      IFD0: { Make: CAMERA_MAKE, Model: 'Rear Wide' },
      // IFD3 is the GPS directory.
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: GPS_LATITUDE,
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 39/1',
      },
    })
    .jpeg()
    .toBuffer();
}

/**
 * A two-frame GIF89a, 2×2, assembled by hand.
 *
 * Written out because sharp will not *produce* an animated image from a
 * synthetic input — every documented route (`pages`, `pageHeight`, a
 * toilet-roll raw buffer) yields a single tall frame. Eighty-five bytes of
 * labelled literal is reviewable in a way a committed `.gif` would not be.
 */
function twoFrameGif(): Buffer {
  const bytes = (...values: number[]): Buffer => Buffer.from(values);

  // Delay 10/100 s, no transparency.
  const graphicControl = bytes(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00);
  // Frame at (0,0), 2×2, no local colour table.
  const imageDescriptor = bytes(0x2c, 0, 0, 0, 0, 0x02, 0x00, 0x02, 0x00, 0x00);
  // LZW, minimum code size 2: clear, four pixels of index 0, end.
  const pixels = bytes(0x02, 0x02, 0x44, 0x01, 0x00);

  return Buffer.concat([
    Buffer.from('GIF89a'),
    bytes(0x02, 0x00, 0x02, 0x00), // logical screen 2×2
    bytes(0xf0, 0x00, 0x00), // global colour table, two entries
    bytes(0xff, 0xff, 0xff, 0x00, 0x00, 0x00), // white, black
    bytes(0x21, 0xff, 0x0b),
    Buffer.from('NETSCAPE2.0'),
    bytes(0x03, 0x01, 0x00, 0x00, 0x00), // loop forever
    graphicControl,
    imageDescriptor,
    pixels,
    graphicControl,
    imageDescriptor,
    pixels,
    bytes(0x3b), // trailer
  ]);
}

describe('the format allowlist against the installed libvips', () => {
  /**
   * The check that would have caught "iPhone photographs fail in production".
   *
   * sharp ships a different prebuilt libvips per platform and libc, and they do
   * not carry identical codec sets. This runs on every platform CI touches, so
   * a binary that cannot honour the allowlist fails here rather than at the
   * first upload.
   */
  it('can decode every format the allowlist promises', () => {
    expect(() => {
      assertDecodersAvailable();
    }).not.toThrow();
  });

  it('refuses an allowlist the binary cannot honour, naming what is missing', () => {
    expect(() => {
      assertDecodersAvailable({
        ...sharp.format,
        heif: {
          ...sharp.format.heif,
          input: { ...sharp.format.heif.input, buffer: false },
        },
      });
    }).toThrow(/heif/);
  });

  it('does not offer svg, which libvips would otherwise rasterise happily', () => {
    expect(ACCEPTED_INPUT_FORMATS).not.toContain('svg');
  });
});

describe('stripping location out of an uploaded photograph', () => {
  /**
   * **The single most important assertion in this slice.**
   *
   * ADR 0032 displaces a listing's published point by at least 500 m, persists
   * one offset so averaging cannot recover the truth, and indexes the fuzzed
   * pair so the accurate query is not available. A photograph taken at home
   * carries the true coordinates in EXIF, and serving that file returns
   * everything the fuzz protects, to anybody, with no query at all.
   */
  it('leaves no EXIF on the stored bytes', async () => {
    const source = await photographWithGpsExif();

    // The arrangement is real: this fails if sharp stops writing GPS, which
    // would otherwise leave the assertion below passing for the wrong reason.
    const before = await sharp(source).metadata();
    expect(before.exif).toBeInstanceOf(Buffer);

    const prepared = await prepareImage(source);

    for (const rendition of [prepared.display, prepared.thumbnail]) {
      const after = await sharp(rendition.bytes).metadata();
      expect(after.exif).toBeUndefined();
    }
  });

  it('leaves no trace of the metadata in the raw bytes either', async () => {
    const prepared = await prepareImage(await photographWithGpsExif());

    /*
     * Deliberately not `metadata().exif`, which only reports segments sharp
     * knows to look in. Searching the bytes catches a payload surviving
     * somewhere sharp does not report — the failure mode a metadata-only
     * assertion is blind to.
     */
    for (const rendition of [prepared.display, prepared.thumbnail]) {
      const raw = rendition.bytes.toString('latin1');
      expect(raw).not.toContain(CAMERA_MAKE);
      expect(raw).not.toContain(GPS_LATITUDE);
    }
  });

  it('applies the EXIF orientation before discarding it, so portraits stay upright', async () => {
    /*
     * Orientation 6 means "rotate 90° clockwise to display". The stored pixels
     * are landscape; a viewer honouring EXIF shows them portrait.
     *
     * Strip the metadata without applying it and the image is served on its
     * side — which every "the EXIF is gone" assertion above would still pass.
     */
    /*
     * `withMetadata({orientation})` and not `withExif({IFD0: {Orientation}})`.
     * The second is the obvious spelling and it silently does nothing —
     * `metadata().orientation` still reads 1 — so the fixture carried no
     * orientation at all and the assertion below passed for the wrong reason
     * until the guard two lines down was added.
     */
    const sideways = await sharp(await image(800, 400))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    expect((await sharp(sideways).metadata()).orientation).toBe(6);

    const prepared = await prepareImage(sideways);

    expect(prepared.display.height).toBeGreaterThan(prepared.display.width);
  });
});

describe('what we refuse, and why', () => {
  it('refuses a file larger than the byte limit before decoding anything', async () => {
    const oversized = Buffer.alloc(MAX_INPUT_BYTES + 1, 0x00);

    // All-zero bytes are not a decodable image, so reaching a decoder at all
    // would report `not-an-image`. `too-many-bytes` proves the length check ran
    // first, which is the ordering that keeps this cheap under load.
    await expect(prepareImage(oversized)).rejects.toMatchObject({
      reason: 'too-many-bytes',
    });
  });

  it('refuses a decompression bomb, which the byte limit cannot see', async () => {
    /*
     * A flat-colour PNG far beyond the pixel cap, and small on disk — the whole
     * point. Decoding it would ask for gigabytes; the header check refuses it
     * for a few hundred bytes of work.
     */
    const edge = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 1_000;
    const bomb = await sharp({
      create: { width: edge, height: edge, channels: 3, background: '#000' },
      limitInputPixels: false,
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    expect(bomb.byteLength).toBeLessThan(MAX_INPUT_BYTES);

    await expect(prepareImage(bomb)).rejects.toMatchObject({
      reason: 'too-many-pixels',
    });
  });

  it('refuses an SVG, whatever libvips is willing to rasterise', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
        '<rect width="100" height="100" fill="green"/></svg>',
    );

    await expect(prepareImage(svg)).rejects.toMatchObject({
      reason: 'unsupported-format',
    });
  });

  it('refuses an archive that claims to be a photograph', async () => {
    // `PK\x03\x04` is a zip local file header. Nothing about the call site
    // distinguishes this from a JPEG — only the decoder does, which is the
    // point of never trusting a declared content type.
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(512, 0x41),
    ]);

    await expect(prepareImage(zip)).rejects.toMatchObject({
      reason: 'not-an-image',
    });
  });

  it('refuses a truncated image as a rejection rather than a crash', async () => {
    const whole = await image(800, 600);
    const truncated = whole.subarray(0, Math.floor(whole.byteLength / 2));

    const error = await prepareImage(truncated).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImageRejectedError);
    expect((error as ImageRejectedError).reason).toBe('not-an-image');
  });

  it('refuses an empty file', async () => {
    await expect(prepareImage(Buffer.alloc(0))).rejects.toMatchObject({
      reason: 'not-an-image',
    });
  });
});

describe('what we store', () => {
  it('bounds the longest edge, so a huge upload is a small object', async () => {
    const prepared = await prepareImage(await image(4000, 3000));

    expect(prepared.display.width).toBe(DISPLAY_MAX_EDGE);
    expect(prepared.thumbnail.width).toBe(THUMBNAIL_MAX_EDGE);
    // Aspect ratio kept rather than cropped — we do not get to decide which
    // part of somebody's item matters.
    expect(prepared.display.height).toBe((DISPLAY_MAX_EDGE * 3) / 4);
  });

  it('does not enlarge an image smaller than the target', async () => {
    const prepared = await prepareImage(await image(200, 150));

    expect(prepared.display.width).toBe(200);
    expect(prepared.display.height).toBe(150);
  });

  it('normalises every accepted input to one output type', async () => {
    for (const format of ['jpeg', 'png', 'webp', 'tiff', 'gif'] as const) {
      const prepared = await prepareImage(await image(300, 200, format));

      expect(prepared.contentType).toBe(OUTPUT_CONTENT_TYPE);
      expect(prepared.sourceFormat).toBe(format);
    }
  });

  it('hashes the stored bytes, so the digest can be rechecked against the object', async () => {
    const source = await image(300, 200);
    const first = await prepareImage(source);
    const second = await prepareImage(source);

    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic, so the same photograph twice deduplicates.
    expect(second.sha256).toBe(first.sha256);
  });

  it('reports a byte size matching the bytes it returns', async () => {
    const prepared = await prepareImage(await image(1000, 800));

    expect(prepared.display.byteSize).toBe(prepared.display.bytes.byteLength);
    expect(prepared.thumbnail.byteSize).toBe(prepared.thumbnail.bytes.byteLength);
    expect(prepared.thumbnail.byteSize).toBeLessThan(prepared.display.byteSize);
  });

  it('takes one frame of an animation rather than the whole thing', async () => {
    /*
     * Frame count multiplies the pixel budget, so an animation whose per-frame
     * dimensions look innocent is a bomb the header check would pass. One frame
     * is all a rental listing wants anyway.
     */
    const animated = twoFrameGif();

    // The arrangement is real: two pages, stacked to 2×4 when read as an
    // animation. sharp cannot *write* an animated GIF from a synthetic input,
    // which is why this one is assembled byte by byte.
    const asAnimation = await sharp(animated, { animated: true }).metadata();
    expect(asAnimation.pages).toBe(2);
    expect(asAnimation.height).toBe(4);

    const prepared = await prepareImage(animated);

    // One frame — 2×2, not the 2×4 toilet roll. Remove `animated: false` and
    // this reads 4, which is the regression worth pinning.
    expect(prepared.display.height).toBe(2);
    expect(prepared.display.width).toBe(2);
  });
});
