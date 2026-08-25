/**
 * Talking to the API about profiles, and surviving every way that can go wrong.
 *
 * Separated from the pages that render it for the same reason as `account.ts`:
 * the interesting cases are not the happy path. The API can be unreachable, can
 * answer 401 because the token expired between render and submit, or can answer
 * with a shape this version does not understand mid-deploy. None of those
 * should reach a person as a blank screen — and a save that silently did
 * nothing is worse than an error, because they will close the tab believing
 * their address is stored.
 *
 * `fetch` is injected so all of it is testable without a server.
 */

import {
  CLIENT_IP_HEADER,
  ME_PROFILE_PATH,
  parseMyProfileResponse,
  parsePublicProfile,
  publicProfilePath,
} from '@platform/contracts';
import type { MyProfile, ProfileInput, PublicProfile } from '@platform/contracts';
import { accessAssertionHeaders } from './access-assertion';
import { correlationHeaders } from './correlation';

/** Matches `ACCOUNT_TIMEOUT_MS`: one row, no dependency probing. */
export const PROFILE_TIMEOUT_MS = 3_000;

/**
 * **`forbidden` is separate from `unreachable`, and it is the whole point of
 * this union having grown.**
 *
 * A 403 means the API understood us perfectly and said no. Collapsing it into
 * `unreachable` produced the worst sentence in the product: a suspended person
 * was handed their own fully populated, editable profile form — `GET` opts in to
 * `@AllowsSuspended` and `PUT` deliberately does not (ADR 0024) — pressed Save,
 * and read *"Your profile was not saved — API answered 403"*. They were told the
 * site had broken when what had actually happened was a decision somebody made
 * about their account, with a reason waiting on their account page.
 */
export type ProfileOutcome =
  | { readonly kind: 'loaded'; readonly profile: MyProfile | null }
  /** The API rejected the token, or there was no token to send. */
  | { readonly kind: 'signed-out' }
  /** Authenticated, and refused anyway — suspended, most likely. */
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

export type SaveOutcome =
  | { readonly kind: 'saved'; readonly profile: MyProfile }
  /** The submission was rejected. `issues` name the fields, for the form. */
  | { readonly kind: 'invalid'; readonly issues: readonly string[] }
  | { readonly kind: 'signed-out' }
  /** Authenticated, and refused anyway — suspended, most likely. */
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

export type PublicProfileOutcome =
  | { readonly kind: 'found'; readonly profile: PublicProfile }
  /** No such profile — or the account is deleted. The API does not distinguish. */
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly reason: string };

export interface FetchResponse {
  status: number;
  text: () => Promise<string>;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponse>;

/**
 * The headers every authenticated call carries.
 *
 * The address is omitted rather than sent empty when unknown — the API treats a
 * blank header as absent anyway, and an empty one in a request log invites the
 * reader to think it was measured and found to be nothing.
 */
function authHeaders(token: string, clientIp: string | null): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(clientIp === null ? {} : { [CLIENT_IP_HEADER]: clientIp }),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError'
      ? `no response within ${PROFILE_TIMEOUT_MS}ms`
      : error.message;
  }
  return String(error);
}

/** The body, or a reason it could not be read as JSON. */
type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; outcome: { kind: 'unreachable' | 'malformed'; reason: string } };

async function readJson(response: FetchResponse): Promise<BodyResult> {
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    return { ok: false, outcome: { kind: 'unreachable', reason: describe(error) } };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    // Almost always a proxy error page rather than the API. A short excerpt
    // only — the full body could be an entire HTML document.
    return {
      ok: false,
      outcome: {
        kind: 'malformed',
        reason: `expected JSON, got ${raw.trim().slice(0, 80) || '(empty response)'}`,
      },
    };
  }
}

/** Read the signed-in user's own profile. */
export async function fetchMyProfile(
  apiBaseUrl: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<ProfileOutcome> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(new URL(ME_PROFILE_PATH, apiBaseUrl).toString(), {
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
      headers: {
        ...authHeaders(token, clientIp),
        ...(await correlationHeaders()),
        ...(await accessAssertionHeaders()),
      },
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  if (response.status === 401) return { kind: 'signed-out' };

  // This route opts in to `@AllowsSuspended`, so a 403 here is not the ordinary
  // suspension refusal — it is reported honestly rather than as an outage
  // because the remedy is nothing the reader can retry their way out of.
  if (response.status === 403) return { kind: 'forbidden' };

  if (response.status < 200 || response.status >= 300) {
    return { kind: 'unreachable', reason: `API answered ${String(response.status)}` };
  }

  const body = await readJson(response);
  if (!body.ok) return body.outcome;

  try {
    return { kind: 'loaded', profile: parseMyProfileResponse(body.value).profile };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}

/**
 * Save the signed-in user's profile.
 *
 * A 400 is a *result*, not a failure: the API validates against the same schema
 * the form does, and its field-level messages are what the form shows. Treating
 * it as an error would leave the person staring at "something went wrong" with
 * no idea which box to fix.
 */
export async function saveMyProfile(
  apiBaseUrl: string,
  token: string | null,
  input: ProfileInput,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  clientIp: string | null = null,
): Promise<SaveOutcome> {
  if (token === null || token === '') return { kind: 'signed-out' };

  let response: FetchResponse;
  try {
    response = await fetchImpl(new URL(ME_PROFILE_PATH, apiBaseUrl).toString(), {
      method: 'PUT',
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
      headers: {
        ...authHeaders(token, clientIp),
        'content-type': 'application/json',
        ...(await correlationHeaders()),
        ...(await accessAssertionHeaders()),
      },
      body: JSON.stringify(input),
    });
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  if (response.status === 401) return { kind: 'signed-out' };

  // The live one. `PUT /me/profile` does not opt in to `@AllowsSuspended`, so a
  // suspended person reaches this exact line — and until this branch existed
  // they were told the API had broken rather than that their account is held.
  if (response.status === 403) return { kind: 'forbidden' };

  if (response.status === 400) {
    const body = await readJson(response);
    const issues =
      body.ok && isIssueBody(body.value)
        ? body.value.issues
        : ['The profile was rejected'];
    return { kind: 'invalid', issues };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: 'unreachable', reason: `API answered ${String(response.status)}` };
  }

  const body = await readJson(response);
  if (!body.ok) return body.outcome;

  try {
    // The API answers with the saved profile rather than an empty 200, so the
    // page can re-render normalised values — `bs7 8aa` coming back as
    // `BS7 8AA` is how someone sees that it was understood.
    return {
      kind: 'saved',
      profile: parseMyProfileResponse({ profile: body.value }).profile!,
    };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}

function isIssueBody(value: unknown): value is { issues: readonly string[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'issues' in value &&
    Array.isArray((value as { issues: unknown }).issues)
  );
}

/**
 * Read anybody's public profile.
 *
 * No token: this is the one profile route a visitor may call, and sending
 * credentials to it would suggest the answer depends on who is asking. It does
 * not — that is the point of the projection.
 */
export async function fetchPublicProfile(
  apiBaseUrl: string,
  userId: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<PublicProfileOutcome> {
  let response: FetchResponse;
  try {
    response = await fetchImpl(
      new URL(publicProfilePath(userId), apiBaseUrl).toString(),
      {
        signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
        // No credentials — sending them would suggest the answer depends on who
        // is asking — but the trace still belongs to the page view that made it.
        headers: { ...(await correlationHeaders()) },
      },
    );
  } catch (error) {
    return { kind: 'unreachable', reason: describe(error) };
  }

  // Covers "no such account", "deleted" and "no profile yet" alike — the API
  // deliberately gives one answer so this route cannot be used to discover
  // which user ids are real.
  if (response.status === 404) return { kind: 'not-found' };

  if (response.status < 200 || response.status >= 300) {
    return { kind: 'unreachable', reason: `API answered ${String(response.status)}` };
  }

  const body = await readJson(response);
  if (!body.ok) return body.outcome;

  try {
    return { kind: 'found', profile: parsePublicProfile(body.value) };
  } catch (error) {
    return { kind: 'malformed', reason: describe(error) };
  }
}
