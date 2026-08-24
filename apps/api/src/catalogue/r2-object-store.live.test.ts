import { createRecordingLogger } from '@platform/observability/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { R2ObjectStore } from './r2-object-store.js';

/**
 * The adapter against the real Cloudflare R2 bucket.
 *
 * **Opt-in, and skipped everywhere it is not deliberately switched on.** ADR
 * 0008's rule is that an adapter is exercised against the real service rather
 * than built from documentation and hoped over — and this project's standing
 * lesson is that a control nobody has fired is a claim. But a live call has no
 * business in CI: it would need a credential in a pull-request job, it would
 * write to a bucket serving an environment, and it would make the suite fail
 * when somebody else's network was having a bad day.
 *
 * Run it by hand, with the credentials from the token created on 24 August
 * 2026, using names that cannot collide with the application's own
 * `MEDIA_S3_*` — nothing here should ever be reachable by an app that merely
 * has its normal configuration loaded:
 *
 * ```
 * MEDIA_LIVE_ENDPOINT=https://<account>.eu.r2.cloudflarestorage.com \
 * MEDIA_LIVE_BUCKET=rental-staging-media \
 * MEDIA_LIVE_ACCESS_KEY_ID=… MEDIA_LIVE_SECRET_ACCESS_KEY=… \
 *   npx vitest run --project api r2-object-store.live
 * ```
 *
 * It cleans up after itself, and asserts it did.
 */

const endpoint = process.env.MEDIA_LIVE_ENDPOINT;
const bucket = process.env.MEDIA_LIVE_BUCKET;
const accessKeyId = process.env.MEDIA_LIVE_ACCESS_KEY_ID;
const secretAccessKey = process.env.MEDIA_LIVE_SECRET_ACCESS_KEY;

const configured =
  endpoint !== undefined &&
  bucket !== undefined &&
  accessKeyId !== undefined &&
  secretAccessKey !== undefined;

/** A prefix nothing else uses, so a failed run leaves findable litter. */
const KEY = `live-test/${String(Date.now())}/probe.webp`;
const BYTES = Buffer.from('not really a webp, but bytes are bytes', 'utf8');

describe.skipIf(!configured)('R2, for real', () => {
  const logger = createRecordingLogger();
  const store = new R2ObjectStore(
    {
      endpoint: endpoint ?? '',
      bucket: bucket ?? '',
      accessKeyId: accessKeyId ?? '',
      secretAccessKey: secretAccessKey ?? '',
    },
    logger.logger,
  );

  afterAll(async () => {
    // Belt and braces: the delete test below is the real cleanup, but a failure
    // before it must not leave an object behind.
    await store.delete(KEY).catch(() => undefined);
  });

  it('stores an object, hands back a URL that reads it, and deletes it', async () => {
    await store.put(KEY, BYTES, 'image/webp');

    const url = await store.signedUrl(KEY, 60);
    const read = await fetch(url);

    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer())).toEqual(BYTES);
    expect(read.headers.get('content-type')).toBe('image/webp');

    /*
     * The permission actually granted. The token is "Object Read & Write",
     * whose description does not say whether delete is included — so this
     * fires it rather than reasoning about it. A 403 here means the token
     * needs re-issuing before 2.6b can remove a photograph.
     */
    await store.delete(KEY);

    const afterDelete = await fetch(await store.signedUrl(KEY, 60));
    expect(afterDelete.status).toBe(404);
  });

  it('treats deleting an absent object as success, as S3 does', async () => {
    await expect(
      store.delete(`live-test/${String(Date.now())}/never-written.webp`),
    ).resolves.toBeUndefined();
  });

  it('signs a URL that stops working once it has expired', async () => {
    await store.put(KEY, BYTES, 'image/webp');

    // One second, then wait it out. The alternative — trusting that
    // `X-Amz-Expires` was applied because it appears in the query string — is
    // exactly the assumption that would hide a signature the provider ignores.
    const url = await store.signedUrl(KEY, 1);
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const expired = await fetch(url);
    expect(expired.status).toBe(403);

    await store.delete(KEY);
  });
});
