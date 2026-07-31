/**
 * UK telephone number primitive.
 *
 * **Deliberately GB-only.** The launch market is the UK (BRD §1), and a narrow
 * parser whose limits are written down beats a permissive one that appears to
 * handle everything: `+1 555 0100` silently stored as a British number is worse
 * than a rejection someone can act on.
 *
 * When the platform takes numbers outside the UK, this is the moment to adopt
 * `libphonenumber-js` rather than to widen the rules below one country at a
 * time. It is not here already because a 145 kB metadata dependency to validate
 * one country's numbers is a poor trade, and stating the boundary is what makes
 * that reversible.
 *
 * Normalising to E.164 on the way in is what makes two records comparable —
 * `07700 900123`, `+44 7700 900123` and `(07700) 900-123` are one number, and a
 * duplicate-number check for multi-account fraud is worthless if they are
 * stored as three.
 *
 * No Node imports, by design: this package is shared with the browser bundle.
 */

export class PhoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhoneError';
  }
}

const UK_COUNTRY_CODE = '44';

/**
 * The national significant number — what follows the trunk `0` or the `+44`.
 *
 * Nine or ten digits: almost every UK number is ten, but a handful of areas
 * (Brampton's 016977 range among them) are nine, and rejecting those means
 * rejecting real customers in Cumbria.
 *
 * The leading digit excludes 0 (never valid after the trunk code), 4 (reserved)
 * and 6 (unallocated). That is enough structure to catch a mistyped or
 * half-pasted number without encoding the whole numbering plan, which changes
 * and would then be wrong in a file nobody thinks to update.
 */
const NATIONAL_NUMBER = /^[1235789][0-9]{8,9}$/;

/**
 * Strip everything a person might reasonably type as decoration.
 *
 * Spaces, hyphens, dots, brackets and the `+`, which is re-added on the way out.
 * `\s` under the `u` flag already covers the non-breaking space that arrives with
 * anything pasted from a web page, so it needs no separate mention in the class.
 */
function digitsOnly(raw: string): string {
  return raw.replace(/[\s\-.()+]/gu, '');
}

/**
 * Reduce any accepted UK spelling to the national significant number.
 *
 * Returns null rather than throwing, so `isValid` and `parse` share one set of
 * rules and cannot disagree about what is acceptable.
 */
function toNationalNumber(raw: string): string | null {
  const digits = digitsOnly(raw);

  if (!/^[0-9]+$/.test(digits) || digits === '') return null;

  // 00 44 …  — the international access code, as dialled from a UK landline.
  if (digits.startsWith(`00${UK_COUNTRY_CODE}`)) {
    return digits.slice(4);
  }

  // 0 …  — trunk form, how a number is written on nearly every UK website.
  if (digits.startsWith('0')) {
    return digits.slice(1);
  }

  // 44 …  — what `+44 …` becomes once the plus is stripped.
  //
  // Length-checked rather than accepted on the prefix alone: a valid national
  // number may itself begin `44` (the 0044x area codes around Grantham), and
  // treating those as country-coded would silently truncate them. A real
  // country-coded number is 11 or 12 digits; a national one is 9 or 10.
  if (digits.startsWith(UK_COUNTRY_CODE) && digits.length >= 11) {
    return digits.slice(2);
  }

  return digits;
}

/**
 * Validate and normalise to E.164 — `+447700900123`.
 *
 * One stored representation, whatever was typed.
 */
export function parse(raw: string): string {
  if (raw.trim() === '') {
    throw new PhoneError('Phone number is required');
  }

  const national = toNationalNumber(raw);

  if (national === null || !NATIONAL_NUMBER.test(national)) {
    throw new PhoneError(`Not a valid UK phone number: ${raw}`);
  }

  return `+${UK_COUNTRY_CODE}${national}`;
}

/** True when `raw` is a UK number in any of the accepted spellings. */
export function isValid(raw: string): boolean {
  const national = toNationalNumber(raw);
  return national !== null && NATIONAL_NUMBER.test(national);
}

/**
 * Render an E.164 number back into the form a British reader expects.
 *
 * Presentation only — never store the result. Mobile numbers group as
 * `07700 900123`, landlines are left as a single national block because the
 * grouping depends on the area code's length and guessing it wrong looks worse
 * than not grouping at all.
 */
export function format(e164: string): string {
  const national = toNationalNumber(e164);

  if (national === null || !NATIONAL_NUMBER.test(national)) {
    // Unparseable input is returned untouched rather than throwing: this is a
    // display helper, and a profile page that crashes over a badly stored
    // legacy value is a worse outcome than one showing it verbatim.
    return e164;
  }

  const trunk = `0${national}`;

  return trunk.startsWith('07') && trunk.length === 11
    ? `${trunk.slice(0, 5)} ${trunk.slice(5)}`
    : trunk;
}
