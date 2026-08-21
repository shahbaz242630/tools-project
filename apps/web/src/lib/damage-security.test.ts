import { describe, expect, it } from 'vitest';
import { parseDamageSecurityPolicy } from '@platform/contracts';
import {
  DAMAGE_SECURITY_NONE,
  DAMAGE_SECURITY_REQUIRED,
  readDamageSecurity,
  securitySummary,
} from './damage-security';

const typed = {
  choice: DAMAGE_SECURITY_REQUIRED,
  excessFloor: '75.00',
  excessPercentage: '15',
  recoveryCeiling: '500.00',
};

describe('readDamageSecurity', () => {
  it('reads a configured band', () => {
    expect(readDamageSecurity(typed)).toEqual({
      ok: true,
      value: {
        excessFloor: { amount: 7_500, currency: 'GBP' },
        excessPercentageBasisPoints: 1_500,
        recoveryCeiling: { amount: 50_000, currency: 'GBP' },
      },
    });
  });

  it('produces something the contract accepts', () => {
    const result = readDamageSecurity(typed);
    if (!result.ok) throw new Error(result.message);

    expect(() => parseDamageSecurityPolicy(result.value)).not.toThrow();
  });

  /**
   * BRD §8.7.2's "configured to require no security". The three value fields are
   * unmounted in that branch of the form, so they arrive blank — and must not
   * turn the answer into an error about a missing ceiling.
   */
  it('returns null when the category requires no security', () => {
    expect(
      readDamageSecurity({
        choice: DAMAGE_SECURITY_NONE,
        excessFloor: '',
        excessPercentage: '',
        recoveryCeiling: '',
      }),
    ).toEqual({ ok: true, value: null });
  });

  it('produces something the contract accepts for no security too', () => {
    expect(() => parseDamageSecurityPolicy(null)).not.toThrow();
  });

  /**
   * The decision ADR 0052 turns on. Silence is not consent to an unsecured
   * handover, so it is refused rather than read as `null` — which is why the
   * form ships both radios unchecked and why this reader takes `string |
   * undefined` rather than a coerced `''`.
   */
  it('refuses an unanswered choice rather than defaulting to no security', () => {
    const result = readDamageSecurity({ ...typed, choice: undefined });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining(
        'Say whether this category requires damage security',
      ),
    });
  });

  it('refuses a choice it does not recognise', () => {
    /*
     * A posted value that is neither option is a tampered or stale form, and it
     * takes the same branch as silence: the caller has not said "no security",
     * so nothing may infer it.
     */
    const result = readDamageSecurity({ ...typed, choice: 'maybe' });

    expect(result.ok).toBe(false);
  });

  it('treats a blank excess floor as no fixed minimum', () => {
    const result = readDamageSecurity({ ...typed, excessFloor: '' });

    expect(result).toEqual({
      ok: true,
      value: {
        excessFloor: { amount: 0, currency: 'GBP' },
        excessPercentageBasisPoints: 1_500,
        recoveryCeiling: { amount: 50_000, currency: 'GBP' },
      },
    });
  });

  /**
   * The asymmetry with the floor above, and the reason `readAmount` takes a
   * `whenBlank` rather than defaulting to zero: a zero ceiling is a band nothing
   * is recoverable through, which contradicts the answer already given.
   */
  it('refuses a blank recovery ceiling rather than reading it as zero', () => {
    const result = readDamageSecurity({ ...typed, recoveryCeiling: '' });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('Give a recovery ceiling'),
    });
  });

  it('refuses a blank excess percentage — somebody has to decide it', () => {
    const result = readDamageSecurity({ ...typed, excessPercentage: '' });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('Give the Excess percentage as a percentage'),
    });
  });

  it('keeps sub-percent granularity without constructing a float', () => {
    const result = readDamageSecurity({ ...typed, excessPercentage: '12.5' });
    if (!result.ok) throw new Error(result.message);

    expect(result.value?.excessPercentageBasisPoints).toBe(1_250);
  });

  it('accepts 100%, which the fee fields would refuse', () => {
    /*
     * The bound is a parameter rather than a constant for exactly this: a fee is
     * capped at 50% and an excess percentage at 100%, and a shared limit would
     * make one of the two silently wrong.
     */
    const result = readDamageSecurity({ ...typed, excessPercentage: '100' });
    if (!result.ok) throw new Error(result.message);

    expect(result.value?.excessPercentageBasisPoints).toBe(10_000);
  });

  it('refuses a percentage above 100%', () => {
    const result = readDamageSecurity({ ...typed, excessPercentage: '101' });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('cannot exceed 100%'),
    });
  });

  it('names the % sign rather than reporting a bound that was not breached', () => {
    const result = readDamageSecurity({ ...typed, excessPercentage: '15%' });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('without the % sign'),
    });
  });

  it('refuses a currency symbol in an amount', () => {
    const result = readDamageSecurity({ ...typed, excessFloor: '£75' });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('no currency symbol'),
    });
  });

  it('refuses an amount above the platform-wide bound', () => {
    const result = readDamageSecurity({ ...typed, recoveryCeiling: '10001' });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('cannot exceed £10000'),
    });
  });

  /**
   * The cross-field rule is deliberately **not** re-implemented in the browser —
   * the contract, the API and a database CHECK each hold it. This pins that the
   * reader lets the pair through so the refusal comes from a layer that cannot
   * drift out of step with the other two.
   */
  it('leaves the floor-above-ceiling rule to the contract', () => {
    const result = readDamageSecurity({
      ...typed,
      excessFloor: '600.00',
      recoveryCeiling: '500.00',
    });

    expect(result.ok).toBe(true);
    expect(() => parseDamageSecurityPolicy(result.ok ? result.value : null)).toThrow(
      /always bear more than could ever be recovered/,
    );
  });
});

describe('securitySummary', () => {
  /**
   * The line the admin list shows, and the state it exists to make visible: a
   * category with no band hands every item over with nothing held.
   */
  it('says so plainly when a category requires no damage security', () => {
    expect(securitySummary(null)).toBe('no damage security');
  });

  it('shows the floor, the percentage and the ceiling when one is set', () => {
    expect(
      securitySummary({
        excessFloor: { amount: 7_500, currency: 'GBP' },
        excessPercentageBasisPoints: 1_500,
        recoveryCeiling: { amount: 50_000, currency: 'GBP' },
      }),
    ).toBe('excess £75.00 or 15%, up to £500.00');
  });

  it('shows a zero floor rather than hiding it', () => {
    // A band sized entirely from the percentage is a real configuration, and an
    // administrator scanning the list needs to see that the floor is nil rather
    // than absent.
    expect(
      securitySummary({
        excessFloor: { amount: 0, currency: 'GBP' },
        excessPercentageBasisPoints: 2_000,
        recoveryCeiling: { amount: 100_000, currency: 'GBP' },
      }),
    ).toBe('excess £0.00 or 20%, up to £1000.00');
  });
});

describe('an amount too large for Money to hold', () => {
  /**
   * The one branch of `readAmount` the format check does not already guarantee.
   * `^\d+(\.\d{1,2})?$` admits any number of digits, and `Money.money` refuses
   * anything past the safe integer range — so a pasted number lands in the catch
   * rather than in a band. **A sentence, not a 500**, which is the whole reason
   * that `try` is there and why it is worth one test rather than a `c8 ignore`.
   */
  it('reports it as an amount problem rather than throwing', () => {
    const result = readDamageSecurity({
      choice: DAMAGE_SECURITY_REQUIRED,
      excessFloor: '999999999999999999',
      excessPercentage: '15',
      recoveryCeiling: '500.00',
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('Excess floor');
  });
});
