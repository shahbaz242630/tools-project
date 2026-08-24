import { MAX_INPUT_BYTES, UPLOAD_HEADROOM_BYTES } from './prepare-image.js';

/**
 * Teach Fastify to accept an image as a raw body (slice 2.6b-i).
 *
 * **Its own function rather than four lines inside `bootstrap`, and the reason
 * is that a test found it.** Registered only in `main.ts`, the upload route
 * answered `415 Unsupported Media Type` under every test — because tests build
 * the application through `Test.createTestingModule` and never run `bootstrap`.
 * The tempting fix is to repeat the registration in the test harness, and it is
 * the wrong one: the suite would then prove that *the test's* parser works,
 * while production's could be deleted without a single failure.
 *
 * One function, called by both. What the tests exercise is what ships.
 *
 * ## Why `application/octet-stream` and not multipart
 *
 * Multipart exists to carry several named parts. This request has exactly one
 * thing in it — the image. The filename is not wanted, because the file is
 * re-encoded and its original name discarded, and no other field belongs here.
 * The browser's multipart form is parsed by the Next route handler in front,
 * which is the only thing a browser can reach. So the API needs no multipart
 * parser and no new dependency.
 *
 * ## Why the limit is on the parser and not the adapter
 *
 * Fastify's global `bodyLimit` defaults to 1 MiB, and every JSON route should
 * keep it. Raising it globally so one route can take 15 MB would let *every*
 * route take 15 MB — a denial-of-service surface bought for nothing. A
 * per-parser limit leaves the rest of the API where it was.
 *
 * Beyond the limit Fastify closes the connection, which is the cheapest refusal
 * available: nothing is buffered, nothing is decoded, and it costs no CPU at
 * all. The headroom above `MAX_INPUT_BYTES` is what keeps a file *at* the
 * documented limit from being cut off by the transport before `prepareImage`
 * can refuse it with a sentence that names the limit.
 */

export const IMAGE_UPLOAD_CONTENT_TYPE = 'application/octet-stream';

export const IMAGE_UPLOAD_BODY_LIMIT = MAX_INPUT_BYTES + UPLOAD_HEADROOM_BYTES;

/** The narrow slice of Fastify this needs, so a test can hand it the real one. */
export interface ContentTypeParserHost {
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'buffer'; bodyLimit: number },
    handler: (
      request: unknown,
      body: Buffer,
      done: (error: Error | null, body?: Buffer) => void,
    ) => void,
  ): unknown;
}

export function registerImageUploadParser(host: ContentTypeParserHost): void {
  host.addContentTypeParser(
    IMAGE_UPLOAD_CONTENT_TYPE,
    { parseAs: 'buffer', bodyLimit: IMAGE_UPLOAD_BODY_LIMIT },
    (_request, body, done) => {
      // The bytes, untouched. Every judgement about them belongs to
      // `prepareImage`, which is the only thing that decodes and therefore the
      // only thing that can tell an image from a file claiming to be one.
      done(null, body);
    },
  );
}
