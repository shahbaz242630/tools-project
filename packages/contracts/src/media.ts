/**
 * Photographs of a listed item — the wire types and the routes (slice 2.6b-i).
 *
 * **Its own file rather than part of `listings.ts`**, on the argument that file
 * already makes for itself: a listing acquires media, a fuzzed location, prices
 * and availability, and each of those is a concern with its own vocabulary. A
 * single file holding all of them is one nobody can read a change in.
 *
 * BRD §6.2's `Listing media` entity. The bytes never appear here — a photograph
 * reaches a browser only through a short-lived signed URL the API mints, and the
 * upload travels as raw bytes rather than as anything this file describes.
 */

import { z } from 'zod';
import { parseWith } from './parse.js';

/**
 * How many photographs one listing may carry.
 *
 * **A third kind of bound, and `limits.ts` is worth reading before assuming it
 * is one of the two already there.** ADR 0035 distinguishes a bound nobody
 * should ever meet — a guardrail against a bug — from a page size, which is met
 * constantly and is part of the product. This is neither: it is a **product
 * rule** that owners will meet deliberately and be refused by, on purpose.
 *
 * Ten is enough to show an item from every angle plus its accessories and any
 * damage worth disclosing, and it is the number that keeps the arithmetic
 * comfortable: at roughly 250 KB per stored display rendition, ten photographs
 * per listing means 10 GB holds about four thousand fully-photographed listings.
 * The cap is what makes storage a function of how many listings exist rather
 * than of how much anybody feels like uploading.
 *
 * **Not category configuration, deliberately, and here is the trigger for
 * changing that.** Everything a category varies — fees, attributes, deposit
 * bands, the duration cap — is a rule about the *hire*. A photograph count is a
 * platform cost control that happens to be expressed per listing. It moves to
 * `category_versions` the day a category genuinely wants a different number,
 * which is a migration and an admin field rather than a constant edit.
 */
export const LISTING_MEDIA_LIMIT = 10;

/**
 * The largest file the API will look at, refused before a decoder sees it.
 *
 * **Moved here from `prepare-image.ts` in slice 2.6c, because two sides need
 * it.** The API refuses above this and always will — that is the control. The
 * browser needs the same number to say so *before* spending a minute uploading
 * something that was never going to be accepted, and to write the sentence that
 * names the limit. A number duplicated in the page would be the one that drifts
 * the day the cap moves, and the drift is invisible: the page would keep
 * refusing at the old figure while the API accepted more, or promise the upload
 * and have it refused at the far end.
 *
 * A 12-megapixel phone JPEG is 2–8 MB and an iPhone HEIC is 2–3 MB, so 15 MB
 * clears any real camera with room to spare. It is the cheapest of the pipeline's
 * limits — it costs a length check — and it is the one that stops the pipeline
 * being a place to spend our CPU.
 *
 * **It is not the decompression-bomb limit.** `MAX_INPUT_PIXELS` stays in the
 * API and stays there deliberately: a 100 KB PNG can declare 50,000 × 50,000
 * pixels, so the pixel cap is invisible to a browser holding only a file size
 * and cannot be pre-checked. Anything the page cannot honestly check itself is
 * the API's alone.
 */
export const LISTING_MEDIA_MAX_BYTES = 15 * 1024 * 1024;

/**
 * What a file input should offer, as MIME types.
 *
 * **A hint, not a control**, and the distinction is the reason this is safe to
 * keep beside the real list rather than derived from it. A browser file input's
 * `accept` filters a picker that every platform lets you override, so the API's
 * `ACCEPTED_INPUT_FORMATS` remains the only thing that decides. This exists so
 * the picker shows photographs rather than every file on the machine.
 *
 * **`image/heic` and `image/heif` are both here for one API-side format.** They
 * are the same container and platforms disagree about which they report; an
 * iPhone photograph is the case that matters, and omitting either is how it
 * silently stops appearing in the picker.
 *
 * `listing-media-accept.test.ts` in the API fails if this drifts from the
 * formats actually accepted — which is what makes a hint safe to state twice.
 */
export const LISTING_MEDIA_ACCEPT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/tiff',
] as const;

/** The same list as a file input's `accept` attribute. */
export const LISTING_MEDIA_ACCEPT = LISTING_MEDIA_ACCEPT_TYPES.join(',');

/** Where a photograph's bytes are served from, and how long that URL lasts. */
export interface ListingMediaImage {
  /**
   * A signed URL, valid for minutes rather than for the life of the listing.
   *
   * **Not a stable address, and nothing may treat it as one.** It is minted per
   * response from the object store's credential, so it must not be persisted,
   * cached beyond its life, or used as a key. A listing's photograph has an id;
   * this is only the current way to fetch it.
   */
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/**
 * One photograph, as its owner sees it.
 *
 * Owner and public projections are the same shape today and are still **two
 * types**, built field by field. The rule this repo enforces is that a narrower
 * projection is a separate type rather than the wide one with fields deleted —
 * and the moment a moderation state or an upload timestamp belongs on the
 * owner's view and not the public one, a shared type would have to be split
 * under pressure instead of extended calmly.
 */
export interface OwnerListingMedia {
  readonly id: string;
  readonly position: number;
  readonly display: ListingMediaImage;
  readonly thumbnail: ListingMediaImage;
}

export const listingMediaImageSchema = z.strictObject({
  url: z.url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const ownerListingMediaSchema = z.strictObject({
  id: z.uuid(),
  position: z.number().int().nonnegative(),
  display: listingMediaImageSchema,
  thumbnail: listingMediaImageSchema,
});

export function parseOwnerListingMedia(raw: unknown): OwnerListingMedia {
  return parseWith(ownerListingMediaSchema, 'The photograph', raw);
}

/**
 * One photograph, as anybody on the internet sees it (slice 2.6b-ii).
 *
 * **A third type for the same row, and the narrowing is the point.** It carries
 * no `position`, and that is not tidiness — it is the one field on the owner's
 * shape that can *lie* to a reader. `listing_media` has no unique constraint on
 * `(listingId, position)` deliberately, because a reorder needs an intermediate
 * state where two rows briefly share one and Prisma cannot express DEFERRABLE.
 * Duplicates are therefore representable, and what makes them harmless is that
 * every read orders by `(position, createdAt, id)` — a total order whatever the
 * data says. The array order is that total order. A position number sent beside
 * it would be a second, weaker statement of the same fact, and the day two rows
 * share a `2` the two would disagree in public.
 *
 * The owner's shape keeps it because an owner reorders and needs a handle to
 * reorder *by*. A reader only needs them in order, and they are.
 */
export interface PublicListingMedia {
  readonly id: string;
  readonly display: ListingMediaImage;
  readonly thumbnail: ListingMediaImage;
}

export const publicListingMediaSchema = z.strictObject({
  id: z.uuid(),
  display: listingMediaImageSchema,
  thumbnail: listingMediaImageSchema,
});

export const ownerListingMediaListSchema = z.strictObject({
  media: z.array(ownerListingMediaSchema),
});

export function parseOwnerListingMediaList(raw: unknown): {
  readonly media: readonly OwnerListingMedia[];
} {
  return parseWith(ownerListingMediaListSchema, 'The photographs', raw);
}

/**
 * The order an owner has put their photographs in.
 *
 * **The whole list, not a move-this-one-here instruction.** A reorder expressed
 * as a pair of positions has to be applied against the order the caller was
 * looking at, and two tabs open on the same listing produce an order neither
 * person asked for. Sending the complete list makes the request idempotent and
 * makes the last writer's intent the one that lands — which is what a person
 * dragging thumbnails actually means.
 *
 * Bounded at `LISTING_MEDIA_LIMIT` so a caller cannot make the server sort an
 * arbitrarily long array, and the ids are validated against what the listing
 * actually holds by the service, not here.
 */
export const listingMediaOrderSchema = z.strictObject({
  mediaIds: z.array(z.uuid()).min(1).max(LISTING_MEDIA_LIMIT),
});

export type ListingMediaOrderInput = z.infer<typeof listingMediaOrderSchema>;

export function parseListingMediaOrder(raw: unknown): ListingMediaOrderInput {
  return parseWith(listingMediaOrderSchema, 'The order', raw);
}

/**
 * Why an upload was refused, as the API reports it.
 *
 * The four from `prepareImage` plus the two the service adds. A closed union
 * because it reaches a sentence shown to an owner and a metric label, and free
 * text in either is a defect — the second mints an unbounded series.
 */
export const LISTING_MEDIA_REFUSALS = [
  'too-many-bytes',
  'too-many-pixels',
  'unsupported-format',
  'not-an-image',
  'too-many-photographs',
  'storage-unavailable',
] as const;

export type ListingMediaRefusal = (typeof LISTING_MEDIA_REFUSALS)[number];

export function listingMediaPath(listingId: string): string {
  return `/listings/${encodeURIComponent(listingId)}/media`;
}

export const LISTING_MEDIA_ROUTE = '/listings/:id/media';

export function listingMediaItemPath(listingId: string, mediaId: string): string {
  return `/listings/${encodeURIComponent(listingId)}/media/${encodeURIComponent(mediaId)}`;
}

export const LISTING_MEDIA_ITEM_ROUTE = '/listings/:id/media/:mediaId';

export function listingMediaOrderPath(listingId: string): string {
  return `/listings/${encodeURIComponent(listingId)}/media/order`;
}

/**
 * `PUT`, not `PATCH`, and the reason is the same one `ADMIN_LISTING_MODERATION_ROUTE`
 * gives: the decision replaces whatever the previous one was rather than
 * amending it.
 *
 * It shares a path shape with `LISTING_MEDIA_ITEM_ROUTE`
 * (`/listings/:id/media/:mediaId`) and **does not collide with it**, because the
 * two carry different verbs — `PUT` here, `DELETE` there. Worth stating rather
 * than leaving to be rediscovered: the day somebody adds `DELETE .../media/order`
 * or `PUT .../media/:mediaId`, `order` is not a UUID and the ambiguity becomes
 * real. Fastify's router prefers a static segment over a parameter, so the
 * failure would be a 404 rather than a wrong row, but it would still be a
 * surprise worth having been warned about.
 */
export const LISTING_MEDIA_ORDER_ROUTE = '/listings/:id/media/order';
