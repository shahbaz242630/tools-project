import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LISTING_MEDIA_LIMIT, LISTING_MEDIA_REFUSALS } from '@platform/contracts';
import type { OwnerListingMedia } from '@platform/contracts';

/**
 * The owner's photograph controls (slice 2.6c).
 *
 * **The upload is a `fetch` to a route handler, so it is stubbed here** — what
 * this file tests is what the owner is *told*, which is the half a green API
 * suite cannot see. `LESSONS.md`'s standing lesson is that a passing test cannot
 * notice a false sentence, and six refusal reasons are six sentences.
 *
 * The two server actions are stubbed for the same reason: a `'use server'`
 * module cannot be imported into a jsdom test at all, and what matters here is
 * that the right form carries the right hidden fields.
 */

const actions = vi.hoisted(() => ({
  deleted: [] as Record<string, string>[],
  reordered: [] as { listingId: string; mediaIds: string[] }[],
}));

vi.mock('../app/listings/[id]/media-actions', () => ({
  deleteMediaAction: (_previous: unknown, form: FormData) => {
    actions.deleted.push({
      listingId: String(form.get('listingId')),
      mediaId: String(form.get('mediaId')),
    });
    return Promise.resolve({ status: 'idle', message: null });
  },
  reorderMediaAction: (_previous: unknown, form: FormData) => {
    actions.reordered.push({
      listingId: String(form.get('listingId')),
      mediaIds: form.getAll('mediaIds').map(String),
    });
    return Promise.resolve({ status: 'idle', message: null });
  },
}));

const router = vi.hoisted(() => ({ refreshed: 0 }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: () => {
      router.refreshed += 1;
    },
  }),
}));

import { ListingPhotographs, REFUSAL_SENTENCES } from './listing-photographs';

const LISTING = '8fe74923-e424-421c-b5a2-590280af0fae';

function photograph(n: number): OwnerListingMedia {
  const id = `22222222-2222-4222-8222-00000000000${String(n)}`;
  return {
    id,
    position: n,
    display: { url: `https://bucket.example/${id}/d?sig=1`, width: 1600, height: 1200 },
    thumbnail: { url: `https://bucket.example/${id}/t?sig=1`, width: 400, height: 300 },
  };
}

function photographs(count: number): OwnerListingMedia[] {
  return Array.from({ length: count }, (_, index) => photograph(index));
}

function stubFetch(status: number, body: unknown = {}) {
  // Typed parameters, so `mock.calls[0][0]` is the URL rather than an element of
  // an empty tuple — `vi.fn(() => …)` infers zero arguments.
  const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

function fileOf(name = 'shed.jpg'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
}

describe('with no photographs', () => {
  it('says why one is worth adding rather than merely that there are none', () => {
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    expect(document.body.textContent).toContain('far more likely to be hired');
  });

  it('offers the control', () => {
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    expect(screen.getByLabelText('Add a photograph')).toBeTruthy();
  });

  it('says the first photograph is the one a searcher sees', () => {
    // The whole reason the reorder buttons exist. An owner who does not know
    // this has no reason to touch them.
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    expect(document.body.textContent).toContain(
      'The first photograph is the one people see',
    );
  });

  it('promises the EXIF strip in words an owner cares about', () => {
    /*
     * ADR 0032 spent a whole slice making a listing's position unrecoverable,
     * and a photograph taken in the owner's garden would hand it all back. The
     * pipeline strips it — and an owner uploading a picture of their own drive
     * deserves to be told so before they do it, not after.
     */
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    const text = document.body.textContent ?? '';
    expect(text).toContain('removes the location your camera records');
    expect(text).toContain('does not give away where you live');
  });
});

describe('with photographs', () => {
  it('renders one thumbnail per photograph, in the given order', () => {
    render(<ListingPhotographs listingId={LISTING} media={photographs(3)} />);

    const sources = screen.getAllByRole('img').map((img) => img.getAttribute('src'));
    expect(sources).toHaveLength(3);
    expect(sources[0]).toContain('000000000000');
    expect(sources[2]).toContain('000000000002');
  });

  it('marks which one is shown first', () => {
    render(<ListingPhotographs listingId={LISTING} media={photographs(2)} />);
    expect(screen.getByText('Shown first')).toBeTruthy();
  });

  it('gives the first photograph an alt text saying where it appears', () => {
    render(<ListingPhotographs listingId={LISTING} media={photographs(2)} />);

    expect(screen.getByAltText(/shown on search results/i)).toBeTruthy();
  });

  it('offers no “move earlier” on the first or “move later” on the last', () => {
    // A control that cannot do anything is BRD §15's dead control. With three
    // photographs there are two of each, not three.
    render(<ListingPhotographs listingId={LISTING} media={photographs(3)} />);

    expect(screen.getAllByRole('button', { name: 'Move earlier' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Move later' })).toHaveLength(2);
  });

  it('offers no reorder controls at all for a single photograph', () => {
    render(<ListingPhotographs listingId={LISTING} media={photographs(1)} />);

    expect(screen.queryByRole('button', { name: 'Move earlier' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move later' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });
});

describe('reordering', () => {
  it('sends the whole list with two positions exchanged', async () => {
    actions.reordered = [];
    const user = userEvent.setup();
    const media = photographs(3);
    render(<ListingPhotographs listingId={LISTING} media={media} />);

    // The second photograph's "Move earlier" — the first has none.
    await user.click(screen.getAllByRole('button', { name: 'Move earlier' })[0]!);

    await waitFor(() => {
      expect(actions.reordered).toHaveLength(1);
    });
    expect(actions.reordered[0]?.mediaIds).toEqual([
      media[1]!.id,
      media[0]!.id,
      media[2]!.id,
    ]);
  });

  it('sends every id, so a partial order can never be submitted', async () => {
    /*
     * The service refuses an order that is not exactly the listing's
     * photographs. A control that sent a subset would produce a refusal the
     * owner could do nothing about — so this is the client half of that rule.
     */
    actions.reordered = [];
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={photographs(4)} />);

    await user.click(screen.getAllByRole('button', { name: 'Move later' })[0]!);

    await waitFor(() => {
      expect(actions.reordered[0]?.mediaIds).toHaveLength(4);
    });
    expect(new Set(actions.reordered[0]?.mediaIds).size).toBe(4);
  });
});

describe('removing', () => {
  it('names the photograph it will remove', async () => {
    actions.deleted = [];
    const user = userEvent.setup();
    const media = photographs(2);
    render(<ListingPhotographs listingId={LISTING} media={media} />);

    await user.click(screen.getAllByRole('button', { name: 'Remove' })[1]!);

    await waitFor(() => {
      expect(actions.deleted).toHaveLength(1);
    });
    expect(actions.deleted[0]).toEqual({ listingId: LISTING, mediaId: media[1]!.id });
  });
});

describe('uploading', () => {
  it('posts the file to the route handler', async () => {
    const fetchImpl = stubFetch(201, photograph(0));
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    await user.upload(screen.getByLabelText('Add a photograph'), fileOf());

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalled();
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`/api/listings/${LISTING}/media`);
  });

  it('re-reads the page on success, because the gallery is server-rendered', async () => {
    /*
     * Without this the owner uploads, the request succeeds, and nothing on
     * screen changes — which is indistinguishable from a control that did
     * nothing. It is slice 2.8a's defect in a different component.
     */
    router.refreshed = 0;
    stubFetch(201, photograph(0));
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    await user.upload(screen.getByLabelText('Add a photograph'), fileOf());

    await waitFor(() => {
      expect(router.refreshed).toBe(1);
    });
  });

  it('writes its own sentence for a known reason, not the API’s diagnostic one', async () => {
    /*
     * **The point of the closed `reason` union.** The API's message is precise
     * and useless to an owner — *"The image declares 5000×5000 pixels; the
     * limit is 50000000"* asks somebody to compare two numbers they cannot know
     * about their own photograph. The reason travels beside it so the page can
     * say what to do instead.
     */
    stubFetch(422, {
      reason: 'too-many-pixels',
      message: 'The image declares 5000×5000 pixels; the limit is 50000000',
    });
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    await user.upload(screen.getByLabelText('Add a photograph'), fileOf());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('panorama or a scan');
    expect(alert).not.toHaveTextContent('50000000');
  });

  it('does not blame the owner for a limit they have reached', async () => {
    // `too-many-photographs` is not a mistake. It says what is true and names
    // the way past it.
    stubFetch(422, {
      reason: 'too-many-photographs',
      message: 'A listing may have 10',
    });
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    await user.upload(screen.getByLabelText('Add a photograph'), fileOf());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Remove one');
    expect(alert.textContent ?? '').not.toMatch(/cannot|invalid|failed|wrong/i);
  });

  it('says a storage outage is ours, and that nothing was lost', async () => {
    stubFetch(503, { reason: 'storage-unavailable', message: 'nope' });
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    await user.upload(screen.getByLabelText('Add a photograph'), fileOf());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('problem at our end');
    expect(alert).toHaveTextContent('Nothing about your listing has changed');
  });

  it('falls back to the API’s sentence for a reason it has never heard of', async () => {
    // A newer API. Degrading to the server's own words beats rendering nothing,
    // which is what a `switch` with no default would do.
    stubFetch(422, { reason: 'invented-later', message: 'Some newer rule applies' });
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    await user.upload(screen.getByLabelText('Add a photograph'), fileOf());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Some newer rule applies',
    );
  });

  it('has a sentence for every reason the contract can send', () => {
    /*
     * The guard that stops a seventh reason shipping with no copy. It reaches an
     * owner, so an unwritten one is a blank where a refusal belongs.
     */
    for (const reason of LISTING_MEDIA_REFUSALS) {
      expect(REFUSAL_SENTENCES[reason]).toBeTruthy();
      expect(REFUSAL_SENTENCES[reason].length).toBeGreaterThan(40);
    }
  });

  it('does not refresh the page when the upload was refused', async () => {
    // A refresh would redraw an unchanged gallery under an error message, which
    // reads as the photograph having been accepted and then vanished.
    router.refreshed = 0;
    stubFetch(422, { reason: 'not-an-image', message: 'No' });
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    await user.upload(screen.getByLabelText('Add a photograph'), fileOf());

    await screen.findByRole('alert');
    expect(router.refreshed).toBe(0);
  });

  it('clears the input after a refusal, so the same file can be chosen again', async () => {
    /*
     * **A file input fires `change` only when its value differs.** Leaving a
     * refused filename in place means picking that same file again does nothing
     * at all — no request, no message — and somebody who does not believe the
     * first refusal meets a control that has silently stopped working.
     *
     * jsdom's `user.upload` sets the value and fires `change` regardless, so
     * this assertion cannot reproduce the trap; it pins the line that prevents
     * it. The trap itself was found by using the page.
     */
    stubFetch(422, { reason: 'not-an-image', message: 'No' });
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    const input = screen.getByLabelText('Add a photograph') as HTMLInputElement;
    await user.upload(input, fileOf());

    await screen.findByRole('alert');
    expect(input.value).toBe('');
  });

  it('names the status when the response carries no sentence at all', async () => {
    // An infrastructure error page rather than our JSON. "Something went wrong"
    // gives a tester nothing to report; a number does.
    stubFetch(502, 'not json');
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    await user.upload(screen.getByLabelText('Add a photograph'), fileOf());

    expect(await screen.findByRole('alert')).toHaveTextContent('502');
  });

  it('says nothing was changed when the request never completed', async () => {
    /*
     * **Not "the file was rejected".** Nothing has judged it — the connection
     * dropped — and telling somebody their photograph was refused would send
     * them looking for a fault in a file that is fine.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );
    const user = userEvent.setup();
    render(<ListingPhotographs listingId={LISTING} media={[]} />);

    await user.upload(screen.getByLabelText('Add a photograph'), fileOf());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('did not finish uploading');
    expect(alert).toHaveTextContent('nothing has been changed');
  });
});

describe('at the limit', () => {
  it('replaces the control with a sentence saying what to do instead', () => {
    /*
     * **Explained, not merely absent** — the rule `publish-listing-form.tsx`
     * states. A control that vanishes leaves somebody hunting for something that
     * was there a moment ago, with nothing on the page accounting for it.
     */
    render(
      <ListingPhotographs
        listingId={LISTING}
        media={photographs(LISTING_MEDIA_LIMIT)}
      />,
    );

    expect(screen.queryByLabelText(/Add a/)).toBeNull();
    expect(document.body.textContent).toContain('Remove one to add a different');
  });

  it('still offers the remove control, which is the way back under the limit', () => {
    render(
      <ListingPhotographs
        listingId={LISTING}
        media={photographs(LISTING_MEDIA_LIMIT)}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(
      LISTING_MEDIA_LIMIT,
    );
  });
});

describe('signed URLs', () => {
  it('renders them and keeps nothing', () => {
    /*
     * A signed URL expires in fifteen minutes and may not be persisted, cached
     * or used as a key. The stable handle is the id — so the only place a URL
     * may appear is an `src`, and the only thing sent back to the server is an
     * id. Both halves are asserted, because the second is the one that would go
     * wrong silently.
     */
    actions.deleted = [];
    render(<ListingPhotographs listingId={LISTING} media={photographs(2)} />);

    const hidden = [...document.querySelectorAll('input[type="hidden"]')].map((input) =>
      input.getAttribute('value'),
    );

    expect(hidden.some((value) => value?.includes('sig='))).toBe(false);
    expect(hidden.some((value) => value?.startsWith('https://'))).toBe(false);
  });
});

/**
 * A refusal is about a file, and it stops being true when the gallery changes
 * (slice 2.6c, found by using the page).
 *
 * The upload control keeps its own message and is *not* remounted when a server
 * action revalidates the page — so an owner refused a bad file, then removing a
 * photograph successfully, was left reading a red error underneath a change that
 * had plainly worked.
 */
describe('a stale refusal', () => {
  it('clears when the gallery changes underneath it', async () => {
    stubFetch(422, { reason: 'not-an-image', message: 'No' });
    const user = userEvent.setup();
    const media = photographs(2);
    const { rerender } = render(
      <ListingPhotographs listingId={LISTING} media={media} />,
    );

    await user.upload(screen.getByLabelText('Add another photograph'), fileOf());
    expect(await screen.findByRole('alert')).toBeTruthy();

    // What a delete looks like from this component's side: the same instance,
    // re-rendered with one fewer photograph.
    rerender(<ListingPhotographs listingId={LISTING} media={[media[0]!]} />);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears on a reorder, which changes neither the count nor the set', async () => {
    // The reason the key is the ids rather than the length.
    stubFetch(422, { reason: 'not-an-image', message: 'No' });
    const user = userEvent.setup();
    const media = photographs(2);
    const { rerender } = render(
      <ListingPhotographs listingId={LISTING} media={media} />,
    );

    await user.upload(screen.getByLabelText('Add another photograph'), fileOf());
    expect(await screen.findByRole('alert')).toBeTruthy();

    rerender(<ListingPhotographs listingId={LISTING} media={[media[1]!, media[0]!]} />);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('survives a re-render that changed nothing, so a real refusal is not swallowed', async () => {
    stubFetch(422, { reason: 'not-an-image', message: 'No' });
    const user = userEvent.setup();
    const media = photographs(2);
    const { rerender } = render(
      <ListingPhotographs listingId={LISTING} media={media} />,
    );

    await user.upload(screen.getByLabelText('Add another photograph'), fileOf());
    expect(await screen.findByRole('alert')).toBeTruthy();

    rerender(<ListingPhotographs listingId={LISTING} media={media} />);

    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
