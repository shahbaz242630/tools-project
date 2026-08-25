'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  LISTING_MEDIA_ACCEPT,
  LISTING_MEDIA_LIMIT,
  LISTING_MEDIA_MAX_BYTES,
  LISTING_MEDIA_REFUSALS,
} from '@platform/contracts';
import type { ListingMediaRefusal, OwnerListingMedia } from '@platform/contracts';
import { useRouter } from 'next/navigation';
import {
  deleteMediaAction,
  reorderMediaAction,
} from '../app/listings/[id]/media-actions';
import { INITIAL_MEDIA_STATE } from '../app/listings/[id]/media-state';
import type { MediaActionState } from '../app/listings/[id]/media-state';
import { listingMediaUploadPath } from '../lib/page-paths';
import styles from './listing-photographs.module.css';

/**
 * An owner's photographs of their own item (slice 2.6c).
 *
 * **The first thing in this application that puts a picture on a page.** Every
 * layer beneath it was finished before this slice: the EXIF-stripping pipeline
 * (2.6a), the bucket and the owner's three routes (2.6b-i), the public
 * projection (2.6b-ii). This is markup over a contract that was already done.
 *
 * ## Three decisions worth not re-opening
 *
 * **No drag-and-drop.** Reordering is two buttons per photograph. A drag
 * surface needs a keyboard path anyway to be usable at all, and once that path
 * exists the drag is a second way to do the same thing — more code, more state,
 * and the accessible route is the one that gets tested less. Buttons are what a
 * person on a phone can hit, which is where these photographs are taken.
 *
 * **The upload posts to a route handler rather than a server action**, because
 * a server action's body is capped at 1 MB and a phone photograph is not. See
 * `app/api/listings/[id]/media/route.ts`, which explains the whole trade.
 *
 * **Nothing here persists a signed URL.** The `url` on each image is minted per
 * response and expires in fifteen minutes; the `id` beside it is the stable
 * handle, and it is the only thing this component keeps or sends.
 */
export function ListingPhotographs({
  listingId,
  media,
}: {
  readonly listingId: string;
  readonly media: readonly OwnerListingMedia[];
}) {
  const full = media.length >= LISTING_MEDIA_LIMIT;

  return (
    <section className={styles.section} aria-labelledby="photographs-heading">
      <h2 className={styles.heading} id="photographs-heading">
        Photographs
      </h2>

      {/*
        **Said once, above both the gallery and the control.** The first
        photograph is the one a stranger sees on a search card, and an owner who
        does not know that has no reason to reorder anything. It is the entire
        purpose of the reorder buttons, so it is stated where they are.
      */}
      <p className={styles.intro}>
        The first photograph is the one people see when your item comes up in a search.
        You can add up to {LISTING_MEDIA_LIMIT}.
      </p>

      {media.length === 0 ? (
        <p className={styles.empty}>
          No photographs yet. An item with a photograph is far more likely to be hired —
          one clear picture of the whole thing is enough to start.
        </p>
      ) : (
        <Gallery listingId={listingId} media={media} />
      )}

      <UploadControl
        listingId={listingId}
        full={full}
        count={media.length}
        /*
         * **What the gallery currently holds, so a stale refusal can clear
         * itself** (found by using the page, slice 2.6c). The upload control
         * keeps its own message and is not remounted when a server action
         * revalidates the page — so an owner who was refused a bad file and
         * then successfully *removed* a photograph was left reading a red
         * error underneath a change that had plainly worked.
         *
         * The ids rather than the count: a reorder changes neither the length
         * nor the set, and it is still the gallery changing under the message.
         */
        mediaKey={media.map((item) => item.id).join(',')}
      />
    </section>
  );
}

/**
 * The photographs, in the owner's order.
 *
 * **Keyed by `id`, never by index.** A delete shifts every later index by one,
 * and a list keyed by position would have React reuse the removed photograph's
 * DOM node — and with it whichever form was mid-submission inside it.
 */
function Gallery({
  listingId,
  media,
}: {
  readonly listingId: string;
  readonly media: readonly OwnerListingMedia[];
}) {
  return (
    <ol className={styles.gallery}>
      {media.map((photograph, index) => (
        <li className={styles.item} key={photograph.id}>
          <img
            alt={
              index === 0
                ? 'The first photograph of your item, shown on search results'
                : `Photograph ${String(index + 1)} of your item`
            }
            className={styles.image}
            height={photograph.thumbnail.height}
            src={photograph.thumbnail.url}
            width={photograph.thumbnail.width}
          />

          {index === 0 ? <p className={styles.badge}>Shown first</p> : null}

          <MediaControls
            index={index}
            listingId={listingId}
            media={media}
            photograph={photograph}
          />
        </li>
      ))}
    </ol>
  );
}

/**
 * Move and remove, for one photograph.
 *
 * **Three forms rather than one with a hidden intent field.** Each submits to
 * the action it means, so no branch decides what a press was for — and the two
 * reorder forms differ only in the array they carry, which is computed here
 * where the whole list is in scope.
 */
function MediaControls({
  index,
  listingId,
  media,
  photograph,
}: {
  readonly index: number;
  readonly listingId: string;
  readonly media: readonly OwnerListingMedia[];
  readonly photograph: OwnerListingMedia;
}) {
  const ids = media.map((item) => item.id);
  const position = `${String(index + 1)} of ${String(media.length)}`;

  return (
    <div className={styles.controls}>
      {index > 0 ? (
        <ReorderForm
          label="Move earlier"
          listingId={listingId}
          order={swap(ids, index, index - 1)}
          title={`Move photograph ${position} earlier`}
        />
      ) : null}

      {index < media.length - 1 ? (
        <ReorderForm
          label="Move later"
          listingId={listingId}
          order={swap(ids, index, index + 1)}
          title={`Move photograph ${position} later`}
        />
      ) : null}

      <DeleteForm
        listingId={listingId}
        mediaId={photograph.id}
        title={`Remove photograph ${position}`}
      />
    </div>
  );
}

/** Two positions exchanged — the whole list, because the contract takes it. */
function swap(ids: readonly string[], from: number, to: number): readonly string[] {
  const next = [...ids];
  const moved = next[from];
  const displaced = next[to];
  if (moved === undefined || displaced === undefined) return ids;
  next[from] = displaced;
  next[to] = moved;
  return next;
}

function ReorderForm({
  label,
  listingId,
  order,
  title,
}: {
  readonly label: string;
  readonly listingId: string;
  readonly order: readonly string[];
  readonly title: string;
}) {
  const [state, action, pending] = useActionState(
    reorderMediaAction,
    INITIAL_MEDIA_STATE,
  );

  return (
    <form action={action} className={styles.control}>
      <input name="listingId" type="hidden" value={listingId} />
      {/*
        One field per id rather than one joined string, so the action reads the
        order with `getAll` and never has to split, trim or defend a separator.
      */}
      {order.map((id) => (
        <input key={id} name="mediaIds" type="hidden" value={id} />
      ))}

      <button className={styles.button} disabled={pending} title={title} type="submit">
        {label}
      </button>

      <Outcome state={state} />
    </form>
  );
}

/**
 * Remove one photograph.
 *
 * **No confirmation dialog**, and that is a deliberate reading of the project's
 * own rule rather than an omission. `window.confirm` blocks the page and is the
 * one thing browser automation cannot get past; more to the point, this is a
 * reversible action in the only sense that matters — the owner can upload the
 * photograph again, because it is still on their phone. The controls that *are*
 * one-way doors in this product say so in words beside the button, and this is
 * not one of them.
 */
function DeleteForm({
  listingId,
  mediaId,
  title,
}: {
  readonly listingId: string;
  readonly mediaId: string;
  readonly title: string;
}) {
  const [state, action, pending] = useActionState(
    deleteMediaAction,
    INITIAL_MEDIA_STATE,
  );

  return (
    <form action={action} className={styles.control}>
      <input name="listingId" type="hidden" value={listingId} />
      <input name="mediaId" type="hidden" value={mediaId} />

      <button
        className={`${styles.button} ${styles.remove}`}
        disabled={pending}
        title={title}
        type="submit"
      >
        {pending ? 'Removing…' : 'Remove'}
      </button>

      <Outcome state={state} />
    </form>
  );
}

/** Whatever went wrong, or nothing. Success is the gallery having changed. */
function Outcome({ state }: { readonly state: MediaActionState }) {
  if (state.status !== 'error' || state.message === null) return null;
  return (
    <p className={styles.error} role="alert">
      {state.message}
    </p>
  );
}

/**
 * Adding one.
 *
 * **A `fetch` rather than a form submission**, because the target is a route
 * handler and a native submit would navigate the browser to its JSON response.
 * That makes this the one control on the page needing JavaScript — and the
 * reason is the 1 MB server-action cap, not a preference.
 */
function UploadControl({
  listingId,
  full,
  count,
  mediaKey,
}: {
  readonly listingId: string;
  readonly full: boolean;
  readonly count: number;
  /** The gallery's current contents; see the call site for why it is here. */
  readonly mediaKey: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  /*
   * **An object with a sequence number, not a bare string** — and the difference
   * is the whole defect 2.4c-ii found. Two identical refusals in a row (the same
   * oversized file chosen twice) produce the same sentence, and `setState` with
   * an equal string neither re-renders nor re-runs the effect that moves focus.
   * The page would sit perfectly still exactly when somebody is most likely to
   * conclude the control is broken. The counter makes every outcome distinct.
   */
  const [outcome, setOutcome] = useState<{
    readonly message: string;
    readonly seq: number;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const anchor = useOutcomeFocus(outcome);
  const message = outcome?.message ?? null;

  const report = useCallback((text: string) => {
    setOutcome((previous) => ({ message: text, seq: (previous?.seq ?? 0) + 1 }));
  }, []);

  /*
   * **A refusal is about a file, and it stops being true when the gallery
   * changes.** Removing a photograph or reordering one succeeds through a server
   * action, which revalidates the page without remounting this component — so
   * without this the owner reads a red error about a file they abandoned,
   * sitting under a change that visibly worked.
   *
   * It cannot swallow a fresh refusal: a refused upload leaves the gallery
   * exactly as it was, so this does not fire.
   */
  useEffect(() => {
    setOutcome(null);
  }, [mediaKey]);

  const upload = useCallback(
    async (file: File) => {
      setOutcome(null);
      setUploading(true);

      try {
        const body = new FormData();
        body.append('photograph', file);

        const response = await fetch(listingMediaUploadPath(listingId), {
          method: 'POST',
          body,
        });

        if (response.ok) {
          /*
           * **`router.refresh()`, because the page is a server component.**
           * The photographs are read on the server, so nothing changes on
           * screen until it re-reads them — and an upload that visibly did
           * nothing is indistinguishable from one that failed.
           */
          router.refresh();
          return;
        }

        report(await sentenceIn(response));
      } catch {
        /*
         * The request never completed — a dropped connection, or the tab going
         * offline mid-upload. Not "the file was rejected": nothing has judged
         * it yet, and saying otherwise would send somebody looking for a fault
         * in a photograph that is fine.
         */
        report(
          'That photograph did not finish uploading. Check your connection and try again — nothing has been changed.',
        );
      } finally {
        setUploading(false);

        /*
         * **Cleared however it went, not only on success** — and the failure
         * path is the one that needs it. A file input fires `change` only when
         * its value differs, so leaving a refused filename in place means
         * choosing *that same file again* does nothing at all: no request, no
         * message, no spinner. Somebody who refuses to believe the first
         * refusal — which is the commonest thing a person does — meets a
         * control that has silently stopped working.
         *
         * Found by using the page, not by a test: jsdom's `user.upload` sets
         * the value directly and fires `change` regardless, so this trap is
         * invisible to the suite that covers everything around it.
         */
        if (input.current !== null) input.current.value = '';
      }
    },
    [listingId, router, report],
  );

  if (full) {
    return (
      <p className={styles.full}>
        This listing has all {LISTING_MEDIA_LIMIT} photographs. Remove one to add a
        different photograph.
      </p>
    );
  }

  return (
    <div className={styles.upload}>
      <label className={styles.label} htmlFor="photograph">
        {count === 0 ? 'Add a photograph' : 'Add another photograph'}
      </label>

      <input
        accept={LISTING_MEDIA_ACCEPT}
        className={styles.file}
        disabled={uploading}
        id="photograph"
        name="photograph"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void upload(file);
        }}
        ref={input}
        type="file"
      />

      <p className={styles.hint}>
        Up to {megabytes(LISTING_MEDIA_MAX_BYTES)} each. Photographs are re-saved when
        they arrive, which removes the location your camera records in them — so a
        picture taken at home does not give away where you live.
      </p>

      {uploading ? (
        <p className={styles.pending} role="status">
          Uploading…
        </p>
      ) : null}

      <div ref={anchor} tabIndex={-1}>
        {message === null ? null : (
          <p className={styles.error} role="alert">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * What to say for each way an upload can be refused.
 *
 * **This is what the closed `reason` union is for, and the API's own message is
 * not a substitute.** The API writes for whoever is reading a log: *"The image
 * declares 5000×5000 pixels; the limit is 50000000"* is precise, correct, and
 * asks a person to compare two numbers they have no way to know about their own
 * photograph. `media.ts` says the reason travels beside the message *"so a page
 * can say why"* — this is the page doing that.
 *
 * **Two of the six are not the owner's fault and must not read as blame.**
 * `too-many-photographs` is a limit they have reached, not a mistake they made;
 * `storage-unavailable` is ours entirely. Both say what is true about *us* and
 * what will make it work.
 *
 * Each sentence answers "what do I do now", because a refusal that does not is
 * a dead end wearing an explanation's clothes.
 */
export const REFUSAL_SENTENCES: Record<ListingMediaRefusal, string> = {
  'too-many-bytes':
    'That photograph is too big to upload — the limit is 15 MB. Most phones can send a smaller copy: choose a medium size when sharing, or take the picture again at a lower resolution.',

  'too-many-pixels':
    'That photograph is too large to process. The file size is fine, but the picture itself has too many pixels — that usually means a panorama or a scan. An ordinary photograph of the item will work.',

  'unsupported-format':
    'We cannot use that kind of file. Photographs taken on a phone or camera work — JPEG, PNG, HEIC and WebP are all fine.',

  'not-an-image':
    'That file is not a photograph we can read. If it came straight from a phone or camera, try it once more; if it was renamed to end in .jpg, that is the likely cause.',

  // Not their fault: a limit reached, and the way past it named.
  'too-many-photographs':
    'This listing already has all 10 photographs, which is the most we store. Remove one you like least and this one will go up in its place.',

  // Ours entirely. It says so, and it says nothing was lost.
  'storage-unavailable':
    'We could not store that photograph just now — that is a problem at our end, not with your picture. Nothing about your listing has changed. Please try again in a few minutes.',
};

/**
 * The sentence for a refusal.
 *
 * **The reason first, the API's message only as a fallback.** An unrecognised
 * reason — a newer API than this build — degrades to the server's own sentence
 * rather than to silence, and a body with neither names the status so that a
 * tester's report carries something to act on instead of "it didn't work".
 */
async function sentenceIn(response: {
  status: number;
  json: () => Promise<unknown>;
}): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const { message, reason } = body as { message?: unknown; reason?: unknown };

      if (typeof reason === 'string') {
        const known = LISTING_MEDIA_REFUSALS.find((value) => value === reason);
        if (known !== undefined) return REFUSAL_SENTENCES[known];
      }

      if (typeof message === 'string' && message !== '') return message;
    }
  } catch {
    // A body that is not JSON — an infrastructure error page, most likely.
  }

  return `That photograph could not be uploaded (${String(response.status)}). Nothing has been changed.`;
}

/**
 * Move to the outcome rather than leaving it below the fold.
 *
 * Session 25 found this the hard way on the listing form, and this control sits
 * at the bottom of a long page. **Keyed on the whole outcome, not on its
 * sentence** — that is the 2.4c-ii defect and the reason the caller carries a
 * sequence number: two identical refusals compare equal as strings, and an
 * effect that skips the second one leaves the page perfectly still exactly when
 * somebody is most likely to conclude it is stuck.
 */
function useOutcomeFocus(
  outcome: { readonly message: string; readonly seq: number } | null,
): RefObject<HTMLDivElement | null> {
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (outcome === null) return;
    anchor.current?.focus();
    // Optional call: jsdom does not implement `scrollIntoView`, and a component
    // that throws where a method is merely absent cannot be tested without the
    // test knowing about the browser.
    anchor.current?.scrollIntoView?.({ block: 'center' });
  }, [outcome]);

  return anchor;
}

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}
