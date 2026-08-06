import type { Logger } from '@platform/observability';
import { GeocoderUnavailableError } from './geocoder.js';
import type { GeocodedPostcode, PostcodeGeocoder } from './geocoder.js';

/**
 * postcodes.io — the production geocoder.
 *
 * **Why this provider.** It serves Ordnance Survey and ONS open data, needs no
 * account and no API key, charges nothing, and is the reference implementation
 * most of the UK uses for exactly this. There is nothing to provision, which
 * means ADR 0008's rule is satisfied by construction: this adapter was exercised
 * against the real service before it was written, not built from documentation
 * and hoped over.
 *
 * **No SDK**, so nothing is imported that must stay behind this boundary — the
 * BRD §5 adapter rule is kept by this file being the only place that knows the
 * URL shape and the JSON keys. Everything above it sees `GeocodedPostcode`.
 *
 * ## Failure strategy, stated as BRD §5 requires
 *
 * **Timeout: 2500 ms, explicit.** An owner is waiting on a form submit, and a
 * geocode is not what they came to do. An unbounded call here would be a future
 * outage in which saving a listing hangs.
 *
 * **Retry: none, deliberately.** The operation is a `GET` and is perfectly
 * idempotent, so retrying would be *safe* — the reason not to is that the caller
 * is a person pressing Save. Two attempts at 2.5 s is five seconds of a form
 * doing nothing, to salvage a value the listing does not need in order to be
 * saved. The caller degrades instead: the address is stored, the coordinates are
 * not, and the next save retries. When a background retry is wanted it belongs
 * on the worker queue with the rest of the deferrable work, not inside a request.
 *
 * **Circuit breaking: fail fast, by construction.** With one attempt and a hard
 * timeout, the worst a dead provider costs is 2.5 s per save and no queueing.
 * There is no state to trip, because there is nothing to protect: the failure
 * path is already the graceful one.
 *
 * **Idempotency: not applicable.** Nothing here touches money or changes state
 * anywhere. BRD §8.7's requirement is about payment operations.
 */

export const POSTCODES_IO_BASE_URL = 'https://api.postcodes.io';
export const GEOCODER_TIMEOUT_MS = 2_500;

/** The shape of `fetch` this adapter needs, so a test can supply one. */
export interface FetchResponse {
  status: number;
  text: () => Promise<string>;
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<FetchResponse>;

export class PostcodesIoGeocoder implements PostcodeGeocoder {
  constructor(
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    private readonly baseUrl: string = POSTCODES_IO_BASE_URL,
  ) {}

  async locate(postcode: string): Promise<GeocodedPostcode | null> {
    const url = `${this.baseUrl}/postcodes/${encodeURIComponent(postcode)}`;

    let response: FetchResponse;
    try {
      response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(GEOCODER_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GeocoderUnavailableError(
        error instanceof Error && error.name === 'TimeoutError'
          ? `The geocoder did not respond within ${String(GEOCODER_TIMEOUT_MS)}ms`
          : 'The geocoder could not be reached',
        error,
      );
    }

    // **404 is an answer, not a failure.** The provider looked and does not know
    // this postcode — new ones are issued continuously and its data is a
    // snapshot, so a postcode that passed our own format check can legitimately
    // be absent. Null, which the caller reads as "not located yet".
    if (response.status === 404) {
      this.logger.info('Geocoder does not recognise this postcode', {
        // The outward code only. A full postcode in a log is an address in a
        // log, and this file is one of the few places holding one.
        outwardCode: postcode.split(' ')[0] ?? null,
      });
      return null;
    }

    if (response.status !== 200) {
      throw new GeocoderUnavailableError(
        `The geocoder answered ${String(response.status)}`,
      );
    }

    return this.read(await response.text());
  }

  /**
   * The provider's JSON, narrowed to the three fields we keep.
   *
   * postcodes.io returns about thirty, including electoral wards and NHS
   * regions. Taking three is data minimisation (BRD §10) rather than tidiness:
   * anything stored here would be personal data about where somebody lives, held
   * for no stated purpose.
   *
   * A body we cannot read is `GeocoderUnavailableError`, not null — null means
   * "the provider says this postcode does not exist", and a parsing failure says
   * nothing of the sort. Reading it as null would quietly stop locating every
   * listing on the day the provider changed its response shape.
   */
  private read(raw: string): GeocodedPostcode {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (error) {
      throw new GeocoderUnavailableError(
        'The geocoder returned unreadable JSON',
        error,
      );
    }

    const result = (body as { result?: unknown }).result;
    if (typeof result !== 'object' || result === null) {
      throw new GeocoderUnavailableError('The geocoder returned no result');
    }

    const { postcode, latitude, longitude } = result as {
      postcode?: unknown;
      latitude?: unknown;
      longitude?: unknown;
    };

    // A terminated postcode returns 200 with null coordinates, which is why
    // these are checked for being finite numbers rather than merely present:
    // `null` would otherwise sail through into a column and become a listing
    // at the intersection of the equator and the Greenwich meridian.
    if (
      typeof postcode !== 'string' ||
      typeof latitude !== 'number' ||
      typeof longitude !== 'number' ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      throw new GeocoderUnavailableError(
        'The geocoder returned a result with no usable coordinates',
      );
    }

    return { postcode, latitude, longitude };
  }
}
