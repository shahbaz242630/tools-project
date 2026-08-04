/**
 * The one rule about what characters a person may store in free text.
 *
 * U+202E reverses the rendering of everything after it, which is how a title is
 * made to read as something it is not; a newline breaks every list a single-line
 * value appears in. Both live in the Unicode `Cc` (control) and `Cf` (format)
 * categories, so one test covers them.
 *
 * **Its own module because there are now three callers**, and the third is where
 * a rule stops being a coincidence and starts being something that can drift —
 * a listing title, a listing description and, from slice 2.4b, every `text`
 * attribute value an owner types into a form built from configuration.
 */

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/**
 * Whether a value carries characters no stored text should.
 *
 * `allowLineBreaks` is for paragraph fields, which legitimately contain `\r`,
 * `\n` and `\t` — those are stripped before the test rather than excluded inside
 * the character class, because expressing the exception in the class needs the
 * `v` flag's set difference, which reads like a puzzle and depends on the
 * compilation target.
 */
export function hasUnsafeCharacters(
  value: string,
  { allowLineBreaks = false }: { readonly allowLineBreaks?: boolean } = {},
): boolean {
  return CONTROL_OR_FORMAT.test(
    allowLineBreaks ? value.replace(/[\r\n\t]/g, '') : value,
  );
}

/** What every such rejection says, so three fields cannot word it three ways. */
export const UNSAFE_CHARACTERS_MESSAGE =
  'must not contain control or direction-changing characters';
