import { createRecordingLogger } from '@platform/observability/testing';
import { describe, expect, it } from 'vitest';
import { ObjectStoreUnavailableError } from './object-store.js';
import {
  OBJECT_STORE_DELETE_TIMEOUT_MS,
  OBJECT_STORE_PUT_TIMEOUT_MS,
  R2ObjectStore,
} from './r2-object-store.js';
import type { FetchLike } from './r2-object-store.js';

/**
 * The adapter without the network.
 *
 * The live round trip in `r2-object-store.live.test.ts` proves it works against
 * the real bucket, and is skipped unless deliberately switched on. This file is
 * what runs everywhere: the URL shape, the failure translation, and the
 * timeouts — none of which a live test can provoke on demand.
 */

/** Credentials shaped like the real ones, valueless. */
const CONFIG = {
  endpoint: 'https://account.eu.r2.cloudflarestorage.com',
  bucket: 'rental-staging-media',
  accessKeyId: 'A'.repeat(32),
  secretAccessKey: 'B'.repeat(64),
};

interface Call {
  url: string;
  method: string;
  // Explicitly `| undefined` rather than optional: under
  // `exactOptionalPropertyTypes` an optional property may be *absent*, not
  // present-and-undefined, and a DELETE genuinely records `body: undefined`.
  body: Buffer | undefined;
  headers: Record<string, string> | undefined;
}

function recordingFetch(
  respond: () => Partial<Awaited<ReturnType<FetchLike>>> | Error = () => ({
    ok: true,
    status: 200,
  }),
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];

  const fetch: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });

    const outcome = respond();
    if (outcome instanceof Error) return Promise.reject(outcome);

    return Promise.resolve({
      ok: outcome.ok ?? true,
      status: outcome.status ?? 200,
      text: outcome.text ?? (() => Promise.resolve('')),
    });
  };

  return { fetch, calls };
}

function storeWith(fetch: FetchLike): {
  store: R2ObjectStore;
  logger: ReturnType<typeof createRecordingLogger>;
} {
  const logger = createRecordingLogger();
  return { store: new R2ObjectStore(CONFIG, logger.logger, fetch), logger };
}

describe('addressing an object', () => {
  it('uses path style, which is what R2 serves', async () => {
    const { fetch, calls } = recordingFetch();
    const { store } = storeWith(fetch);

    await store.put('listings/abc/def/display.webp', Buffer.from('x'), 'image/webp');

    expect(calls[0]?.url).toContain(
      `${CONFIG.endpoint}/${CONFIG.bucket}/listings/abc/def/display.webp`,
    );
  });

  it('keeps the slashes in a key as slashes', async () => {
    const { fetch, calls } = recordingFetch();
    const { store } = storeWith(fetch);

    await store.put('a/b/c.webp', Buffer.from('x'), 'image/webp');

    // `encodeURIComponent` over the whole key would give `a%2Fb%2Fc.webp` —
    // one flat name rather than a prefix structure, which quietly breaks every
    // key already written the day somebody "simplifies" the encoding.
    expect(calls[0]?.url).not.toContain('%2F');
    expect(calls[0]?.url).toContain('/a/b/c.webp');
  });

  it('escapes a segment that would otherwise change the path', async () => {
    const { fetch, calls } = recordingFetch();
    const { store } = storeWith(fetch);

    await store.put('listings/a b?x=1/display.webp', Buffer.from('x'), 'image/webp');

    const url = calls[0]?.url ?? '';
    // A bare `?` would end the path and turn the rest into a query string,
    // which the signature does not cover.
    expect(url).toContain('a%20b%3Fx%3D1');
  });
});

describe('storing bytes', () => {
  it('PUTs the bytes with the content type it was given', async () => {
    const { fetch, calls } = recordingFetch();
    const { store } = storeWith(fetch);
    const bytes = Buffer.from('some webp bytes');

    await store.put('k.webp', bytes, 'image/webp');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toBe(bytes);
    expect(calls[0]?.headers?.['content-type']).toBe('image/webp');
  });

  it('carries a SigV4 authorization header', async () => {
    const { fetch, calls } = recordingFetch();
    const { store } = storeWith(fetch);

    await store.put('k.webp', Buffer.from('x'), 'image/webp');

    expect(calls[0]?.headers?.['authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(calls[0]?.headers?.['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('translates a refusal into ObjectStoreUnavailableError', async () => {
    const { fetch } = recordingFetch(() => ({
      ok: false,
      status: 403,
      text: () => Promise.resolve('<Error><Code>AccessDenied</Code></Error>'),
    }));
    const { store, logger } = storeWith(fetch);

    await expect(
      store.put('k.webp', Buffer.from('x'), 'image/webp'),
    ).rejects.toBeInstanceOf(ObjectStoreUnavailableError);

    // The provider's error code is what tells somebody at 2am whether the
    // credential is wrong or the bucket is gone.
    expect(logger.at('error')[0]?.fields?.detail).toContain('AccessDenied');
    expect(logger.at('error')[0]?.fields?.status).toBe(403);
  });

  it('still reports the failure when the error body cannot be read', async () => {
    const { fetch } = recordingFetch(() => ({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('socket closed mid-body')),
    }));
    const { store } = storeWith(fetch);

    // Reading the body is a courtesy. Letting it throw would replace a useful
    // message with a stack trace from the error path itself.
    await expect(store.put('k.webp', Buffer.from('x'), 'image/webp')).rejects.toThrow(
      /answered 500/,
    );
  });

  it('names the timeout when one is hit', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const { fetch } = recordingFetch(() => timeout);
    const { store } = storeWith(fetch);

    await expect(store.put('k.webp', Buffer.from('x'), 'image/webp')).rejects.toThrow(
      new RegExp(String(OBJECT_STORE_PUT_TIMEOUT_MS)),
    );
  });

  it('reports an unreachable store distinctly from a slow one', async () => {
    const { fetch } = recordingFetch(() => new Error('ECONNREFUSED'));
    const { store } = storeWith(fetch);

    await expect(store.put('k.webp', Buffer.from('x'), 'image/webp')).rejects.toThrow(
      /could not be reached/,
    );
  });

  it('does not retry, so one upload is one attempt', async () => {
    const { fetch, calls } = recordingFetch(() => ({ ok: false, status: 500 }));
    const { store } = storeWith(fetch);

    await store.put('k.webp', Buffer.from('x'), 'image/webp').catch(() => undefined);

    // Deliberate, and documented in the adapter: the caller is a person
    // watching a form, and a second ten-second attempt is twenty seconds of
    // nothing happening.
    expect(calls).toHaveLength(1);
  });
});

describe('deleting an object', () => {
  it('DELETEs with no body', async () => {
    const { fetch, calls } = recordingFetch();
    const { store } = storeWith(fetch);

    await store.delete('listings/abc/def/display.webp');

    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.body).toBeUndefined();
  });

  it('has its own, shorter timeout', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const { fetch } = recordingFetch(() => timeout);
    const { store } = storeWith(fetch);

    expect(OBJECT_STORE_DELETE_TIMEOUT_MS).toBeLessThan(OBJECT_STORE_PUT_TIMEOUT_MS);
    await expect(store.delete('k.webp')).rejects.toThrow(
      new RegExp(String(OBJECT_STORE_DELETE_TIMEOUT_MS)),
    );
  });
});

describe('signing a read URL', () => {
  it('makes no network call', async () => {
    const { fetch, calls } = recordingFetch();
    const { store } = storeWith(fetch);

    await store.signedUrl('k.webp', 900);

    // Signing is arithmetic. A network call here would mean the URL's validity
    // depended on the store being up at render time.
    expect(calls).toHaveLength(0);
  });

  it('puts the signature in the query string, not a header', async () => {
    const { store } = storeWith(recordingFetch().fetch);

    const url = new URL(await store.signedUrl('k.webp', 900));

    // What makes the result something a browser can follow unaided.
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]+$/);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  });

  it('carries the lifetime it was asked for', async () => {
    const { store } = storeWith(recordingFetch().fetch);

    const url = new URL(await store.signedUrl('k.webp', 42));

    // aws4fetch reads `X-Amz-Expires` off the URL rather than taking it as an
    // option — get that wrong and the URL silently gets the provider's default
    // lifetime instead of ours, which no assertion on "is there a signature"
    // would catch.
    expect(url.searchParams.get('X-Amz-Expires')).toBe('42');
  });

  it('signs the expiry, so it cannot be edited in the URL', async () => {
    const { store } = storeWith(recordingFetch().fetch);

    const short = new URL(await store.signedUrl('k.webp', 60));
    const long = new URL(await store.signedUrl('k.webp', 86_400));

    expect(short.searchParams.get('X-Amz-Signature')).not.toBe(
      long.searchParams.get('X-Amz-Signature'),
    );
  });
});
