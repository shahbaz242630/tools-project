/**
 * Money primitive.
 *
 * BRD §6.1: monetary amounts are integers in the minor unit (pence) with an
 * ISO 4217 currency code on the same value. Floating point is never used to
 * represent money — only as a transient factor inside `multiply` and
 * `allocate`, both of which round back to integers before returning.
 */

/** ISO 4217 codes the platform supports. UK-only at launch (BRD §2.4). */
export const SUPPORTED_CURRENCIES = ['GBP'] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/** Minor units per major unit, by currency. Not every currency is 100. */
const MINOR_UNITS_PER_MAJOR: Record<CurrencyCode, number> = {
  GBP: 100,
};

export interface Money {
  /** Integer count of minor units. May be negative (refunds, reversals). */
  readonly amount: number;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Rounding applied when a calculation produces a fractional minor unit. */
export type RoundingMode = 'half-up' | 'floor' | 'ceil';

function applyRounding(value: number, mode: RoundingMode): number {
  switch (mode) {
    case 'half-up':
      // Half away from zero. Math.round alone rounds -0.5 towards +Infinity,
      // which would make refunds behave differently from charges.
      return Math.sign(value) * Math.round(Math.abs(value));
    case 'floor':
      return Math.floor(value);
    case 'ceil':
      return Math.ceil(value);
  }
}

// --- Construction ------------------------------------------------------------

export function money(amount: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(amount)) {
    throw new MoneyError(
      `Money must be an integer number of minor units, received ${amount}. ` +
        `Use fromMajor() to build from a decimal string.`,
    );
  }
  if (!Number.isSafeInteger(amount)) {
    throw new MoneyError(`Money amount ${amount} exceeds safe integer range`);
  }
  return { amount, currency };
}

export function zero(currency: CurrencyCode): Money {
  return { amount: 0, currency };
}

/**
 * Build from a decimal string such as "12.34". Strings only — passing a JS
 * number would already have lost precision before we saw it.
 */
export function fromMajor(value: string, currency: CurrencyCode): Money {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new MoneyError(`Cannot parse "${value}" as a decimal amount`);
  }
  const [, sign, whole, fraction = ''] = match;
  const scale = MINOR_UNITS_PER_MAJOR[currency];
  const decimals = String(scale).length - 1;

  if (fraction.length > decimals) {
    throw new MoneyError(
      `"${value}" has more than ${decimals} decimal places for ${currency}`,
    );
  }

  const padded = fraction.padEnd(decimals, '0');
  const minor = Number(whole) * scale + Number(padded || '0');
  return money(sign === '-' ? -minor : minor, currency);
}

// --- Guards ------------------------------------------------------------------

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `Currency mismatch: cannot combine ${a.currency} with ${b.currency}`,
    );
  }
}

// --- Arithmetic --------------------------------------------------------------

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function sum(values: readonly Money[], currency: CurrencyCode): Money {
  return values.reduce<Money>((acc, v) => add(acc, v), zero(currency));
}

export function negate(m: Money): Money {
  return money(-m.amount, m.currency);
}

export function absolute(m: Money): Money {
  return money(Math.abs(m.amount), m.currency);
}

/**
 * Multiply by a scalar — a quantity, a rate, or a fee percentage expressed as
 * a fraction. Rounds to a whole minor unit.
 */
export function multiply(
  m: Money,
  factor: number,
  mode: RoundingMode = 'half-up',
): Money {
  if (!Number.isFinite(factor)) {
    throw new MoneyError(`Multiplier must be finite, received ${factor}`);
  }
  return money(applyRounding(m.amount * factor, mode), m.currency);
}

/** Percentage of an amount. `percent` is 15 for 15%, not 0.15. */
export function percentageOf(
  m: Money,
  percent: number,
  mode: RoundingMode = 'half-up',
): Money {
  return multiply(m, percent / 100, mode);
}

/**
 * Split an amount across weighted shares without losing or inventing minor
 * units. The returned shares always sum exactly to the input.
 *
 * This is why fee splitting must not be done with `multiply`: 15% of £10.01
 * plus 85% of £10.01 rounds to £10.02 independently, creating a penny from
 * nowhere and breaking the ledger (BRD §8.7).
 */
export function allocate(m: Money, ratios: readonly number[]): Money[] {
  if (ratios.length === 0) {
    throw new MoneyError('allocate() requires at least one ratio');
  }
  if (ratios.some((r) => r < 0 || !Number.isFinite(r))) {
    throw new MoneyError('allocate() ratios must be finite and non-negative');
  }

  const total = ratios.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    throw new MoneyError('allocate() ratios must sum to more than zero');
  }

  const shares: number[] = [];
  let remainder = m.amount;

  for (const ratio of ratios) {
    // Truncate towards zero so the remainder carries the same sign as the
    // total, which keeps negative allocations (refunds) symmetrical.
    const share = Math.trunc((m.amount * ratio) / total);
    shares.push(share);
    remainder -= share;
  }

  // Distribute the leftover a single minor unit at a time, largest-ratio
  // first, so the biggest share absorbs rounding rather than the smallest.
  const order = ratios
    .map((ratio, index) => ({ ratio, index }))
    .sort((a, b) => b.ratio - a.ratio);

  const step = Math.sign(remainder);
  for (let i = 0; i < Math.abs(remainder); i += 1) {
    const target = order[i % order.length];
    /* c8 ignore next */
    if (!target) continue;
    shares[target.index] = (shares[target.index] ?? 0) + step;
  }

  return shares.map((s) => money(s, m.currency));
}

// --- Comparison --------------------------------------------------------------

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount === b.amount;
}

export function greaterThan(a: Money, b: Money): boolean {
  return compare(a, b) === 1;
}

export function lessThan(a: Money, b: Money): boolean {
  return compare(a, b) === -1;
}

export function isZero(m: Money): boolean {
  return m.amount === 0;
}

export function isNegative(m: Money): boolean {
  return m.amount < 0;
}

export function isPositive(m: Money): boolean {
  return m.amount > 0;
}

export function maxOf(a: Money, b: Money): Money {
  return greaterThan(a, b) ? a : b;
}

export function minOf(a: Money, b: Money): Money {
  return lessThan(a, b) ? a : b;
}

// --- Presentation ------------------------------------------------------------

/** Decimal string without a currency symbol, e.g. "12.34" or "-5.00". */
export function toMajorString(m: Money): string {
  const scale = MINOR_UNITS_PER_MAJOR[m.currency];
  const decimals = String(scale).length - 1;
  const sign = m.amount < 0 ? '-' : '';
  const abs = Math.abs(m.amount);
  const whole = Math.trunc(abs / scale);
  const fraction = String(abs % scale).padStart(decimals, '0');
  return `${sign}${whole}.${fraction}`;
}

/** Localised display string, e.g. "£12.34". Presentation only — never parsed. */
export function format(m: Money, locale = 'en-GB'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
  }).format(m.amount / MINOR_UNITS_PER_MAJOR[m.currency]);
}
