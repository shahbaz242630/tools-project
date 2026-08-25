import type { FetchLike } from '../listings';

/**
 * What a captured request actually carried (slice 2.6c).
 *
 * **This exists because `FetchLike`'s body became `string | Uint8Array`** when
 * the media upload arrived, and every existing assertion read
 * `JSON.parse(init?.body ?? '{}')`. The tempting fix at each call site is
 * `typeof body === 'string' ? body : '{}'`, and it is the wrong one: a request
 * that sent bytes where the test expected JSON would then parse as an empty
 * object and the assertion would compare `{}` against `{}`-shaped nothing —
 * green, and proving the opposite of what it claims.
 *
 * So this throws instead. A body of the wrong kind is a test that has stopped
 * testing what it says, and it should say so.
 */

type CapturedInit = Parameters<FetchLike>[1];

/** The JSON body of a captured call, or a failure saying what it really was. */
export function jsonBodyOf(init: CapturedInit): unknown {
  const body = init?.body;

  if (body === undefined) return undefined;

  if (typeof body !== 'string') {
    throw new Error(
      `Expected a JSON body but the request carried ${String(body.byteLength)} raw bytes. ` +
        'A byte body is an image upload; asserting JSON against it proves nothing.',
    );
  }

  return JSON.parse(body);
}

/** The raw bytes of a captured call, or a failure saying what it really was. */
export function bytesBodyOf(init: CapturedInit): Uint8Array {
  const body = init?.body;

  if (body === undefined || typeof body === 'string') {
    throw new Error(
      `Expected a byte body but the request carried ${
        body === undefined ? 'nothing' : 'a string'
      }.`,
    );
  }

  return body;
}
