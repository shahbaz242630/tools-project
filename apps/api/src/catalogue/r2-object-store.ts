import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import type { Logger } from '@platform/observability';
import { ObjectStoreUnavailableError } from './object-store.js';
import type { ObjectStore } from './object-store.js';

/**
 * Cloudflare R2 — the production object store.
 *
 * **Why this provider** (ADR 0037): 10 GB free permanently and, the part that
 * decides it for a marketplace that serves images on every page, **zero egress
 * charge at any volume**. The account already existed for DNS and the Tunnel.
 * R2 speaks the S3 API, so nothing here is R2-specific beyond the endpoint —
 * which is the property that makes the provider swappable, unlike the payment
 * vault ADR 0051 found is not.
 *
 * **`aws4fetch` rather than `@aws-sdk/client-s3`.** We use three operations:
 * PUT, DELETE and a presigned GET. The AWS SDK's value is in the several
 * hundred we do not — at the cost of roughly eighty transitive packages that
 * `Secrets and dependencies` then scans forever. `aws4fetch` is one MIT file
 * with no dependencies that signs a `fetch` with SigV4, which is precisely and
 * only the part we cannot safely write ourselves.
 *
 * ## Failure strategy, stated as BRD §5 requires
 *
 * **Timeouts: 10 s for a write, 5 s for a delete, explicit.** A write carries a
 * few hundred kilobytes and a person is waiting on a form; ten seconds is
 * generous for that and still bounded. A delete carries nothing.
 *
 * **Retry: none, matching `PostcodesIoGeocoder` and for the same reason.** The
 * PUT is idempotent by key so retrying would be *safe*; the argument against is
 * that the caller is a person watching a form, and a second ten-second attempt
 * is twenty seconds of nothing happening. The caller degrades by saying the
 * upload failed, which — unlike a silent geocode failure — is a sentence the
 * owner can act on immediately. If uploads prove flaky in real use that is
 * evidence for adding one retry here, not a reason to have guessed now.
 *
 * **Circuit breaking: fail fast, by construction.** One attempt and a hard
 * timeout means a dead provider costs ten seconds per upload and queues
 * nothing.
 *
 * **Idempotency: by key.** Nothing here touches money or advances a state
 * machine, so BRD §8.7's persisted-idempotency-key requirement does not reach
 * this file. Writing the same key twice is one object.
 */

export const OBJECT_STORE_PUT_TIMEOUT_MS = 10_000;
export const OBJECT_STORE_DELETE_TIMEOUT_MS = 5_000;

export interface R2ObjectStoreConfig {
  /**
   * The S3 endpoint for the bucket's jurisdiction.
   *
   * **Read off Cloudflare's own page rather than constructed.** An
   * EU-jurisdiction bucket lives at `<account>.eu.r2.cloudflarestorage.com`,
   * and the default endpoint without the `.eu.` does not reach it — a bucket
   * chosen for data residency is exactly the one whose endpoint differs, so
   * building this string from an account id is a bug waiting for the first
   * person who assumes the obvious form.
   */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The shape of `fetch` this adapter needs, so a test can supply one.
 *
 * Deliberately narrow — the same approach `PostcodesIoGeocoder` takes. It keeps
 * the substitute in a test a few lines rather than a mock of the whole Fetch
 * API.
 */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    body?: Buffer;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export class R2ObjectStore implements ObjectStore {
  private readonly client: AwsClient;

  constructor(
    private readonly config: R2ObjectStoreConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      /*
       * R2 ignores the region but SigV4 does not — it is part of the signing
       * scope, so it must be *something* and it must match what the service
       * expects. Cloudflare's documented value is the literal `auto`.
       */
      region: 'auto',
      service: 's3',
    });
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const signed = await this.client.sign(this.urlFor(key), {
      method: 'PUT',
      body: bytes,
      headers: {
        'content-type': contentType,
        /*
         * **Set explicitly, because aws4fetch otherwise sends
         * `UNSIGNED-PAYLOAD`** — it treats a body as a stream it cannot rewind
         * and signs only the URL and headers. That is safe over TLS, and it is
         * still weaker than the alternative: with the digest signed, R2 checks
         * that the bytes it stored are the bytes we signed, so a truncated or
         * altered body is refused by the provider rather than stored and
         * discovered later.
         *
         * The cost is one SHA-256 over a few hundred kilobytes, on a path that
         * has just decoded and re-encoded an image twice.
         */
        'x-amz-content-sha256': createHash('sha256').update(bytes).digest('hex'),
      },
    });

    await this.send(
      signed,
      { method: 'PUT', body: bytes },
      OBJECT_STORE_PUT_TIMEOUT_MS,
      'store an object',
    );
  }

  async delete(key: string): Promise<void> {
    const signed = await this.client.sign(this.urlFor(key), {
      method: 'DELETE',
    });

    await this.send(
      signed,
      { method: 'DELETE' },
      OBJECT_STORE_DELETE_TIMEOUT_MS,
      'delete an object',
    );
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    /*
     * `signQuery` puts the signature in the query string rather than an
     * `Authorization` header, which is what makes the result a URL a browser
     * can follow with no cooperation from us.
     *
     * `X-Amz-Expires` is read by aws4fetch off the URL, not passed as an
     * option — an easy thing to get wrong silently, because an unsigned or
     * misspelled parameter simply yields a URL with the provider's default
     * lifetime instead of ours.
     */
    const url = new URL(this.urlFor(key));
    url.searchParams.set('X-Amz-Expires', String(ttlSeconds));

    const signed = await this.client.sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true },
    });

    return signed.url;
  }

  /**
   * The object's address.
   *
   * Path-style (`endpoint/bucket/key`) rather than virtual-host style, which is
   * what R2's S3 API serves. Each key segment is encoded separately so that the
   * slashes we put in a key stay slashes — `encodeURIComponent` on the whole
   * key would turn the prefix structure into one flat name.
   */
  private urlFor(key: string): string {
    const path = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    return `${this.config.endpoint}/${this.config.bucket}/${path}`;
  }

  private async send(
    signed: { url: string; headers: Headers },
    init: { method: string; body?: Buffer },
    timeoutMs: number,
    what: string,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    signed.headers.forEach((value, name) => {
      headers[name] = value;
    });

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(signed.url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ObjectStoreUnavailableError(
        error instanceof Error && error.name === 'TimeoutError'
          ? `The object store did not respond within ${String(timeoutMs)}ms`
          : 'The object store could not be reached',
        error,
      );
    }

    if (response.ok) return;

    /*
     * The body carries S3's XML error code, which is the difference between
     * "the credential is wrong" and "the bucket is full" when somebody is
     * reading logs at 2am. Read defensively: a provider having a bad day can
     * answer a non-2xx with a body that will not read, and failing *here* would
     * replace a useful message with a stack trace from the error path.
     */
    const detail = await response.text().catch(() => '');

    this.logger.error(`Could not ${what}`, {
      status: response.status,
      // Bounded, because a provider error body is not something we control the
      // size of and this goes to Loki.
      detail: detail.slice(0, 500),
    });

    throw new ObjectStoreUnavailableError(
      `The object store answered ${String(response.status)}`,
    );
  }
}
