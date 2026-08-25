import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { LISTING_MEDIA_MAX_BYTES } from '@platform/contracts';
import { clientIpFrom } from '../../../../../lib/client-ip';
import { webEnv } from '../../../../../lib/env';
import { uploadListingMedia } from '../../../../../lib/listing-media';

/**
 * Uploading one photograph of your own listing (slice 2.6c).
 *
 * **This is the third browser-reachable non-page route in the application**,
 * after the Clerk webhook and the data-export download, and CLAUDE.md asks that
 * adding one be a deliberate act rather than a convenience. Here is the
 * deliberation.
 *
 * **A server action cannot carry the file.** Next caps a server action's body at
 * **1 MB** by default (`serverActions.bodySizeLimit`), and the API accepts up to
 * `LISTING_MEDIA_MAX_BYTES` — 15 MB, sized for a phone photograph. Every real
 * upload would therefore fail *before any of our code ran*, with a framework
 * error rather than one of the six refusal reasons the page knows how to
 * explain. Raising that limit is the alternative and it is the worse one: it
 * raises the body cap for **every** action in the application, so one route that
 * needs a large body would make every route willing to buffer one.
 *
 * **The API route behind this is not weakened by it.** `POST /listings/:id/media`
 * is `@UseGuards(AuthGuard, RateLimitGuard)` with `@RateLimit('write')` and is
 * refused for a suspended account. This handler adds a Clerk session check in
 * front — so an unauthenticated caller never reaches the API at all — and
 * forwards the bearer token, meaning ownership is still decided in exactly one
 * place. It confers no authority of its own.
 *
 * **It is not an API.** It accepts one file for one authenticated person and
 * returns the photograph as JSON for the control that posted it. The API itself
 * remains unreachable from the internet.
 *
 * ## Multipart in, raw bytes out
 *
 * The browser sends `multipart/form-data`, because that is what a file input
 * produces and what `request.formData()` reads without a dependency. The API
 * takes raw `application/octet-stream` and deliberately has no multipart parser
 * — multipart exists to carry several named parts and that request has exactly
 * one thing in it. Unpacking here is precisely the division
 * `owner-listing-media.controller.ts` documents.
 */

/** The form field the file arrives in. */
export const PHOTOGRAPH_FIELD = 'photograph';

/**
 * Never prerendered, never cached.
 *
 * A route that mints signed URLs against somebody's own listing has nothing a
 * shared cache may keep.
 */
export const dynamic = 'force-dynamic';

interface Refusal {
  readonly status: number;
  readonly message: string;
  readonly reason?: string;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
    },
  });
}

function refuse({ status, message, reason }: Refusal): Response {
  return json({ message, ...(reason === undefined ? {} : { reason }) }, status);
}

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  const { id } = await params;

  const { getToken } = await auth();
  const token = await getToken();

  /*
   * **Refused here rather than forwarded as an anonymous request.** The API
   * would answer 401 anyway, so this is not the control — it is the difference
   * between a signed-out browser reaching our API and not.
   */
  if (token === null || token === '') {
    return refuse({
      status: 401,
      message:
        'You are not signed in, so nothing was uploaded. Your session may have ' +
        'expired — sign in again and try the photograph once more.',
    });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    /*
     * A body that is not multipart at all. 400 rather than 415: the caller sent
     * something this route cannot read, and the sentence says what it wanted.
     */
    return refuse({
      status: 400,
      message: `Send the photograph as a multipart form field named ${PHOTOGRAPH_FIELD}.`,
    });
  }

  const part = form.get(PHOTOGRAPH_FIELD);
  if (!(part instanceof File)) {
    return refuse({
      status: 400,
      message: `Send the photograph as a multipart form field named ${PHOTOGRAPH_FIELD}.`,
    });
  }

  /*
   * **Checked before buffering, and it is the reason the size is worth knowing
   * here at all.** `File.size` is known without reading the stream, so a 40 MB
   * file is refused having allocated nothing. Reading it first to measure it
   * would make the check the very thing it exists to prevent.
   *
   * **The API still checks.** This is a courtesy that saves an upload, not a
   * control — `prepareImage` refuses the same bytes on arrival, and a caller
   * bypassing this route entirely cannot reach the API at all.
   */
  if (part.size > LISTING_MEDIA_MAX_BYTES) {
    return refuse({
      status: 413,
      reason: 'too-many-bytes',
      message: `That photograph is ${megabytes(part.size)} and the limit is ${megabytes(
        LISTING_MEDIA_MAX_BYTES,
      )}. Most phones can send a smaller copy — try “Actual size: Medium” when sharing, or take the photograph again at a lower resolution.`,
    });
  }

  if (part.size === 0) {
    return refuse({
      status: 400,
      reason: 'not-an-image',
      message: 'That file is empty, so there was nothing to upload.',
    });
  }

  const bytes = new Uint8Array(await part.arrayBuffer());
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await uploadListingMedia(
    webEnv().API_BASE_URL,
    token,
    id,
    bytes,
    undefined,
    clientIp,
  );

  switch (outcome.kind) {
    case 'loaded':
      return json(outcome.value, 201);

    case 'refused':
      // 422, carrying the API's own reason and sentence — the control that
      // posted this reads both: the reason to decide whose fault it is, the
      // sentence to say what happened.
      return refuse({
        status: 422,
        reason: outcome.reason,
        message: outcome.message,
      });

    case 'unavailable':
      return refuse({
        status: 503,
        reason: 'storage-unavailable',
        message: outcome.message,
      });

    case 'not-found':
      /*
       * 404 for somebody else's listing, never 403 — the controller's rule, and
       * this route must not soften it. A 403 here would confirm the listing
       * exists, which is the thing the check protects.
       */
      return refuse({
        status: 404,
        message: 'That listing no longer exists, or it is not yours.',
      });

    case 'forbidden':
      return refuse({
        status: 403,
        message:
          'You cannot add photographs while your account is suspended. You can ' +
          'still read and export everything you have.',
      });

    case 'signed-out':
      // Reached when the token was live when this route read it and rejected by
      // the API a moment later. The state first, the likeliest cause second.
      return refuse({
        status: 401,
        message:
          'You are not signed in, so nothing was uploaded. Your session may ' +
          'have expired — sign in again and try the photograph once more.',
      });

    case 'invalid':
      return refuse({
        status: 400,
        message: outcome.issues[0] ?? 'That photograph was not accepted.',
      });

    /*
     * `stale-category` cannot arrive here — nothing about a photograph reads a
     * category version — and it is listed rather than swept into the default so
     * that a reader can tell an unreachable branch from a forgotten one.
     */
    case 'stale-category':
    case 'malformed':
    case 'unreachable':
      // 502, not 500: the failure is upstream of this route, and saying so
      // distinguishes "the API could not answer" from "this route is broken".
      return refuse({
        status: 502,
        message: `That photograph could not be uploaded — ${outcome.reason}`,
      });
  }
}

/**
 * A byte count as something a person can compare to what their phone says.
 *
 * **One decimal, and the `no-tofixed` waiver below is the interesting part.**
 * That rule exists because `toFixed` is how a float creeps into a *total* —
 * ADR 0002 makes money integer pence precisely so no arithmetic like this can
 * touch it. A file size is not money: it is bytes the browser measured, it is
 * never summed, never stored, never charged, and it reaches nothing but a
 * sentence. Whole megabytes would be worse copy here — a 15.7 MB file refused
 * with *"that photograph is 15 MB and the limit is 15 MB"* reads as a bug.
 */
function megabytes(bytes: number): string {
  // invariant-ok: no-tofixed — a file size for a sentence, never money; see above
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
