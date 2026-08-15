/**
 * What the profile form tells somebody when the save does not happen.
 *
 * The action is tested rather than the page because this is where the sentence
 * lives, and because the two failures worth pinning are both *outcomes of the
 * API* rather than states of the DOM: a refused token and a refused account.
 * Everything Next supplies — the session, the forwarded address, the cache
 * invalidation — is faked, because none of it is what was wrong.
 *
 * **The two defects this was written for.** A signed-out submission said "Your
 * session has expired" to somebody who may never have had one. And a *suspended*
 * person, handed a fully populated form because `GET /me/profile` opts in to
 * `@AllowsSuspended` while `PUT` deliberately does not (ADR 0024), pressed Save
 * and read "Your profile was not saved — API answered 403" — the site blamed for
 * a decision an administrator had made, with the reason waiting on their own
 * account page.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SaveOutcome } from '../../../lib/profile';

const stub = vi.hoisted(() => ({
  outcome: { kind: 'signed-out' } as SaveOutcome,
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => Promise.resolve({ getToken: () => Promise.resolve('a-token') }),
}));

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('../../../lib/env', () => ({
  webEnv: () => ({ API_BASE_URL: 'http://api.internal:3001' }),
}));

vi.mock('../../../lib/profile', () => ({
  saveMyProfile: () => Promise.resolve(stub.outcome),
}));

import { saveProfileAction } from './actions';
import { INITIAL_PROFILE_FORM_STATE } from './state';

/** A submission the contract accepts, so validation is never what refused. */
function submission(): FormData {
  const form = new FormData();
  form.set('displayName', 'Sarah M.');
  form.set('phone', '+447700900123');
  form.set('line1', '12 Acacia Avenue');
  form.set('town', 'Bristol');
  form.set('postcode', 'BS7 8AA');
  form.set('ownerStatus', 'private_owner');
  return form;
}

async function messageFor(outcome: SaveOutcome): Promise<string> {
  stub.outcome = outcome;
  const state = await saveProfileAction(INITIAL_PROFILE_FORM_STATE, submission());
  expect(state.status).toBe('error');
  return state.message ?? '';
}

describe('saveProfileAction', () => {
  it('does not claim a session expired when there may never have been one', async () => {
    const message = await messageFor({ kind: 'signed-out' });

    expect(message).toContain('You are not signed in');
    expect(message).toContain('may have expired');
    // The old wording, asserted absent rather than merely unasserted: it read as
    // a statement of fact about a session nobody could vouch for.
    expect(message).not.toMatch(/^Your session has expired/);
  });

  it('tells a suspended person it was a decision, not a fault', async () => {
    const message = await messageFor({ kind: 'forbidden' });

    expect(message).toContain('cannot be changed at the moment');
    expect(message).toContain('suspended');
    // The whole defect: a status code shown to somebody as an explanation.
    expect(message).not.toContain('403');
    expect(message).not.toContain('API answered');
  });

  it('still says plainly that nothing was saved when the API did not answer', async () => {
    const message = await messageFor({ kind: 'unreachable', reason: 'socket hang up' });
    expect(message).toContain('not saved');
    expect(message).toContain('socket hang up');
  });
});
