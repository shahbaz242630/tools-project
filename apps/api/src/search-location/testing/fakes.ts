import { GeocoderUnavailableError } from '../geocoder.js';
import type { GeocodedPostcode, PostcodeGeocoder } from '../geocoder.js';

/**
 * Test doubles for Search & Location.
 *
 * BRD §5 requires a fake alongside every provider adapter. This one is
 * *behavioural* rather than a recording spy: it answers from a seeded table and
 * returns null for anything it has not been told about, so a test that forgets
 * to seed sees the "not recognised" path rather than a convenient default. That
 * is the same rule the identity fakes follow, and it matters more here — the
 * "not recognised" path is the one production hits for real postcodes the
 * provider's snapshot has not caught up with.
 */
export class FakeGeocoder implements PostcodeGeocoder {
  private readonly known = new Map<string, GeocodedPostcode>();
  private failure: GeocoderUnavailableError | null = null;
  /** Every postcode it was asked about, so a test can assert it was not asked twice. */
  readonly asked: string[] = [];

  /** Real coordinates for a real postcode, so fixtures are not fiction. */
  static readonly BS7_8AA: GeocodedPostcode = {
    postcode: 'BS7 8AA',
    latitude: 51.470761,
    longitude: -2.593052,
  };

  knows(located: GeocodedPostcode): this {
    this.known.set(located.postcode.toUpperCase(), located);
    return this;
  }

  /**
   * Make the **next** call fail, once.
   *
   * Once rather than permanently, so a test can assert that a later save
   * succeeds — which is the whole degradation story: a provider outage costs a
   * listing its coordinates until somebody saves again.
   */
  failsOnce(message = 'The geocoder could not be reached'): this {
    this.failure = new GeocoderUnavailableError(message);
    return this;
  }

  locate(postcode: string): Promise<GeocodedPostcode | null> {
    this.asked.push(postcode);

    if (this.failure !== null) {
      const error = this.failure;
      this.failure = null;
      return Promise.reject(error);
    }

    return Promise.resolve(this.known.get(postcode.toUpperCase()) ?? null);
  }
}
