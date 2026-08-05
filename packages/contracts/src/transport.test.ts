import { describe, expect, it } from 'vitest';
import { ContractViolationError } from './parse.js';
import {
  MAX_TRANSPORT_SUGGESTION_KG,
  TRANSPORT_REQUIREMENTS,
  TRANSPORT_REQUIREMENT_HINTS,
  TRANSPORT_REQUIREMENT_LABELS,
  WEIGHT_ATTRIBUTE_KEY,
  offersTransportRequirement,
  suggestTransportRequirement,
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

describe('suggesting a requirement from the weight', () => {
  /**
   * §8.3: *"Item weight, where captured as an attribute, should drive a
   * suggested default for this field rather than being asked twice."*
   *
   * The launch category's real bands, so a change that makes the real form
   * suggest something silly breaks a test rather than a listing.
   */
  const OPTIONS = [
    { requirement: 'hand_carryable' as const, suggestedUpToKg: 8 },
    { requirement: 'car_boot' as const, suggestedUpToKg: 25 },
    { requirement: 'estate_or_hatchback' as const, suggestedUpToKg: 60 },
    { requirement: 'van_required' as const, suggestedUpToKg: 150 },
  ];

  /** 12.5 kg at one decimal place is 125 — ADR 0027's scaled integer. */
  const kg = (value: number, decimalPlaces = 1) => ({
    scaled: value,
    decimalPlaces,
  });

  it('suggests the lightest band that covers the weight', () => {
    expect(suggestTransportRequirement(OPTIONS, kg(125))).toBe('car_boot');
  });

  it('treats a threshold as inclusive', () => {
    // Exactly 25.0 kg is "up to 25 kg". An exclusive boundary would push every
    // round number into the next band up, which is where owners' numbers cluster.
    expect(suggestTransportRequirement(OPTIONS, kg(250))).toBe('car_boot');
  });

  it('moves up a band one tenth of a kilogram later', () => {
    // The boundary is exact because both sides are integers. A float comparison
    // is where 25.1 would quietly become 25.099999999999998.
    expect(suggestTransportRequirement(OPTIONS, kg(251))).toBe('estate_or_hatchback');
  });

  it('suggests the lightest option for a very light item', () => {
    expect(suggestTransportRequirement(OPTIONS, kg(5))).toBe('hand_carryable');
  });

  it('suggests the most demanding option offered when nothing covers the weight', () => {
    // 300 kg against a top band of 150. It still has to go in something, and the
    // heaviest thing this category offers is the honest answer.
    expect(suggestTransportRequirement(OPTIONS, kg(3000))).toBe('van_required');
  });

  it('compares against the category’s own scale, not against kilograms', () => {
    // The same physical weight at a different configured precision. 12 kg at
    // zero decimal places is `12`, not `120`, and reading it as 1.2 kg would
    // suggest hand-carrying a mower.
    expect(suggestTransportRequirement(OPTIONS, kg(12, 0))).toBe('car_boot');
    expect(suggestTransportRequirement(OPTIONS, kg(1250, 2))).toBe('car_boot');
  });

  it('suggests nothing when there is no weight yet', () => {
    // An untouched form, a half-typed number, or a category with no weight
    // attribute. All the same answer: not yet.
    expect(suggestTransportRequirement(OPTIONS, null)).toBeNull();
  });

  it('suggests nothing when the category configured no thresholds', () => {
    // Opting out, and it must stay opted out — including for an item heavier
    // than anything, where the fallback would otherwise invent a suggestion.
    const noBands = [
      { requirement: 'car_boot' as const },
      { requirement: 'van_required' as const },
    ];

    expect(suggestTransportRequirement(noBands, kg(125))).toBeNull();
    expect(suggestTransportRequirement(noBands, kg(99_999))).toBeNull();
  });

  it('suggests nothing when the category offers no options at all', () => {
    expect(suggestTransportRequirement([], kg(125))).toBeNull();
  });

  it('skips an option with no threshold rather than stopping at it', () => {
    // A gap in the middle: estate is offered but never suggested by weight, and
    // a 40 kg item belongs in the van band rather than nowhere.
    const gapped = [
      { requirement: 'car_boot' as const, suggestedUpToKg: 25 },
      { requirement: 'estate_or_hatchback' as const },
      { requirement: 'van_required' as const, suggestedUpToKg: 150 },
    ];

    expect(suggestTransportRequirement(gapped, kg(400))).toBe('van_required');
  });

  it('can suggest an option with no threshold as the heaviest offered', () => {
    // Over every band, and the most demanding thing on offer happens to have no
    // threshold of its own. It is still the right answer.
    const gapped = [
      { requirement: 'car_boot' as const, suggestedUpToKg: 25 },
      { requirement: 'trailer_required' as const },
    ];

    expect(suggestTransportRequirement(gapped, kg(4000))).toBe('trailer_required');
  });
});
