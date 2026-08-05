import { describe, expect, it } from 'vitest';
import { ContractViolationError } from './parse.js';
import {
  MAX_TRANSPORT_SUGGESTION_KG,
  TRANSPORT_REQUIREMENTS,
  TRANSPORT_REQUIREMENT_HINTS,
  TRANSPORT_REQUIREMENT_LABELS,
  WEIGHT_ATTRIBUTE_KEY,
  offersTransportRequirement,
  parseCategoryTransportOptions,
} from './transport.js';

describe('the transport vocabulary', () => {
  it('is the five values ADR 0031 fixed, in display order', () => {
    // Pinned deliberately. Adding a value is a deploy and a decision, and this
    // is the test that makes somebody read the ADR before making it — the search
    // filter in Phase 3 and the handover checklist in Phase 7 both switch on
    // these, and a sixth value is a case they would not handle.
    expect(TRANSPORT_REQUIREMENTS).toEqual([
      'hand_carryable',
      'car_boot',
      'estate_or_hatchback',
      'van_required',
      'trailer_required',
    ]);
  });

  it('has a label and a hint for every value', () => {
    // A missing entry is a blank option in a form: the control renders, it is
    // selectable, and it says nothing. Cheaper to catch here than to notice.
    for (const requirement of TRANSPORT_REQUIREMENTS) {
      expect(TRANSPORT_REQUIREMENT_LABELS[requirement]).not.toBe('');
      expect(TRANSPORT_REQUIREMENT_HINTS[requirement]).not.toBe('');
    }
  });

  it('recognises weight under the key ADR 0027 named', () => {
    // The launch category's `weight_kg` attribute exists to drive this. The key
    // is the contract — never the unit string — so a rename of the constant and
    // a rename of the attribute have to happen together.
    expect(WEIGHT_ATTRIBUTE_KEY).toBe('weight_kg');
  });
});

describe('a category’s transport options', () => {
  it('accepts a selection with thresholds', () => {
    const options = parseCategoryTransportOptions([
      { requirement: 'car_boot', suggestedUpToKg: 25 },
      { requirement: 'van_required', suggestedUpToKg: 150 },
    ]);

    expect(options).toEqual([
      { requirement: 'car_boot', suggestedUpToKg: 25 },
      { requirement: 'van_required', suggestedUpToKg: 150 },
    ]);
  });

  it('accepts an option with no threshold', () => {
    // A category that configures no thresholds suggests nothing, which is the
    // intended way for this to degrade — a no-op rather than a wrong nudge.
    expect(
      parseCategoryTransportOptions([{ requirement: 'trailer_required' }]),
    ).toEqual([{ requirement: 'trailer_required' }]);
  });

  it('accepts an empty selection', () => {
    expect(parseCategoryTransportOptions([])).toEqual([]);
  });

  it('sorts a selection into display order on the way in', () => {
    // Canonical on the way in, not on the way out. Two administrators ticking
    // the same boxes in a different order must produce the same stored value,
    // or the audit digest reports a change that nobody made (ADR 0017).
    const options = parseCategoryTransportOptions([
      { requirement: 'van_required' },
      { requirement: 'hand_carryable' },
      { requirement: 'estate_or_hatchback' },
    ]);

    expect(options.map((option) => option.requirement)).toEqual([
      'hand_carryable',
      'estate_or_hatchback',
      'van_required',
    ]);
  });

  it('refuses a requirement it does not know', () => {
    // `roof_rack` is the one somebody will reach for first — a ladder is long
    // and light, which ADR 0031 records as a third axis rather than a sixth
    // value. Refusing it here is what sends them to the ADR.
    expect(() => parseCategoryTransportOptions([{ requirement: 'roof_rack' }])).toThrow(
      ContractViolationError,
    );
  });

  it('refuses the same requirement offered twice', () => {
    // Two entries for one requirement means a listing choosing it could not say
    // which was meant, including which threshold applied.
    expect(() =>
      parseCategoryTransportOptions([
        { requirement: 'car_boot', suggestedUpToKg: 20 },
        { requirement: 'car_boot', suggestedUpToKg: 30 },
      ]),
    ).toThrow(ContractViolationError);
  });

  it('names the duplicate the way the administrator saw it', () => {
    try {
      parseCategoryTransportOptions([
        { requirement: 'van_required' },
        { requirement: 'van_required' },
      ]);
      expect.unreachable('a duplicate should not parse');
    } catch (error) {
      // The label, not the stored value: `van_required` appears nowhere on the
      // form, which is the mistake 2.4b made with `weight_kg` and fixed.
      expect(String(error)).toContain('Van or large vehicle');
    }
  });

  it('reads as a sentence, with no array index in front of it', () => {
    // Found by using the page. The refusal read *"3.suggestedUpToKg: "Van or
    // large vehicle" suggests up to 20 kg…"* — `parseWith` prefixing the
    // message with its path, which reads well for `slug:` because that is a
    // field somebody typed into, and badly here because `3` is an index into
    // the posted array and is not even the row number on screen. The message
    // already names both options. 2.4b's lesson, second time.
    try {
      parseCategoryTransportOptions([
        { requirement: 'car_boot', suggestedUpToKg: 50 },
        { requirement: 'van_required', suggestedUpToKg: 20 },
      ]);
      expect.unreachable('a decreasing threshold should not parse');
    } catch (error) {
      const issue = (error as ContractViolationError).issues[0] ?? '';
      expect(issue).toMatch(/^"Van or large vehicle"/);
    }
  });

  it('refuses thresholds that do not increase down the display order', () => {
    // Van covering less than the car boot makes one of the two unreachable by
    // any weight — a mistake somebody made rather than a policy, and invisible
    // once saved.
    expect(() =>
      parseCategoryTransportOptions([
        { requirement: 'car_boot', suggestedUpToKg: 50 },
        { requirement: 'van_required', suggestedUpToKg: 20 },
      ]),
    ).toThrow(ContractViolationError);
  });

  it('refuses two options suggested up to the same weight', () => {
    // Equal is not increasing: the first in display order would win every time
    // and the second could never be suggested.
    expect(() =>
      parseCategoryTransportOptions([
        { requirement: 'car_boot', suggestedUpToKg: 25 },
        { requirement: 'estate_or_hatchback', suggestedUpToKg: 25 },
      ]),
    ).toThrow(ContractViolationError);
  });

  it('checks the order they are stored in, not the order they were sent', () => {
    // Sent van-first, which is fine — but van at 20 kg still sits below car boot
    // at 50 kg once ordered, and that is what makes it wrong.
    expect(() =>
      parseCategoryTransportOptions([
        { requirement: 'van_required', suggestedUpToKg: 20 },
        { requirement: 'car_boot', suggestedUpToKg: 50 },
      ]),
    ).toThrow(ContractViolationError);
  });

  it('lets an option without a threshold sit between two that have one', () => {
    // An unset threshold does not constrain its neighbours: the category simply
    // never suggests that option by weight.
    const options = parseCategoryTransportOptions([
      { requirement: 'car_boot', suggestedUpToKg: 25 },
      { requirement: 'estate_or_hatchback' },
      { requirement: 'van_required', suggestedUpToKg: 150 },
    ]);

    expect(options).toHaveLength(3);
  });

  it('refuses a fractional threshold', () => {
    // A band boundary, not a measurement — 15.5 kg implies a precision the
    // suggestion does not have.
    expect(() =>
      parseCategoryTransportOptions([
        { requirement: 'car_boot', suggestedUpToKg: 15.5 },
      ]),
    ).toThrow(ContractViolationError);
  });

  it('refuses a threshold of zero', () => {
    // What an emptied number input posts if the editor lets NaN through. It
    // must fail with something that points at the field rather than at a type.
    expect(() =>
      parseCategoryTransportOptions([{ requirement: 'car_boot', suggestedUpToKg: 0 }]),
    ).toThrow(ContractViolationError);
  });

  it('refuses a threshold above the sanity bound', () => {
    expect(() =>
      parseCategoryTransportOptions([
        {
          requirement: 'trailer_required',
          suggestedUpToKg: MAX_TRANSPORT_SUGGESTION_KG + 1,
        },
      ]),
    ).toThrow(ContractViolationError);
  });

  it('refuses a null threshold rather than reading it as unset', () => {
    // One representation of "not configured", which is absence. Accepting null
    // as well would be two spellings of the same thing, and later code would
    // eventually handle only one of them.
    expect(() =>
      parseCategoryTransportOptions([
        { requirement: 'car_boot', suggestedUpToKg: null },
      ]),
    ).toThrow(ContractViolationError);
  });

  it('refuses more options than there are requirements', () => {
    expect(() =>
      parseCategoryTransportOptions([
        ...TRANSPORT_REQUIREMENTS.map((requirement) => ({ requirement })),
        { requirement: 'car_boot' },
      ]),
    ).toThrow(ContractViolationError);
  });

  it('refuses a value that is not a list at all', () => {
    expect(() => parseCategoryTransportOptions({ requirement: 'car_boot' })).toThrow(
      ContractViolationError,
    );
  });
});

describe('offersTransportRequirement', () => {
  const options = [
    { requirement: 'car_boot' as const, suggestedUpToKg: 25 },
    { requirement: 'van_required' as const },
  ];

  it('is true for an option the category offers', () => {
    expect(offersTransportRequirement(options, 'van_required')).toBe(true);
  });

  it('is false for one it does not', () => {
    expect(offersTransportRequirement(options, 'trailer_required')).toBe(false);
  });

  it('is false for a value outside the vocabulary', () => {
    // Takes a string rather than a `TransportRequirement`, because the caller
    // that most needs it is checking something that arrived over the wire.
    expect(offersTransportRequirement(options, 'roof_rack')).toBe(false);
  });
});
