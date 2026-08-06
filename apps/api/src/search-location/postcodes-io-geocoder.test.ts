import { createRecordingLogger } from '@platform/observability/testing';
import { describe, expect, it } from 'vitest';
import { GeocoderUnavailableError } from './geocoder.js';
import { PostcodesIoGeocoder } from './postcodes-io-geocoder.js';
import type { FetchLike } from './postcodes-io-geocoder.js';

/**
 * The postcodes.io adapter.
 *
 * `fetch` is supplied, so these run without network access — but the fixture
 * below is the **real body the real service returned** for BS7 8AA, trimmed to
 * the fields that matter plus a couple that do not. An invented fixture would
 * make these tests agree with my reading of the documentation rather than with
 * the provider.
 */

const BS7_8AA_BODY = JSON.stringify({
  status: 200,
  result: {
    postcode: 'BS7 8AA',
    quality: 1,
    eastings: 358904,
    northings: 174811,
    country: 'England',
    longitude: -2.593052,
    latitude: 51.470761,
    outcode: 'BS7',
    incode: '8AA',
    admin_district: 'Bristol, City of',
  },
});

const NOT_FOUND_BODY = JSON.stringify({ status: 404, error: 'Postcode not found' });

function responds(status: number, body: string): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

function geocoder(fetchImpl: FetchLike) {
  return new PostcodesIoGeocoder(createRecordingLogger().logger, fetchImpl);
}

describe('locating a postcode', () => {
  it('reads the coordinates out of a real response', async () => {
    const located = await geocoder(responds(200, BS7_8AA_BODY)).locate('BS7 8AA');

    expect(located).toEqual({
      postcode: 'BS7 8AA',
      latitude: 51.470761,
      longitude: -2.593052,
    });
  });

  it('keeps only the three fields it needs', async () => {
    const located = await geocoder(responds(200, BS7_8AA_BODY)).locate('BS7 8AA');

    // Data minimisation (BRD §10), not tidiness: the provider returns about
    // thirty fields including electoral wards and NHS regions, and every one of
    // them stored would be personal data about where somebody lives, held for no
    // stated purpose.
    expect(Object.keys(located ?? {}).sort()).toEqual([
      'latitude',
      'longitude',
      'postcode',
    ]);
  });

  it('encodes the postcode into the path, space and all', async () => {
    const called: string[] = [];
    const fetchImpl: FetchLike = (url) => {
      called.push(url);
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(BS7_8AA_BODY),
      });
    };

    await geocoder(fetchImpl).locate('BS7 8AA');

    // An unencoded space makes an invalid URL, and the failure would arrive as
    // an unavailable geocoder rather than as anything pointing here.
    expect(called[0]).toBe('https://api.postcodes.io/postcodes/BS7%208AA');
  });

  it('sends an abort signal, so no call can hang', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchImpl: FetchLike = (_url, init) => {
      signals.push(init?.signal);
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(BS7_8AA_BODY),
      });
    };

    await geocoder(fetchImpl).locate('BS7 8AA');

    // "An adapter with no timeout is a future outage, not a future bug."
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('asks once and does not retry', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls++;
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(BS7_8AA_BODY),
      });
    };

    await geocoder(fetchImpl).locate('BS7 8AA');

    // Deliberate: somebody is waiting on a form submit, and the caller degrades
    // rather than retrying. Asserted so that adding a retry loop is a decision
    // rather than a drive-by.
    expect(calls).toBe(1);
  });
});

describe('a postcode the provider does not know', () => {
  it('is null rather than an error', async () => {
    const located = await geocoder(responds(404, NOT_FOUND_BODY)).locate('ZZ99 9ZZ');

    // Permanent and ordinary: new postcodes are issued continuously and the
    // provider's data is a snapshot, so a postcode that passed our own format
    // check can legitimately be absent.
    expect(located).toBeNull();
  });

  it('logs the district and never the full postcode', async () => {
    const logger = createRecordingLogger();
    await new PostcodesIoGeocoder(logger.logger, responds(404, NOT_FOUND_BODY)).locate(
      'ZZ99 9ZZ',
    );

    const logged = JSON.stringify(logger.records);
    // A full postcode in a log is an address in a log, and this module is one of
    // the few that holds one.
    expect(logged).toContain('ZZ99');
    expect(logged).not.toContain('9ZZ');
  });
});

describe('a provider that cannot answer', () => {
  it('throws rather than returning null when the request fails', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));

    // The distinction the port exists to draw: collapsing this into null would
    // make an outage look like every postcode in the country going invalid.
    await expect(geocoder(fetchImpl).locate('BS7 8AA')).rejects.toBeInstanceOf(
      GeocoderUnavailableError,
    );
  });

  it('names the timeout when the request timed out', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const fetchImpl: FetchLike = () => Promise.reject(timeout);

    await expect(geocoder(fetchImpl).locate('BS7 8AA')).rejects.toThrow(/2500ms/);
  });

  it('throws on a server error', async () => {
    await expect(
      geocoder(responds(503, 'upstream unavailable')).locate('BS7 8AA'),
    ).rejects.toBeInstanceOf(GeocoderUnavailableError);
  });

  it('throws on unreadable JSON rather than reading it as unknown', async () => {
    await expect(
      geocoder(responds(200, '<html>gateway</html>')).locate('BS7 8AA'),
    ).rejects.toBeInstanceOf(GeocoderUnavailableError);
  });

  it('throws when the response shape changes underneath us', async () => {
    // The failure mode this guards: reading a changed shape as "not found"
    // would silently stop locating every listing, with nothing reporting a
    // problem.
    await expect(
      geocoder(responds(200, JSON.stringify({ status: 200 }))).locate('BS7 8AA'),
    ).rejects.toBeInstanceOf(GeocoderUnavailableError);
  });

  it('refuses a terminated postcode that answers 200 with null coordinates', async () => {
    const body = JSON.stringify({
      status: 200,
      result: { postcode: 'BS7 8AA', latitude: null, longitude: null },
    });

    // Without the finite-number check this lands a listing at the intersection
    // of the equator and the Greenwich meridian, off the coast of Ghana.
    await expect(
      geocoder(responds(200, body)).locate('BS7 8AA'),
    ).rejects.toBeInstanceOf(GeocoderUnavailableError);
  });
});
