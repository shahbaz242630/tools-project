/**
 * Fetching the signed-in person's data export from the API.
 *
 * Deliberately returns the **raw body** on success rather than a parsed object.
 * The web app's job here is to hand a file to a browser, and re-serialising a
 * document it just parsed would risk changing it — key order, number
 * formatting, a date that survived a round trip differently. The bytes the API
 * produced are the bytes the person should get.
 *
 * It still parses, but only to *check*: a body that does not match the contract
 * is a body this version does not understand, and downloading it as
 * `account-data.json` would hand somebody a file we cannot vouch for.
 */

import {
  AUTHORIZATION_HEADER,
  CLIENT_IP_HEADER,
  ME_EXPORT_PATH,
  parseDataExport,
} from '@platform/contracts';
import { correlationHeaders } from './correlation';

/** Longer than a read: this assembles several tables and decrypts an address. */
export const EXPORT_TIMEOUT_MS = 10_000;

export type ExportOutcome =
  | { readonly kind: 'ready'; readonly body: string; readonly exportedAt: string }
  | { readonly kind: 'signed-out' }
  /**
   * **Authenticated, and refused anyway**, for the reason written out in
   * `activity.ts`. It could not land on its own: `app/account/data/download/
   * route.ts` funnelled everything that is not `ready` into one 502 and read
   * `outcome.reason` off it, so a member without a reason was a compile error
   * there — the type system pointing at the copy that had to be written rather
   * than an obstacle.
   *
   * Export survives suspension by design (ADR 0024), so nothing produces a 403
   * here today. A 502 would have been doubly wrong if one ever did: it names
   * the API as broken, and this route hands its body to a browser that may
   * write it to disk under the name of a file somebody asked for.
   */
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

export interface FetchResponse {
  status: number;
  text: () => Promise<string>;
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<FetchResponse>;

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError'
      ? `no response within ${EXPORT_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

export async function fetchDataExport(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ExportOutcome> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(new URL(ME_EXPORT_PATH, apiBaseUrl).toString(), {
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
      headers: {
        [AUTHORIZATION_HEADER]: `Bearer ${token}`,
        ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
        ...(await correlationHeaders()),
      },
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  if (response.status === 401) return { kind: 'signed-out' };

  if (response.status === 403) return { kind: 'forbidden' };

  if (response.status < 200 || response.status >= 300) {
    return { kind: 'unreachable', reason: `API answered ${String(response.status)}` };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  try {
    const parsed = parseDataExport(JSON.parse(raw));
    // The parsed value is used for the filename and nothing else; `raw` is what
    // the person receives.
    return { kind: 'ready', body: raw, exportedAt: parsed.exportedAt };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}
