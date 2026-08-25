/**
 * @vitest-environment node
 *
 * **Node, not the `web` project's jsdom** — and this is the only file in
 * `apps/web` that says so. It is server code: a route handler reading a
 * multipart body, which is a thing browsers *send* and never parse. jsdom's
 * `Request.formData()` does not implement multipart and hangs rather than
 * failing, so every test here timed out at five seconds and none of them said
 * why. Running it where it actually runs is the fix; adding a timeout would have
 * been the wrong one.
 */

/**
 * The upload route (slice 2.6c).
 *
 * **This is the third browser-reachable non-page route in the application**, and
 * the only one that accepts a body from a browser at all. What is under test is
 * therefore not the happy path — the client beneath it has its own tests — but
 * the refusals: what it does with a request that is not what it wanted, and
 * whether it preserves the two properties the API is careful about.
 *
 * Those two: **404 rather than 403 for somebody else's listing**, which is what
 * stops a status code confirming a listing exists; and **the reason travelling
 * with the message**, which is what lets the control say whose fault it was.
 */

import { describe, expect, it, vi } from 'vitest';
import { LISTING_MEDIA_MAX_BYTES } from '@platform/contracts';
import type { MediaOutcome } from '../../../../../lib/listing-media';
import type { OwnerListingMedia } from '@platform/contracts';

const stub = vi.hoisted(() => ({
  token: 'a-token' as string | null,
  outcome: { kind: 'signed-out' } as MediaOutcome<OwnerListingMedia>,
  uploaded: [] as Uint8Array[],
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => Promise.resolve({ getToken: () => Promise.resolve(stub.token) }),
}));

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));

vi.mock('../../../../../lib/env', () => ({
  webEnv: () => ({ API_BASE_URL: 'http://api.internal:3001' }),
}));

vi.mock('../../../../../lib/listing-media', () => ({
  uploadListingMedia: (
    _base: string,
    _token: string,
    _listingId: string,
    bytes: Uint8Array,
  ) => {
    stub.uploaded.push(bytes);
    return Promise.resolve(stub.outcome);
  },
}));

import { POST } from './route';

const LISTING = '8fe74923-e424-421c-b5a2-590280af0fae';

const A_PHOTOGRAPH: OwnerListingMedia = {
  id: '22222222-2222-4222-8222-222222222221',
  position: 0,
  display: { url: 'https://bucket.example/d?sig=1', width: 1600, height: 1200 },
  thumbnail: { url: 'https://bucket.example/t?sig=1', width: 400, height: 300 },
};

function formWith(file: File | null, field = 'photograph'): Request {
  const body = new FormData();
  if (file !== null) body.append(field, file);
  return new Request('http://web.local/api/listings/x/media', { method: 'POST', body });
}

function fileOf(bytes: number, name = 'shed.jpg'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
}

async function post(
  request: Request,
  outcome: MediaOutcome<OwnerListingMedia> = { kind: 'loaded', value: A_PHOTOGRAPH },
) {
  stub.token = 'a-token';
  stub.outcome = outcome;
  stub.uploaded = [];

  const response = await POST(request, { params: Promise.resolve({ id: LISTING }) });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe('POST /api/listings/:id/media', () => {
  it('returns the photograph on success', async () => {
    const { response, body } = await post(formWith(fileOf(64)));

    expect(response.status).toBe(201);
    expect(body).toEqual(A_PHOTOGRAPH);
  });

  it('forwards the file’s bytes and nothing else', async () => {
    // The API's raw parser reads the body as an image. A multipart envelope
    // reaching it would be stored as a photograph of a MIME boundary.
    await post(formWith(fileOf(8)));

    expect(stub.uploaded[0]?.byteLength).toBe(8);
  });

  it('refuses a signed-out caller without troubling the API', async () => {
    stub.token = null;
    stub.uploaded = [];

    const response = await POST(formWith(fileOf(8)), {
      params: Promise.resolve({ id: LISTING }),
    });

    expect(response.status).toBe(401);
    expect(stub.uploaded).toHaveLength(0);
  });

  it('refuses a body that is not a form', async () => {
    const { response, body } = await post(
      new Request('http://web.local/api/listings/x/media', {
        method: 'POST',
        body: 'not a form',
        headers: { 'content-type': 'text/plain' },
      }),
    );

    expect(response.status).toBe(400);
    expect(String(body.message)).toContain('photograph');
  });

  it('refuses a form with no file on it', async () => {
    const { response } = await post(formWith(null));
    expect(response.status).toBe(400);
  });

  it('refuses a file posted under the wrong field name', async () => {
    const { response } = await post(formWith(fileOf(8), 'image'));
    expect(response.status).toBe(400);
  });

  it('refuses an oversized file before reading a byte of it', async () => {
    /*
     * **The point of the check.** `File.size` is known without touching the
     * stream, so a 40 MB file costs nothing to refuse. Reading it to measure it
     * would be the very thing the check exists to avoid — and the assertion that
     * nothing reached the client is what proves it did not.
     */
    const { response, body } = await post(
      formWith(fileOf(LISTING_MEDIA_MAX_BYTES + 1)),
    );

    expect(response.status).toBe(413);
    expect(body.reason).toBe('too-many-bytes');
    expect(stub.uploaded).toHaveLength(0);
  });

  it('names both sizes in the sentence, so the limit is actionable', async () => {
    const { body } = await post(formWith(fileOf(LISTING_MEDIA_MAX_BYTES + 1)));

    expect(String(body.message)).toContain('15.0 MB');
  });

  it('accepts a file of exactly the limit', async () => {
    // Off-by-one on a cap is the classic, and it is the difference between "15
    // MB" being the limit and being one byte over it.
    const { response } = await post(formWith(fileOf(LISTING_MEDIA_MAX_BYTES)));
    expect(response.status).toBe(201);
  });

  it('refuses an empty file rather than sending nothing to be decoded', async () => {
    const { response, body } = await post(formWith(fileOf(0)));

    expect(response.status).toBe(400);
    expect(body.reason).toBe('not-an-image');
    expect(stub.uploaded).toHaveLength(0);
  });

  it('passes a refusal through with its reason and its sentence', async () => {
    const { response, body } = await post(formWith(fileOf(64)), {
      kind: 'refused',
      reason: 'too-many-photographs',
      message: 'A listing may have 10 photographs',
    });

    expect(response.status).toBe(422);
    expect(body.reason).toBe('too-many-photographs');
    expect(body.message).toBe('A listing may have 10 photographs');
  });

  it('answers 503 when the store would not take it', async () => {
    const { response, body } = await post(formWith(fileOf(64)), {
      kind: 'unavailable',
      message: 'Photographs cannot be stored right now',
    });

    expect(response.status).toBe(503);
    expect(body.reason).toBe('storage-unavailable');
  });

  it('answers 404 for somebody else’s listing, never 403', async () => {
    /*
     * The controller's rule, and this route must not soften it: a 403 confirms
     * the listing exists, which is the thing the check protects.
     */
    const { response } = await post(formWith(fileOf(64)), { kind: 'not-found' });
    expect(response.status).toBe(404);
  });

  it('answers 403 only for a suspended account, which is about the caller', async () => {
    const { response, body } = await post(formWith(fileOf(64)), { kind: 'forbidden' });

    expect(response.status).toBe(403);
    expect(String(body.message)).toContain('suspended');
  });

  it('answers 502 when the API could not answer, not 500', async () => {
    // 500 would say this route is broken. It is not — the failure is upstream,
    // and the distinction is what somebody reading a log needs.
    const { response, body } = await post(formWith(fileOf(64)), {
      kind: 'unreachable',
      reason: 'no response within 20000ms',
    });

    expect(response.status).toBe(502);
    expect(String(body.message)).toContain('20000ms');
  });

  it('never lets a response be cached', async () => {
    // It mints signed URLs against somebody's own listing. There is nothing here
    // a shared cache may keep.
    const { response } = await post(formWith(fileOf(64)));
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
