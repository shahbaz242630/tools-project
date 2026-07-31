/**
 * UK postcode primitive.
 *
 * A postcode is two pieces of information with very different privacy weights,
 * and keeping them apart is the whole reason this file exists.
 *
 * The **outward code** — `BS7`, `SW1A`, `M1` — identifies a postal district
 * covering thousands of addresses. The **inward code** — `8AA` — narrows that to
 * a delivery point averaging around fifteen households, and for large buildings
 * or businesses to exactly one. A full postcode beside a name is close enough to
 * an address to find someone on the electoral roll.
 *
 * So the platform stores the full postcode, because geocoding and distance need
 * it, and publishes only the outward code (BRD §8.4.1: displayed location is
 * coarse, never exact). `outwardCode` exists as a separate stored column rather
 * than a truncation applied at render time — a public query that selects a
 * column which never held the inward code cannot leak it by omission of a step.
 *
 * No Node imports, by design: this package is shared with the browser bundle.
 */

export class PostcodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostcodeError';
  }
}

/**
 * The government's published postcode pattern, applied to the space-stripped,
 * upper-cased form.
 *
 * Deliberately structural rather than a loose `[A-Z]{1,2}[0-9]...`: the letter
 * positions genuinely exclude certain characters — the second letter is never
 * I, J or Z, and the final two are never C, I, K, M, O or V — because those were
 * dropped to avoid misreading handwriting. A permissive pattern accepts typos
 * that then fail at the geocoder, where the error is someone else's and arrives
 * much later.
 *
 * `GIR0AA` is a genuine special case (the former Girobank in Bootle) that fits
 * no part of the general pattern, which is why it is an alternation rather than
 * an oversight.
 */
const POSTCODE = /^(GIR0AA|[A-Z][A-HJ-Y]?[0-9][0-9A-Z]?[0-9][ABD-HJLNP-UW-Z]{2})$/;

/** Everything except the final three characters — the inward code is fixed-length. */
const INWARD_LENGTH = 3;

function strip(raw: string): string {
  // Unicode whitespace, not just ASCII: a value pasted from a web page or a PDF
  // frequently carries a non-breaking space, and rejecting that as "not a
  // postcode" is a confusing thing to tell someone who typed it correctly.
  return raw.replace(/\s+/gu, '').toUpperCase();
}

/**
 * Validate and normalise to the canonical `OUTWARD INWARD` form.
 *
 * Accepts any spacing and any case — `bs78aa`, `BS7 8AA` and `Bs7  8aA` are the
 * same postcode — and always returns `BS7 8AA`. Normalising on the way in means
 * uniqueness, comparison and geocoder lookups all see one representation, rather
 * than each having to remember to fold the input first.
 */
export function parse(raw: string): string {
  const stripped = strip(raw);

  if (stripped === '') {
    throw new PostcodeError('Postcode is required');
  }

  if (!POSTCODE.test(stripped)) {
    throw new PostcodeError(`Not a valid UK postcode: ${raw}`);
  }

  return `${stripped.slice(0, -INWARD_LENGTH)} ${stripped.slice(-INWARD_LENGTH)}`;
}

/** True when `raw` is a valid UK postcode in any spacing or case. */
export function isValid(raw: string): boolean {
  return POSTCODE.test(strip(raw));
}

/**
 * The publishable half — postal district only.
 *
 * Validates first rather than splitting on whitespace, so a malformed value
 * cannot yield a plausible-looking outward code that then gets published. A
 * caller holding an unvalidated string is exactly the caller most likely to be
 * about to show it to the public.
 */
export function outwardCode(raw: string): string {
  const [outward] = parse(raw).split(' ');

  // `parse` guarantees the space, so this is unreachable — but it is the
  // difference between a type error and a `string | undefined` leaking outward.
  if (outward === undefined) {
    throw new PostcodeError(`Not a valid UK postcode: ${raw}`);
  }

  return outward;
}
