import { describe, expect, it } from 'vitest';
import type { OwnerListingMedia } from '@platform/contracts';
import {
  deleteListingMedia,
  fetchListingMedia,
  refusalIn,
  reorderListingMedia,
  uploadListingMedia,
} from './listing-media';
import type { FetchLike } from './listings';
import { bytesBodyOf, jsonBodyOf } from './testing/captured-body';

/**
 * The media client (slice 2.6c).
 *
 * **What is under test is the translation, not the transport.** Every call here
 * goes through `call` in `listings.ts`, which already has its own tests for the
 * status vocabulary — so these are about the two outcomes only media can
 * receive, and about the one request in the application that carries bytes
 * rather than JSON.
 */

const API = 'https://api.example/';
const TOKEN = 'a-token';
const LISTING = '8fe74923-e424-421c-b5a2-590280af0fae';
const MEDIA = '22222222-2222-4222-8222-222222222221';

const A_PHOTOGRAPH: OwnerListingMedia = {
  id: MEDIA,
  position: 0,
  display: { url: 'https://bucket.example/d?sig=1', width: 1600, height: 1200 },
  thumbnail: { url: 'https://bucket.example/t?sig=1', width: 400, height: 300 },
};

function responds(status: number, body = ''): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

function capturing(status: number, body = '') {
  const calls: { url: string; init?: Parameters<FetchLike>[1] }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    return Promise.resolve({ status, text: () => Promise.resolve(body) });
  };
  return { calls, fetchImpl };
}

describe('uploadListingMedia', () => {
  it('sends the bytes as the body, not as JSON', async () => {
    const { calls, fetchImpl } = capturing(201, JSON.stringify(A_PHOTOGRAPH));
    const bytes = new Uint8Array([1, 2, 3, 4]);

    await uploadListingMedia(API, TOKEN, LISTING, bytes, fetchImpl);

    expect(calls[0]?.init?.method).toBe('POST');
    // The assertion that matters: JSON.stringify of a Uint8Array is `{"0":1,…}`,
    // which the API's raw parser would refuse. `bytesBodyOf` throws if a string
    // arrived, so this cannot pass by comparing nothing.
    expect(bytesBodyOf(calls[0]?.init)).toEqual(bytes);
  });

  it('labels the body application/octet-stream, which is what the API parses', async () => {
    const { calls, fetchImpl } = capturing(201, JSON.stringify(A_PHOTOGRAPH));

    await uploadListingMedia(API, TOKEN, LISTING, new Uint8Array([1]), fetchImpl);

    expect(calls[0]?.init?.headers?.['content-type']).toBe('application/octet-stream');
  });

  it('never sends a JSON content type alongside bytes', async () => {
    // The two are exclusive at the type level; this pins the runtime behaviour,
    // because a request labelled JSON and carrying bytes is a 400 the owner
    // would read as their photograph being rejected.
    const { calls, fetchImpl } = capturing(201, JSON.stringify(A_PHOTOGRAPH));

    await uploadListingMedia(API, TOKEN, LISTING, new Uint8Array([1]), fetchImpl);

    expect(calls[0]?.init?.headers?.['content-type']).not.toBe('application/json');
  });

  it('reads a 422 as a refusal carrying the reason and the sentence', async () => {
    const outcome = await uploadListingMedia(
      API,
      TOKEN,
      LISTING,
      new Uint8Array([1]),
      responds(
        422,
        JSON.stringify({
          reason: 'too-many-pixels',
          message: 'That image is enormous',
        }),
      ),
    );

    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'too-many-pixels',
      message: 'That image is enormous',
    });
  });

  it('reads a 503 as unavailable rather than as the API being unreachable', async () => {
    /*
     * The H3a defect, one route along: collapsing this into `unreachable` would
     * reduce an explained, retryable refusal to "API answered 503" and tell the
     * owner nothing about whether trying again would help.
     */
    const outcome = await uploadListingMedia(
      API,
      TOKEN,
      LISTING,
      new Uint8Array([1]),
      responds(503, JSON.stringify({ message: 'The store would not take it' })),
    );

    expect(outcome).toEqual({
      kind: 'unavailable',
      message: 'The store would not take it',
    });
  });

  it('falls back to a sentence of its own when a 503 carries no message', async () => {
    const outcome = await uploadListingMedia(
      API,
      TOKEN,
      LISTING,
      new Uint8Array([1]),
      responds(503),
    );

    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.message).toContain(
      'Nothing else about your listing',
    );
  });

  it('reports somebody else’s listing as not-found, never as forbidden', async () => {
    // The controller answers 404 rather than 403 so that a 403 cannot confirm
    // the listing exists. This client must not undo that by inventing a
    // different kind.
    const outcome = await uploadListingMedia(
      API,
      TOKEN,
      LISTING,
      new Uint8Array([1]),
      responds(404),
    );

    expect(outcome).toEqual({ kind: 'not-found' });
  });
});

describe('refusalIn', () => {
  it('reads a known reason', () => {
    expect(refusalIn(JSON.stringify({ reason: 'not-an-image' }))).toBe('not-an-image');
  });

  it('refuses a reason this build has never heard of', () => {
    /*
     * **Validated rather than cast**, which is the whole point. A cast would put
     * an unknown string into a `switch` that writes a sentence, every case would
     * miss, and the page would render nothing at all where a refusal belongs.
     */
    expect(refusalIn(JSON.stringify({ reason: 'invented-later' }))).toBeNull();
  });

  it('survives a body that is not JSON at all', () => {
    expect(refusalIn('<html>502 Bad Gateway</html>')).toBeNull();
  });

  it('survives a body with no reason on it', () => {
    expect(refusalIn(JSON.stringify({ message: 'no' }))).toBeNull();
  });
});

describe('an unrecognised refusal reason', () => {
  it('keeps the API’s own sentence rather than inventing one', async () => {
    const outcome = await uploadListingMedia(
      API,
      TOKEN,
      LISTING,
      new Uint8Array([1]),
      responds(
        422,
        JSON.stringify({ reason: 'invented-later', message: 'Some newer rule' }),
      ),
    );

    expect(outcome.kind).toBe('refused');
    // The reason degrades to a member of the union so nothing downstream has to
    // handle a value it cannot type; the *message* is what a person reads, and
    // it is the server's.
    expect(outcome.kind === 'refused' && outcome.message).toBe('Some newer rule');
  });
});

describe('fetchListingMedia', () => {
  it('unwraps the media array', async () => {
    const outcome = await fetchListingMedia(
      API,
      TOKEN,
      LISTING,
      responds(200, JSON.stringify({ media: [A_PHOTOGRAPH] })),
    );

    expect(outcome).toEqual({ kind: 'loaded', value: [A_PHOTOGRAPH] });
  });

  it('reports a body that does not match the contract as malformed', async () => {
    const outcome = await fetchListingMedia(
      API,
      TOKEN,
      LISTING,
      responds(200, JSON.stringify({ media: [{ id: MEDIA }] })),
    );

    expect(outcome.kind).toBe('malformed');
  });
});

describe('deleteListingMedia', () => {
  it('DELETEs the item and accepts a 204 with no body', async () => {
    const { calls, fetchImpl } = capturing(204);

    const outcome = await deleteListingMedia(API, TOKEN, LISTING, MEDIA, fetchImpl);

    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain(`/listings/${LISTING}/media/${MEDIA}`);
    expect(outcome).toEqual({ kind: 'loaded', value: null });
  });
});

describe('reorderListingMedia', () => {
  it('PUTs the whole list, because the contract takes the whole list', async () => {
    const { calls, fetchImpl } = capturing(
      200,
      JSON.stringify({ media: [A_PHOTOGRAPH] }),
    );
    const order = [MEDIA, '22222222-2222-4222-8222-222222222222'];

    await reorderListingMedia(API, TOKEN, LISTING, order, fetchImpl);

    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.url).toContain(`/listings/${LISTING}/media/order`);
    expect(jsonBodyOf(calls[0]?.init)).toEqual({ mediaIds: order });
  });

  it('carries the sentence for a stale order, whose reason describes nothing true', async () => {
    /*
     * The service reuses `not-an-image` for an order that does not match the
     * listing's photographs. The reason is wrong and the message is right, so
     * the message is what a caller shows — pinned here because a page that read
     * the reason would tell somebody their *order* is not an image.
     */
    const outcome = await reorderListingMedia(
      API,
      TOKEN,
      LISTING,
      [MEDIA],
      responds(
        422,
        JSON.stringify({
          reason: 'not-an-image',
          message: 'The order must list exactly this listing’s photographs, once each',
        }),
      ),
    );

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.message).toContain('once each');
  });
});
