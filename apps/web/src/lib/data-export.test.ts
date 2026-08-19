import { describe, expect, it } from 'vitest';
import { fetchDataExport } from './data-export';
import type { FetchLike } from './data-export';

const API = 'http://api.internal:3001';
const TOKEN = 'session-token';

const DOCUMENT = {
  schemaVersion: 6,
  exportedAt: '2026-07-31T09:00:00.000Z',
  account: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'alice@example.com',
    role: 'USER',
    createdAt: '2026-07-15T09:00:00.000Z',
    deletedAt: null,
    deletionRequestedAt: null,
  },
  profile: {
    displayName: 'Sarah M.',
    phone: '+447700900123',
    address: {
      line1: '12 Acacia Avenue',
      line2: null,
      town: 'Bristol',
      postcode: 'BS7 8AA',
    },
    updatedAt: '2026-07-31T09:00:00.000Z',
  },
  activity: [
    {
      action: 'account.provisioned',
      targetType: 'user',
      by: 'subject',
      reason: null,
      ipAddress: '203.0.113.7',
      createdAt: '2026-07-15T09:00:00.000Z',
    },
    {
      // A disclosure — something done *to* them, which schema 5 added. The
      // administrator's address is withheld, which is why `ipAddress` is null
      // here and present above.
      action: 'admin.user_viewed',
      targetType: 'user',
      by: 'administrator',
      reason: 'Investigating a report about a listing',
      ipAddress: null,
      createdAt: '2026-07-16T09:00:00.000Z',
    },
  ],
  activityTruncated: false,
  signIns: [
    {
      event: 'started',
      sessionId: 'sess_3HDhyL6953Z755UaiBQzqU9maQA',
      occurredAt: '2026-07-30T10:53:19.422Z',
      ipAddress: '2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e',
      browserName: 'Edge',
      browserVersion: '150.0.0.0',
      deviceType: 'Windows',
      isMobile: false,
    },
  ],
  signInsTruncated: false,
  listingsTruncated: false,
  // Booking's section, from schema 6 (slice 4.8d).
  bookings: { hires: [], lettings: [], quotes: [] },
  bookingsTruncated: false,
  listings: [],
};

function responds(status: number, body: string): FetchLike {
  return () => Promise.resolve({ status, text: () => Promise.resolve(body) });
}

describe('fetchDataExport', () => {
  it('returns the body the API produced, byte for byte', async () => {
    // Not a re-serialisation of a parsed object. Round-tripping could reorder
    // keys or reformat a number, and the bytes the API produced are the bytes
    // the person should receive.
    const raw = JSON.stringify(DOCUMENT, null, 2);
    const outcome = await fetchDataExport(API, TOKEN, responds(200, raw));

    expect(outcome).toMatchObject({ kind: 'ready', body: raw });
  });

  it('reports the export timestamp, for the filename', async () => {
    const outcome = await fetchDataExport(
      API,
      TOKEN,
      responds(200, JSON.stringify(DOCUMENT)),
    );

    expect(outcome).toMatchObject({ exportedAt: '2026-07-31T09:00:00.000Z' });
  });

  it('sends the token and the forwarded address', async () => {
    let seen: Record<string, string> | undefined;
    await fetchDataExport(
      API,
      TOKEN,
      (_url, init) => {
        seen = init?.headers;
        return Promise.resolve({
          status: 200,
          text: () => Promise.resolve(JSON.stringify(DOCUMENT)),
        });
      },
      '203.0.113.7',
    );

    expect(seen?.['authorization']).toBe(`Bearer ${TOKEN}`);
    // Recorded against the disclosure entry.
    expect(seen?.['x-client-ip']).toBe('203.0.113.7');
  });

  it('sends nothing without a token', async () => {
    let called = false;
    const outcome = await fetchDataExport(API, null, () => {
      called = true;
      return Promise.reject(new Error('should not be called'));
    });

    expect(outcome).toEqual({ kind: 'signed-out' });
    expect(called).toBe(false);
  });

  it('reads 401 as signed out', async () => {
    expect(await fetchDataExport(API, TOKEN, responds(401, ''))).toEqual({
      kind: 'signed-out',
    });
  });

  it('reads 403 as a refusal, so the route can answer 403 rather than 502', async () => {
    // Export survives suspension by design (ADR 0024), so nothing produces one
    // today. Without the member, the download route accused the API of being
    // broken for a decision it had made deliberately.
    expect(await fetchDataExport(API, TOKEN, responds(403, ''))).toEqual({
      kind: 'forbidden',
    });
  });

  it.each([500, 502])('does not hand over a %d body as a data file', async (status) => {
    // Saving an error page as account-data.json would give somebody a file they
    // believe is their data.
    const outcome = await fetchDataExport(
      API,
      TOKEN,
      responds(status, 'upstream error'),
    );
    expect(outcome.kind).toBe('unreachable');
  });

  it('refuses a body this version does not understand', async () => {
    const outcome = await fetchDataExport(
      API,
      TOKEN,
      responds(200, JSON.stringify({ ...DOCUMENT, schemaVersion: 99 })),
    );
    expect(outcome.kind).toBe('malformed');
  });

  it('refuses an HTML error page', async () => {
    const outcome = await fetchDataExport(
      API,
      TOKEN,
      responds(200, '<html>502</html>'),
    );
    expect(outcome.kind).toBe('malformed');
  });

  it('reports a timeout with its budget, which is longer than a read’s', async () => {
    // This assembles several tables and decrypts an address; giving up at the
    // three seconds a page read uses would fail exports that were working.
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const outcome = await fetchDataExport(API, TOKEN, () => Promise.reject(timeout));

    expect(outcome).toMatchObject({ kind: 'unreachable', reason: /10000ms/ });
  });

  it('reports a refused connection rather than throwing', async () => {
    const outcome = await fetchDataExport(API, TOKEN, () =>
      Promise.reject(new Error('connect ECONNREFUSED')),
    );
    expect(outcome).toMatchObject({ kind: 'unreachable' });
  });
});
