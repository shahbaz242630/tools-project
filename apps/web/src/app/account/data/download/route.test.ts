/**
 * What the download route says when it hands over nothing.
 *
 * The route itself is thin, and its three refusals are the whole of it: the
 * status code it chooses is read by a browser, and the sentence it writes is
 * read by a person — in a bare tab or in a text file they saved, with no markup
 * and no link to follow.
 *
 * **The branch this was written for.** Everything that was not `ready` funnelled
 * into one 502 and read `outcome.reason` off it, so a refusal — which carries no
 * reason, because there is nothing about it we could not tell — was both a
 * compile error and, had it been forced through, an accusation that the API was
 * broken when it had answered perfectly well.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ExportOutcome } from '../../../../lib/data-export';

const stub = vi.hoisted(() => ({
  token: 'a-token' as string | null,
  outcome: { kind: 'signed-out' } as ExportOutcome,
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => Promise.resolve({ getToken: () => Promise.resolve(stub.token) }),
}));

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));

vi.mock('../../../../lib/env', () => ({
  webEnv: () => ({ API_BASE_URL: 'http://api.internal:3001' }),
}));

vi.mock('../../../../lib/data-export', () => ({
  fetchDataExport: () => Promise.resolve(stub.outcome),
}));

import { GET } from './route';

async function responseFor(outcome: ExportOutcome) {
  stub.token = 'a-token';
  stub.outcome = outcome;
  const response = await GET();
  return { response, body: await response.text() };
}

describe('GET /account/data/download', () => {
  it('hands over the API’s own bytes when they are ready', async () => {
    const { response, body } = await responseFor({
      kind: 'ready',
      body: '{"exportedAt":"2026-08-15T09:00:00.000Z"}',
      exportedAt: '2026-08-15T09:00:00.000Z',
    });

    expect(response.status).toBe(200);
    expect(body).toBe('{"exportedAt":"2026-08-15T09:00:00.000Z"}');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    // The body holds a home address.
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('does not blame the API for a decision it made deliberately', async () => {
    const { response, body } = await responseFor({ kind: 'forbidden' });

    // 502 would say the API could not answer. It answered.
    expect(response.status).toBe(403);
    expect(body).toContain('You are signed in');
    expect(body).toContain('was not exported');
    expect(body).toContain('decision about your account');
    expect(body).toContain('account page');

    // Never a status code at a person, and no markup: this is text a browser
    // may show bare or write to disk.
    expect(body).not.toContain('403');
    expect(body).not.toContain('<');
  });

  it('still calls an upstream failure an upstream failure', async () => {
    const { response, body } = await responseFor({
      kind: 'unreachable',
      reason: 'socket hang up',
    });

    expect(response.status).toBe(502);
    expect(body).toContain('socket hang up');
  });

  it('sends somebody without a session to stand somewhere, not to redirect', async () => {
    stub.token = null;
    const response = await GET();

    // Not a redirect: this is fetched as a download, and a sign-in page saved
    // as account-data.json is worse than an error.
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Sign in');
  });
});
