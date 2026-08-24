import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * Turning a file somebody uploaded into bytes we are willing to store.
 *
 * **This is the security core of listing media, and the reason it exists is
 * ADR 0032.** A listing's published location is deliberately wrong — one random
 * offset per listing, persisted, minimum 500 m, never recomputed, with the GiST
 * index on the fuzzed pair so that the accurate query is not even available. A
 * whole slice went into making a listing's position unrecoverable.
 *
 * A photograph of a lawnmower taken in the owner's own garden carries the
 * owner's exact coordinates in its EXIF, and publishing that file hands back
 * everything the fuzz protects, to anybody, with no query and no key. BRD §10
 * names it directly: *"strip EXIF GPS data from uploaded images"*.
 *
 * ## Re-encode, never strip
 *
 * Stripping metadata is a blacklist over container formats with many places to
 * hide a payload — EXIF, XMP, IPTC, ICC, comment segments, trailing bytes after
 * the end-of-image marker. Every one of them has to be found and removed, and a
 * format we have not thought about is a gap.
 *
 * Decoding to pixels and re-encoding is a whitelist: the only thing that
 * survives is what libvips could render. That single choice also buys three
 * things this slice would otherwise need separately —
 *
 * - **Content-type verification** (BRD §10). A file that does not decode is not
 *   an image, whatever its extension or its `Content-Type` header claimed. We
 *   never trust either; the decoder is the arbiter.
 * - **Polyglot and malformed-file defence.** A file crafted to be both a valid
 *   JPEG and a valid archive stops being both the moment it is reduced to
 *   pixels and re-encoded.
 * - **Bounded output.** Whatever arrives, what we store is at most
 *   `DISPLAY_MAX_EDGE` on its longest side. Storage growth is bounded by *how
 *   many* images exist, never by how large the ones people send are.
 *
 * It is not malware scanning, and this docblock is not going to claim it is.
 * BRD §10 asks for scanning too, and we have no scanner. What re-encoding gives
 * is that the bytes we serve were produced by our own encoder from a decoded
 * pixel buffer, which removes the file-as-delivered as a carrier.
 *
 * ## Orientation, which is the easy thing to get wrong
 *
 * EXIF carries an orientation flag, and cameras use it constantly rather than
 * rotating pixels. Discard the metadata without applying it and every portrait
 * photograph is served on its side — a bug that looks like a design failure and
 * that no test asserting "the EXIF is gone" would catch. `.rotate()` with no
 * argument applies the stored orientation and then drops it, which is why it is
 * called before `.resize()` and not after: resizing first would fit the
 * pre-rotation dimensions into the box.
 */

/**
 * The formats we will decode.
 *
 * A closed allowlist rather than "whatever sharp supports", because what sharp
 * supports depends on how the libvips binary for the running platform was
 * built. This list is the contract; `assertDecodersAvailable` checks the
 * binary actually honours it.
 *
 * **`svg` is deliberately absent, and it is the one refusal worth explaining.**
 * libvips can rasterise SVG, so it would otherwise sail through as an ordinary
 * decodable image. An SVG is not a picture, it is a document: it can carry
 * script, and it can reference external resources that a rasteriser may fetch.
 * Refusing it here means the question of what our renderer does with a hostile
 * SVG never has to be answered.
 *
 * **`heif` is present and matters more than it looks.** It is what an iPhone
 * produces by default. Safari usually transcodes to JPEG on upload through a
 * file input, so this may rarely fire — but "usually" is not a thing to build
 * on, and the failure mode without it is that a beta tester on an iPhone
 * cannot photograph anything.
 */
export const ACCEPTED_INPUT_FORMATS = [
  'jpeg',
  'png',
  'webp',
  'gif',
  'heif',
  'tiff',
] as const;

export type AcceptedInputFormat = (typeof ACCEPTED_INPUT_FORMATS)[number];

/**
 * The largest file we will look at, refused before a decoder is handed anything.
 *
 * A 12-megapixel phone JPEG is 2–8 MB and an iPhone HEIC is 2–3 MB, so 15 MB
 * clears any real camera with room to spare. It is the cheapest of the limits
 * here — it costs a length check — and it is the one that stops the pipeline
 * being a place to spend our CPU.
 */
export const MAX_INPUT_BYTES = 15 * 1024 * 1024;

/**
 * The largest image we will decode, in pixels.
 *
 * **This is the decompression-bomb limit and it is not the same as the byte
 * limit.** A ~100 KB PNG of a single flat colour can legitimately declare
 * 50,000 × 50,000 pixels; decoding it asks for about 10 GB of memory and the
 * container dies. The byte cap cannot see it, because the file really is small.
 *
 * 50 megapixels clears a 48 MP phone sensor, which is the largest thing a
 * person is plausibly holding. It is passed to libvips as `limitInputPixels`
 * *and* checked against the header separately, because the two catch different
 * things: the header check refuses before any allocation, and `limitInputPixels`
 * is the backstop for a file whose header understates it.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

/** Longest edge of the rendition shown on a listing page. */
export const DISPLAY_MAX_EDGE = 1600;

/** Longest edge of the rendition shown on a search-result card. */
export const THUMBNAIL_MAX_EDGE = 400;

/**
 * What we store, always, whatever arrived.
 *
 * One output format rather than passing the input's through: it makes the
 * stored object's type a constant rather than a value that has to be carried,
 * trusted and re-validated at every layer, and WebP is both smaller than JPEG
 * at equal quality and universally supported by browsers that can run this app
 * at all. Alpha survives, which JPEG would not preserve.
 */
export const OUTPUT_CONTENT_TYPE = 'image/webp';

const DISPLAY_QUALITY = 82;
const THUMBNAIL_QUALITY = 75;

/**
 * Why an upload was refused.
 *
 * A closed union, because these reach two places that both need them bounded: a
 * sentence shown to the owner, and a metric label. Free text in either is a
 * defect — the first becomes an untranslatable string built from a provider's
 * error, and the second mints an unbounded series (see the cardinality rule in
 * CLAUDE.md).
 */
export type ImageRejectionReason =
  'too-many-bytes' | 'too-many-pixels' | 'unsupported-format' | 'not-an-image';

export class ImageRejectedError extends Error {
  constructor(
    readonly reason: ImageRejectionReason,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ImageRejectedError';
    this.cause = cause;
  }
}

/** One stored size of one image. */
export interface ImageRendition {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
}

export interface PreparedImage {
  /** Always `OUTPUT_CONTENT_TYPE`. Both renditions share it. */
  readonly contentType: typeof OUTPUT_CONTENT_TYPE;
  readonly display: ImageRendition;
  readonly thumbnail: ImageRendition;
  /**
   * SHA-256 of the **display bytes**, hex.
   *
   * Of what we store rather than of what arrived, because the hash BRD §6.2
   * puts on listing media has to be checkable later: an integrity check can
   * re-read the object and compare, and nothing anywhere keeps the original
   * file to compare against. It still deduplicates — the encode is
   * deterministic, so the same photograph twice yields the same digest.
   */
  readonly sha256: string;
  /**
   * What the input turned out to be, for telemetry only.
   *
   * From the allowlist, so it is safe as a metric label. Never the filename or
   * the declared content type, both of which are attacker-supplied free text.
   */
  readonly sourceFormat: AcceptedInputFormat;
}

/**
 * The installed libvips can decode everything `ACCEPTED_INPUT_FORMATS` promises.
 *
 * **This exists because the binary is platform-specific and we develop on a
 * platform we do not deploy.** sharp ships a different prebuilt libvips per
 * platform and libc — `win32-x64` here, `linuxmusl-x64` in the Alpine runtime
 * image, `linux-x64` on the CI runner — and they do not carry identical codec
 * sets. HEIF in particular is the one that varies, for patent reasons.
 *
 * Checking `sharp.format` at startup turns "iPhone photographs silently fail in
 * production" into a boot failure on the machine that has the wrong binary.
 * Called from the composition root, and asserted by a test so that the check
 * runs on every platform CI touches.
 */
export function assertDecodersAvailable(
  formats: typeof sharp.format = sharp.format,
): void {
  const missing = ACCEPTED_INPUT_FORMATS.filter(
    (format) => formats[format]?.input.buffer !== true,
  );

  if (missing.length > 0) {
    throw new Error(
      `The installed libvips cannot decode ${missing.join(', ')}. ` +
        'ACCEPTED_INPUT_FORMATS promises formats this platform’s sharp binary ' +
        'does not provide, so uploads in those formats would be refused as ' +
        '"not an image". Either the binary is wrong for this platform or the ' +
        'allowlist needs narrowing — do not narrow it without saying so, ' +
        'because dropping heif means iPhone photographs stop working.',
    );
  }
}

/**
 * Decode, orient, resize, re-encode, hash.
 *
 * Throws `ImageRejectedError` for anything we will not store. It never throws
 * anything else for bad input: a decoder failure on a hostile file is an
 * ordinary refusal, not a 500.
 */
export async function prepareImage(input: Buffer): Promise<PreparedImage> {
  // Cheapest check first, and before a decoder has been handed anything at all.
  if (input.byteLength > MAX_INPUT_BYTES) {
    throw new ImageRejectedError(
      'too-many-bytes',
      `The image is ${String(input.byteLength)} bytes; the limit is ${String(MAX_INPUT_BYTES)}`,
    );
  }

  if (input.byteLength === 0) {
    throw new ImageRejectedError('not-an-image', 'The file is empty');
  }

  const format = await readFormat(input);

  const display = await encode(input, DISPLAY_MAX_EDGE, DISPLAY_QUALITY);
  const thumbnail = await encode(input, THUMBNAIL_MAX_EDGE, THUMBNAIL_QUALITY);

  return {
    contentType: OUTPUT_CONTENT_TYPE,
    display,
    thumbnail,
    sha256: createHash('sha256').update(display.bytes).digest('hex'),
    sourceFormat: format,
  };
}

/**
 * What this file is, refusing anything outside the allowlist.
 *
 * `metadata()` reads the header rather than decoding the image, so the format
 * and pixel-count refusals both happen before we have paid for a decode. That
 * ordering is the whole point of doing this as a separate step instead of
 * letting `encode` discover it.
 */
async function readFormat(input: Buffer): Promise<AcceptedInputFormat> {
  let metadata: sharp.Metadata;
  try {
    metadata = await openForHeader(input).metadata();
  } catch (error) {
    throw new ImageRejectedError(
      'not-an-image',
      'The file could not be read as an image',
      error,
    );
  }

  const format = metadata.format;
  if (
    format === undefined ||
    !(ACCEPTED_INPUT_FORMATS as readonly string[]).includes(format)
  ) {
    throw new ImageRejectedError(
      'unsupported-format',
      `${format ?? 'The file'} is not a format we accept`,
    );
  }

  const { width, height } = metadata;
  if (width === undefined || height === undefined || width < 1 || height < 1) {
    throw new ImageRejectedError(
      'not-an-image',
      'The image declares no usable dimensions',
    );
  }

  if (width * height > MAX_INPUT_PIXELS) {
    throw new ImageRejectedError(
      'too-many-pixels',
      `The image declares ${String(width)}×${String(height)} pixels; the limit is ${String(MAX_INPUT_PIXELS)}`,
    );
  }

  return format as AcceptedInputFormat;
}

/**
 * A sharp instance with the limits that must be on every one of them.
 *
 * A single place, so that adding a third rendition later cannot accidentally
 * create one without `limitInputPixels`.
 *
 * **`animated: false` is a decision, not a default.** It takes the first frame
 * of an animated GIF or WebP and discards the rest. A rental listing wants a
 * photograph, and an animation is an attack surface with no purpose here: the
 * frame count multiplies the pixel budget, so a modestly-sized image with
 * thousands of frames is a decompression bomb that the per-frame dimensions
 * look innocent for.
 */
function open(input: Buffer): sharp.Sharp {
  return sharp(input, {
    limitInputPixels: MAX_INPUT_PIXELS,
    animated: false,
  });
}

/**
 * The same, with the pixel limit off, for reading the header and nothing else.
 *
 * **This is not a hole, and the test that found it is why the distinction is
 * spelled out.** `limitInputPixels` makes `metadata()` itself *throw* on an
 * oversized declaration rather than returning the header — so reading the
 * header through `open` reported a decompression bomb as `not-an-image`. The
 * file was still refused, which is what matters, but under a reason that would
 * have told the owner their photograph was corrupt and filed the metric under
 * the wrong label.
 *
 * Turning the limit off here is safe because `metadata()` parses the header and
 * decodes nothing: the allocation the limit exists to prevent is not one this
 * call can make. `readFormat` then compares the declared pixel count itself and
 * refuses with the accurate reason, and every path that actually decodes still
 * goes through `open` — so a file whose header *understates* its true size is
 * caught there.
 */
function openForHeader(input: Buffer): sharp.Sharp {
  return sharp(input, { limitInputPixels: false, animated: false });
}

async function encode(
  input: Buffer,
  maxEdge: number,
  quality: number,
): Promise<ImageRendition> {
  let output: { data: Buffer; info: sharp.OutputInfo };
  try {
    output = await open(input)
      // Before resize. See the orientation note in this file's docblock.
      .rotate()
      .resize({
        width: maxEdge,
        height: maxEdge,
        // Longest edge to `maxEdge`, aspect ratio kept, no cropping — we are
        // not in a position to decide what part of somebody's item matters.
        fit: 'inside',
        // A 200 px photograph stays 200 px rather than being blown up to 1600
        // and stored eight times larger than it arrived.
        withoutEnlargement: true,
      })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    // Reached when the header parsed but the pixel data did not — a truncated
    // upload, a corrupt file, or a declared size the decoder refuses on the way
    // through. A refusal, never a 500.
    throw new ImageRejectedError(
      'not-an-image',
      'The image could not be decoded',
      error,
    );
  }

  return {
    bytes: output.data,
    width: output.info.width,
    height: output.info.height,
    byteSize: output.data.byteLength,
  };
}
