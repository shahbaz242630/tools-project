/**
 * What the deletion form tells somebody, and — the part this file exists for —
 * what it must never tell them.
 *
 * **This action is the one place in the application where a wrong branch is
 * unrecoverable.** Everywhere else, reporting the wrong outcome costs somebody a
 * reload. Here, telling a person their account was deleted when it was not means
 * they close the tab believing their address, their phone number and their
 * history are gone. They will not check, because checking means signing in — and
 * the honest `uncertain` message tells them that failing to sign in is what
 * *success* looks like. So the two are indistinguishable from the reader's side,
 * and only this code can tell them apart.
 *
 * The action therefore tests **positively** for `deleted` and treats everything
 * else — including an outcome no version of this file has heard of — as a
 * refusal. The last two tests here are what pin that: they hand it outcomes the
 * union did not contain when this was written, which is exactly the shape the
 * next change to `lib/deletion.ts` will arrive in.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DeletionOutcome } from '../../../lib/deletion';

const stub = vi.hoisted(() => ({
  outcome: { kind: 'deleted' } as DeletionOutcome,
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: () =>
    Promise.resolve({
      getToken: () => Promise.resolve('a-token'),
      userId: 'user_clerk_1',
    }),
  clerkClient: () =>
    Promise.resolve({ users: { deleteUser: () => Promise.resolve() } }),
}));

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));

vi.mock('../../../lib/env', () => ({
  webEnv: () => ({ API_BASE_URL: 'http://api.internal:3001' }),
}));

vi.mock('../../../lib/deletion', () => ({
  requestDeletion: () => Promise.resolve(stub.outcome),
}));

import { deleteAccountAction } from './actions';
import { INITIAL_DELETION_FORM_STATE } from './state';

/** A submission that passes the typed confirmation, so nothing else refuses. */
function confirmed(): FormData {
  const form = new FormData();
  form.set('confirmation', 'DELETE');
  return form;
}

async function stateFor(outcome: DeletionOutcome) {
  stub.outcome = outcome;
  return deleteAccountAction(INITIAL_DELETION_FORM_STATE, confirmed());
}

describe('deleteAccountAction', () => {
  it('confirms a deletion the API confirmed', async () => {
    const state = await stateFor({ kind: 'deleted' });
    expect(state.status).toBe('deleted');
    expect(state.credentialRemains).toBe(false);
  });

  it('refuses to confirm anything without the typed word', async () => {
    const state = await deleteAccountAction(
      INITIAL_DELETION_FORM_STATE,
      new FormData(),
    );
    expect(state.status).toBe('error');
    expect(state.message).toContain('Nothing has been changed');
  });

  it('says outright that nothing was deleted when the token was refused', async () => {
    const state = await stateFor({ kind: 'signed-out' });
    expect(state.status).toBe('error');
    expect(state.message).toContain('nothing was deleted');
  });

  it('does not call a timeout a failure', async () => {
    const state = await stateFor({ kind: 'uncertain', reason: 'socket hang up' });
    expect(state.status).toBe('error');
    expect(state.message).toContain('could not confirm');
    expect(state.message).toContain('socket hang up');
  });

  it('tells a refused person plainly that their account is still here', async () => {
    const state = await stateFor({ kind: 'forbidden' });

    // The whole point. Before `forbidden` was branched on, this fell through to
    // the success path and somebody whose deletion was *refused* was told their
    // account had been deleted.
    expect(state.status).toBe('error');
    expect(state.message).toContain('was not deleted');
    expect(state.message).toContain('suspended');
    // Never a status code at a person.
    expect(state.message).not.toContain('403');
  });

  it('fails closed on an outcome it has never heard of', async () => {
    // Deliberately not a member of `DeletionOutcome`. The cast is the test: it
    // stands in for the member somebody adds to that union in six months, and
    // the assertion is that the *default* answer is refusal rather than
    // congratulation. A `switch` that fell through to the code below, or an
    // `if (signed-out) … if (uncertain) … else success` chain, both pass every
    // other test in this file and fail this one.
    const state = await stateFor({ kind: 'quarantined' } as unknown as DeletionOutcome);

    expect(state.status).toBe('error');
    expect(state.status).not.toBe('deleted');
    expect(state.message).toContain('could not confirm');
  });
});
