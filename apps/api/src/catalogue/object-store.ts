/**
 * Somewhere to keep bytes that are too big for a database row.
 *
 * **Declared by Catalogue, because Catalogue owns listing media** (BRD §5.1,
 * §6.2's `Listing media` entity). It is deliberately not a shared
 * infrastructure service: the next module that needs to store bytes — §8.9's
 * condition evidence, in Phase 7 — will want its own retention rules, its own
 * access rules and very likely its own bucket, and a single "storage service"
 * is how those get quietly shared.
 *
 * Three operations, because three is what listing media needs. Resist adding
 * `list`: nothing should ever enumerate this bucket to find out what exists —
 * the database is the record of what exists, and a listing that disagrees with
 * the bucket is a bug to be found rather than a directory to be walked.
 */

/**
 * The store could not be reached, or answered with something unusable.
 *
 * **One error for every failure, deliberately, and it is always transient.**
 * There is no "not found" case here: `delete` on an absent key succeeds (S3
 * semantics, and the behaviour we want — deleting twice is not an error), and
 * `signedUrl` does no network call at all, so it cannot discover an absence.
 * A caller that needs to know whether an object exists is asking the database.
 */
export class ObjectStoreUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ObjectStoreUnavailableError';
    this.cause = cause;
  }
}

export interface ObjectStore {
  /**
   * Write bytes at a key, replacing anything already there.
   *
   * Idempotent by key: the same key and the same bytes twice is one object and
   * not an error. That is what makes a caller's retry safe, and it is why keys
   * are minted by the caller rather than by the store.
   */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;

  /**
   * Remove an object. Succeeds if it was never there.
   *
   * **A failure here leaks an object rather than losing data**, which is the
   * gentler direction — the row is gone and the bytes are unreferenced. The
   * caller must still record it, because unreferenced bytes in a bucket with a
   * 10 GB allowance are a slow leak and nothing else will ever notice them.
   */
  delete(key: string): Promise<void>;

  /**
   * A URL that grants read access to one object for a short time.
   *
   * BRD §10: *"Private object storage with short-lived signed URLs."* The
   * bucket denies public access, so this is the only way bytes reach a browser
   * — and because the URL is what the browser fetches, R2 serves the image
   * directly and our own bandwidth is never in the path.
   *
   * **Not a network call.** Signing is arithmetic over the key and the
   * credential, so this neither fails transiently nor tells you whether the
   * object exists — a signed URL for a key that was never written is a valid
   * URL that will 404 when followed.
   */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

/**
 * How long a signed image URL lives.
 *
 * **A trade, and both ends of it are real.** Too short and a listing page left
 * open in a tab shows broken images; too long and a URL pasted into a group
 * chat keeps working after the listing is unpublished or the owner deletes
 * their account. Fifteen minutes covers reading a page and its re-renders,
 * while making a leaked URL a nuisance rather than a permanent handle.
 *
 * It is not an access-control boundary on its own — the real control is that
 * these are minted only by projections the caller was entitled to receive.
 */
export const SIGNED_URL_TTL_SECONDS = 15 * 60;
