/**
 * Fixed-scale decimals held as integers.
 *
 * ADR 0027: a `number` attribute declares `decimalPlaces`, and the value it
 * carries is an integer in the smallest unit that implies — 2.5 kg is `25` at
 * one decimal place, 18 mm is `18` at zero. The scale is fixed on the *category
 * version* before any value exists, so two listings in one category can never
 * mean different things by the same integer.
 *
 * **This is not money, and it must never be used for money.** `Money` is
 * currency-aware, and a currency code travelling beside the amount is the whole
 * point of ADR 0002 — an amount scaled by this module has no currency, so a
 * price built here would be a number nobody can bank. The two are deliberately
 * separate namespaces so that a call site reads as one or the other.
 *
 * What they share is the reason for existing: **the value is a string from the
 * browser to here and no further**. `parseFloat` is banned project-wide, `2.5`
 * has no exact binary representation, and a float that is harmless in a form
 * field is not harmless once Phase 3 buckets it into a search facet.
 */

export class ScaledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScaledError';
  }
}

/**
 * A ceiling on the scale, well above ADR 0027's cap of 3.
 *
 * The primitive is deliberately more permissive than the contract that uses it:
 * a bound belongs where the vocabulary is defined, and duplicating that number
 * here would make it two numbers that can disagree. This one exists only so an
 * absurd scale cannot produce an integer outside the safe range.
 */
const MAX_DECIMAL_PLACES = 9;

function assertScale(decimalPlaces: number): void {
  if (
    !Number.isInteger(decimalPlaces) ||
    decimalPlaces < 0 ||
    decimalPlaces > MAX_DECIMAL_PLACES
  ) {
    throw new ScaledError(
      `Decimal places must be a whole number between 0 and ${String(
        MAX_DECIMAL_PLACES,
      )}, received ${String(decimalPlaces)}`,
    );
  }
}

/**
 * Read a decimal string at a fixed scale.
 *
 * Strings only, for the reason above. A value with *fewer* decimal places than
 * the scale is padded — "2" at one place is `20` — because a listing that omits
 * the tenth of a kilogram means zero tenths, not an unknown quantity. A value
 * with *more* is refused rather than rounded: rounding somebody's number without
 * telling them is how a 2.55 kg item becomes a 2.5 kg one on a page they will
 * later be held to.
 *
 * Negative values are accepted. ADR 0027 deliberately shipped no minimum or
 * maximum, and inventing a non-negativity rule here would be exactly that
 * missing bound, hidden in a primitive where no administrator can see it.
 */
export function fromDecimalString(value: string, decimalPlaces: number): number {
  assertScale(decimalPlaces);

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new ScaledError(`Cannot read "${value}" as a number`);
  }

  const [, sign, whole, fraction = ''] = match;

  if (fraction.length > decimalPlaces) {
    throw new ScaledError(
      decimalPlaces === 0
        ? `"${value}" must be a whole number`
        : `"${value}" has more than ${String(decimalPlaces)} decimal place${
            decimalPlaces === 1 ? '' : 's'
          }`,
    );
  }

  // Built by string concatenation rather than arithmetic, so no intermediate
  // float exists even transiently: "2" + "5" is 25, where 2 * 10 + 5 would be
  // correct here and would not be at scales where the multiplier is not exact.
  const digits = `${whole}${fraction.padEnd(decimalPlaces, '0')}`;
  const scaled = Number(digits);

  if (!Number.isSafeInteger(scaled)) {
    throw new ScaledError(`"${value}" is too large to store at this scale`);
  }

  // `-0` is a real JavaScript value, it survives JSON, and it compares equal to
  // 0 while printing differently. Normalised so a stored value cannot be one.
  return sign === '-' && scaled !== 0 ? -scaled : scaled;
}

/**
 * The inverse: an integer back to the decimal string a person reads.
 *
 * `toFixed` is banned by the invariant checker and would be wrong here anyway —
 * it takes a float. This builds the string from the integer's own digits, so
 * what is displayed is exactly what is stored.
 */
export function toDecimalString(value: number, decimalPlaces: number): string {
  assertScale(decimalPlaces);

  if (!Number.isSafeInteger(value)) {
    throw new ScaledError(
      `A scaled value must be a whole number, received ${String(value)}`,
    );
  }

  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value)).padStart(decimalPlaces + 1, '0');
  if (decimalPlaces === 0) return `${sign}${digits}`;

  const whole = digits.slice(0, digits.length - decimalPlaces);
  const fraction = digits.slice(digits.length - decimalPlaces);
  return `${sign}${whole}.${fraction}`;
}

/**
 * What a person reads, with the unit after it.
 *
 * The unit is a display suffix and nothing else (ADR 0027) — anything that needs
 * to *know* an attribute is a weight keys off the attribute key instead.
 */
export function format(value: number, decimalPlaces: number, unit: string): string {
  return `${toDecimalString(value, decimalPlaces)} ${unit}`.trim();
}
