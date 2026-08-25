/**
 * What the photograph actions report, and what they revalidate (slice 2.6c).
 *
 * **Two properties are under test and neither is the request.** The first is the
 * revalidation: this page is a server component, so an action that succeeds
 * without telling Next the rows changed leaves the gallery redrawn from cache —
 * which is a control that visibly did nothing, and is slice 2.8a's defect
 * exactly. The second is the 404 asymmetry: a delete that finds nothing has
 * still achieved what was asked, and a reorder that finds nothing has not.
 */

import { describe, expect, it, vi } from 'vitest';
import type { MediaOutcome } from '../../../lib/listing-media';

const stub = vi.hoisted(() => ({
  outcome: { kind: 'loaded', value: null } as MediaOutcome<unknown>,
  revalidated: [] as string[],
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => Promise.resolve({ getToken: () => Promise.resolve('a-token') }),
}));

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => stub.revalidated.push(path),
}));

vi.mock('../../../lib/env', () => ({
  webEnv: () => ({ API_BASE_URL: 'http://api.internal:3001' }),
}));

vi.mock('../../../lib/listing-media', () => ({
  deleteListingMedia: () => Promise.resolve(stub.outcome),
  reorderListingMedia: () => Promise.resolve(stub.outcome),
}));

import { deleteMediaAction, reorderMediaAction } from './media-actions';
import { INITIAL_MEDIA_STATE } from './media-state';

const LISTING = '8fe74923-e424-421c-b5a2-590280af0fae';
const MEDIA = '22222222-2222-4222-8222-222222222221';

function deleteForm(over: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set('listingId', over.listingId ?? LISTING);
  form.set('mediaId', over.mediaId ?? MEDIA);
  return form;
}

function reorderForm(ids: readonly string[] = [MEDIA]): FormData {
  const form = new FormData();
  form.set('listingId', LISTING);
  for (const id of ids) form.append('mediaIds', id);
  return form;
}

async function deleting(outcome: MediaOutcome<unknown>) {
  stub.outcome = outcome;
  stub.revalidated = [];
  return deleteMediaAction(INITIAL_MEDIA_STATE, deleteForm());
}

async function reordering(outcome: MediaOutcome<unknown>) {
  stub.outcome = outcome;
  stub.revalidated = [];
  return reorderMediaAction(INITIAL_MEDIA_STATE, reorderForm([MEDIA, 'b', 'c']));
}

describe('deleteMediaAction', () => {
  it('revalidates the owner’s page, not the API path', async () => {
    /*
     * `revalidatePath` silently does nothing when handed a path matching no
     * route, so an API path here would reinstate the stale-gallery defect with
     * nothing failing anywhere. It is a *page* path — see `page-paths.ts`.
     */
    const state = await deleting({ kind: 'loaded', value: null });

    expect(state).toEqual(INITIAL_MEDIA_STATE);
    expect(stub.revalidated).toEqual([`/listings/${LISTING}`]);
  });

  it('treats a photograph that is already gone as success', async () => {
    /*
     * A second tab deleted it, or the button was pressed twice. The owner asked
     * for it to be gone and it is gone — reporting "that photograph no longer
     * exists" would be true and useless, describing a failure to do something
     * that did not need doing.
     */
    const state = await deleting({ kind: 'not-found' });

    expect(state).toEqual(INITIAL_MEDIA_STATE);
    expect(stub.revalidated).toEqual([`/listings/${LISTING}`]);
  });

  it('reports a suspended account without blaming the photograph', async () => {
    const state = await deleting({ kind: 'forbidden' });

    expect(state.status).toBe('error');
    expect(state.message).toContain('suspended');
    expect(stub.revalidated).toEqual([]);
  });

  it('refuses a form with no ids on it rather than sending an empty request', async () => {
    const state = await deleteMediaAction(
      INITIAL_MEDIA_STATE,
      deleteForm({ mediaId: '' }),
    );

    expect(state.status).toBe('error');
    expect(state.message).toContain('could not be identified');
  });

  it('names what failed when the API could not answer', async () => {
    const state = await deleting({ kind: 'unreachable', reason: 'socket hang up' });

    expect(state.message).toBe('That photograph could not be removed — socket hang up');
  });
});

describe('reorderMediaAction', () => {
  it('revalidates on success', async () => {
    const state = await reordering({ kind: 'loaded', value: [] });

    expect(state).toEqual(INITIAL_MEDIA_STATE);
    expect(stub.revalidated).toEqual([`/listings/${LISTING}`]);
  });

  it('treats a 404 as a failure, unlike a delete', async () => {
    /*
     * The asymmetry stated deliberately. A delete finding nothing has achieved
     * what was asked; a reorder finding nothing has not reordered anything, and
     * saying so would be a lie about work that did not happen.
     */
    const state = await reordering({ kind: 'not-found' });

    expect(state.status).toBe('error');
    expect(state.message).toContain('no longer exists');
    expect(stub.revalidated).toEqual([]);
  });

  it('shows the API’s sentence for a stale order, not its misleading reason', async () => {
    /*
     * The service reuses `not-an-image` for an order that does not match the
     * listing's photographs. Rendering the reason would tell an owner their
     * *order* is not an image; the message beside it is accurate.
     */
    const state = await reordering({
      kind: 'refused',
      reason: 'not-an-image',
      message: 'The order must list exactly this listing’s photographs, once each',
    });

    expect(state.message).toBe(
      'The order must list exactly this listing’s photographs, once each',
    );
    expect(state.message).not.toContain('not an image');
  });

  it('refuses an empty order rather than sending one', async () => {
    const state = await reorderMediaAction(INITIAL_MEDIA_STATE, reorderForm([]));

    expect(state.status).toBe('error');
    expect(state.message).toContain('could not be read');
  });

  it('drops blank ids rather than sending them to be refused', async () => {
    stub.outcome = { kind: 'loaded', value: [] };
    stub.revalidated = [];
    const form = new FormData();
    form.set('listingId', LISTING);
    form.append('mediaIds', MEDIA);
    form.append('mediaIds', '  ');

    const state = await reorderMediaAction(INITIAL_MEDIA_STATE, form);

    // One real id survived, so this is a request worth making rather than an
    // empty-order refusal.
    expect(state).toEqual(INITIAL_MEDIA_STATE);
  });
});
