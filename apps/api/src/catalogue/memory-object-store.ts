import type { ObjectStore } from './object-store.js';

/**
 * An object store in process memory — **a real adapter, not a test double.**
 *
 * It exists because "no object store configured" is a supported state rather
 * than an error: local development runs this way on purpose, so that a
 * developer's machine cannot write into the bucket a deployed environment is
 * serving from. That is the object-storage form of the rule that local
 * development never shares a database, and `mediaStorageFrom` enforces the other
 * half by refusing to boot under `NODE_ENV=production` with no bucket.
 *
 * **It lives here rather than in `testing/fakes.ts`, and the distinction is not
 * pedantic.** `main.ts` composes it, so it ships in the production bundle; a
 * composition root importing from a `testing/` directory is how a test affordance
 * — a `willFail`, a recorded call list — ends up reachable in production. The
 * test double extends this one and adds those there, where they belong.
 *
 * **Everything written here is lost on restart**, which is correct for its
 * purpose and would be catastrophic for any other. Nothing should reach for it
 * as a cache or a staging area.
 */
export class MemoryObjectStore implements ObjectStore {
  protected readonly objects = new Map<
    string,
    { bytes: Buffer; contentType: string }
  >();

  put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
    return Promise.resolve();
  }

  /** Absent is success, as it is in S3 — deleting twice is not an error. */
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  /**
   * A URL shaped like a signed one, which nothing can actually fetch.
   *
   * **That is the honest behaviour and not a shortcoming.** These bytes live in
   * one process's heap; there is no server to serve them. A developer running
   * without a bucket sees a broken image, which is the truthful rendering of
   * "there is no object store here" — far better than a data URL that would make
   * local development look like production and hide every integration problem
   * until staging.
   */
  signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return Promise.resolve(
      `https://object-store.invalid/${key}?expires=${String(ttlSeconds)}`,
    );
  }
}
