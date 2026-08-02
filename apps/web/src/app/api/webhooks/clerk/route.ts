import { verifyWebhook } from '@clerk/nextjs/webhooks';
import type { NextRequest } from 'next/server';
import { forwardIdentityEvent } from '../../../../lib/clerk-webhook';
import { webEnv } from '../../../../lib/env';

/**
 * Where Clerk delivers identity events.
 *
 * A composition root, like the pages: it verifies the signature, forwards the
 * event inward and translates the outcome into a status code. Everything
 * testable lives in `lib/clerk-webhook.ts`.
 *
 * **This is the one browser-reachable route in the application that is not a
 * page, and it is deliberate.** The API is not on the edge network, so a
 * delivery cannot reach it directly; this endpoint exists to be the door. It
 * authenticates by signature rather than by session, because a webhook speaks
 * for a provider and not for a user.
 */
export const dynamic = 'force-dynamic';

/**
 * `NextRequest`, not `Request`.
 *
 * Clerk's own example in the SDK docstring uses `Request` and does not
 * typecheck: `verifyWebhook` accepts `RequestLike`, which is
 * `NextRequest | NextApiRequest | GsspRequest`. Copying the documented form
 * compiles only in a project without strict types.
 */
export async function POST(request: NextRequest): Promise<Response> {
  // Read before verification: `verifyWebhook` consumes the body, and the
  // delivery id lives in the headers rather than the payload. It is the
  // idempotency key on the far side, so without it the event cannot be applied
  // exactly once and must not be applied at all.
  const deliveryId = request.headers.get('svix-id');
  if (deliveryId === null || deliveryId === '') {
    return new Response('missing svix-id', { status: 400 });
  }

  // `event_attributes` is read as well as `data`, and it is a **sibling** of it
  // rather than a field inside it. Clerk puts the request context there for
  // session events — the client IP and user agent — and nowhere else in the
  // webhook. Forwarding `data` alone silently produced a sign-in history with
  // nothing in it but timestamps, which is the shape of bug this route is most
  // likely to hide: everything answers 200 and the record is simply empty.
  let event: { type: string; data: unknown; event_attributes?: unknown };
  try {
    event = await verifyWebhook(request, {
      signingSecret: webEnv().CLERK_WEBHOOK_SIGNING_SECRET,
    });
  } catch {
    // No detail in the response. An unsigned or wrongly-signed request is
    // either a misconfiguration or someone probing, and neither is owed an
    // explanation of which check failed.
    return new Response('invalid signature', { status: 400 });
  }

  const outcome = await forwardIdentityEvent(webEnv().API_BASE_URL, {
    deliveryId,
    type: event.type,
    data: (event.data ?? {}) as Record<string, unknown>,
    // Spread rather than assigned, because `exactOptionalPropertyTypes` draws a
    // distinction between "absent" and "present and undefined" — and here the
    // distinction is real: `user.*` deliveries carry no attributes at all.
    ...(event.event_attributes === undefined
      ? {}
      : { eventAttributes: event.event_attributes as Record<string, unknown> }),
  });

  switch (outcome.kind) {
    case 'accepted':
      return Response.json(outcome.result, { status: 200 });

    case 'rejected':
      // Not retryable. The same body will be refused again, so a 4xx stops
      // Clerk redelivering something that can never succeed.
      return new Response(outcome.reason, { status: 400 });

    case 'failed':
      // Retryable, and we want the retry: the event has not been applied.
      return new Response(outcome.reason, { status: 502 });
  }
}
