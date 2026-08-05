import { describe, expect, it } from 'vitest';
import type { CategoryAttribute } from './catalogue.js';
import { readItemWeight } from './item-weight.js';

/**
 * The launch category's real weight attribute, because the whole point of this
 * module is that it recognises that one and nothing else.
 */
const WEIGHT: CategoryAttribute = {
  key: 'weight_kg',
  label: 'Weight',
  required: true,
  type: 'number',
  unit: 'kg',
  decimalPlaces: 1,
};

const POWER: CategoryAttribute = {
  key: 'power_source',
  label: 'Power source',
  required: true,
  type: 'choice',
  options: [
    { value: 'petrol', label: 'Petrol' },
    { value: 'cordless', label: 'Cordless' },
  ],
};

describe('readItemWeight', () => {
  it('reads a typed decimal as a scaled integer', () => {
    // 12.5 kg is 125 at one decimal place (ADR 0027). No float exists at any
    // point on this path.
    expect(readItemWeight([POWER, WEIGHT], { weight_kg: '12.5' })).toEqual({
      scaled: 125,
      decimalPlaces: 1,
    });
  });

  it('reads a whole number', () => {
    expect(readItemWeight([WEIGHT], { weight_kg: '12' })).toEqual({
      scaled: 120,
      decimalPlaces: 1,
    });
  });

  it('carries the category’s own scale, not a fixed one', () => {
    const whole: CategoryAttribute = { ...WEIGHT, decimalPlaces: 0 };
    expect(readItemWeight([whole], { weight_kg: '12' })).toEqual({
      scaled: 12,
      decimalPlaces: 0,
    });
  });

  it('ignores surrounding whitespace', () => {
    expect(readItemWeight([WEIGHT], { weight_kg: '  12.5  ' })?.scaled).toBe(125);
  });

  it('finds nothing when the category has no weight attribute', () => {
    // §8.3's "where captured as an attribute". Nothing is wrong — the category
    // simply has no weight for anything to key off.
    expect(readItemWeight([POWER], { power_source: 'petrol' })).toBeNull();
  });

  it('finds nothing when weight_kg is configured as some other type', () => {
    // Somebody made it free text. There is no scale to read it against, so
    // there is nothing to compare — and guessing would be worse.
    const asText: CategoryAttribute = {
      key: 'weight_kg',
      label: 'Weight',
      required: false,
      type: 'text',
      maxLength: 20,
    };

    expect(readItemWeight([asText], { weight_kg: '12.5' })).toBeNull();
  });

  it('finds nothing on an untouched form', () => {
    expect(readItemWeight([WEIGHT], {})).toBeNull();
    expect(readItemWeight([WEIGHT], { weight_kg: '' })).toBeNull();
    expect(readItemWeight([WEIGHT], { weight_kg: '   ' })).toBeNull();
  });

  it('stays quiet on the half-typed states a live suggestion sees', () => {
    // The states a number passes through on the way to being one. A suggestion
    // that shouted at each keystroke would be worse than no suggestion.
    for (const typed of ['1', '12.', '-', '.', '.5']) {
      const read = readItemWeight([WEIGHT], { weight_kg: typed });
      if (typed === '1') expect(read?.scaled).toBe(10);
      else expect(read).toBeNull();
    }
  });

  it('refuses a unit or a thousands separator rather than reading past it', () => {
    // `Scaled` would read 2.5 out of "2.5kg" and 1 out of "1,299" — the same
    // trap `attribute-values.ts` refuses, and here it would suggest a car boot
    // for something weighing 1,299 kg.
    expect(readItemWeight([WEIGHT], { weight_kg: '2.5kg' })).toBeNull();
    expect(readItemWeight([WEIGHT], { weight_kg: '1,299' })).toBeNull();
  });

  it('stays quiet on more decimal places than the category allows', () => {
    // "2.55" against one decimal place. The API refuses it on submit naming the
    // field; a suggestion has nothing useful to add.
    expect(readItemWeight([WEIGHT], { weight_kg: '2.55' })).toBeNull();
  });

  it('refuses a negative weight rather than treating it as very light', () => {
    // A typo, not a lighter item. Suggesting hand-carrying for it would be
    // confidently wrong.
    expect(readItemWeight([WEIGHT], { weight_kg: '-5' })).toBeNull();
  });

  it('ignores an answer of the wrong shape', () => {
    // A list where text belongs — what a `choice-many` answer looks like. It
    // cannot happen against a `number` attribute, and reading it would throw.
    expect(readItemWeight([WEIGHT], { weight_kg: ['12.5'] })).toBeNull();
  });
});
