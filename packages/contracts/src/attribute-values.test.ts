import { describe, expect, it } from 'vitest';
import type { CategoryAttribute } from './catalogue.js';
import { describeAttributeIssue, validateAttributeValues } from './attribute-values.js';

/**
 * One schema exercising all four types, close to the launch category's shape.
 *
 * Deliberately not the launch category itself — a test that encodes
 * `outdoor-gardening` would fail the day somebody reconfigures it, and the
 * mechanism being general is the thing under test.
 */
const SCHEMA: readonly CategoryAttribute[] = [
  {
    key: 'power_source',
    label: 'Power source',
    required: true,
    type: 'choice',
    options: [
      { value: 'petrol', label: 'Petrol' },
      { value: 'mains', label: 'Mains electric' },
      { value: 'cordless', label: 'Cordless battery' },
    ],
  },
  {
    key: 'weight_kg',
    label: 'Weight',
    required: true,
    type: 'number',
    unit: 'kg',
    decimalPlaces: 1,
  },
  {
    key: 'condition_notes',
    label: 'Condition notes',
    required: false,
    type: 'text',
    maxLength: 20,
  },
  {
    key: 'accessories',
    label: 'Accessories',
    required: false,
    type: 'choice-many',
    options: [
      { value: 'case', label: 'Carry case' },
      { value: 'blade', label: 'Spare blade' },
      { value: 'charger', label: 'Charger' },
    ],
  },
];

const ok = (raw: unknown) => {
  const result = validateAttributeValues(SCHEMA, raw);
  if (!result.ok)
    throw new Error(`expected valid, got ${JSON.stringify(result.issues)}`);
  return result.values;
};

const messages = (raw: unknown): readonly string[] => {
  const result = validateAttributeValues(SCHEMA, raw);
  if (result.ok) throw new Error('expected invalid');
  return result.issues.map((issue) => issue.message);
};

describe('the shape of the whole value', () => {
  it.each([null, undefined, 'text', 42, ['power_source']])(
    'refuses %s as a set of answers',
    (raw) => {
      expect(messages(raw)).toEqual([
        'The attribute values must be an object of answers',
      ]);
    },
  );

  it('accepts an empty set — a draft may answer nothing at all', () => {
    expect(ok({})).toEqual({});
  });

  it('refuses more keys than any schema could have, in one message', () => {
    const junk = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`junk_${String(index)}`, 'x']),
    );
    // One issue, not forty: the request is refused on its size before anything
    // is walked, so junk cannot turn into an unbounded error body.
    expect(messages(junk)).toHaveLength(1);
    expect(messages(junk)[0]).toMatch(/At most 12 attribute values/);
  });
});

describe('required attributes', () => {
  it('does not enforce them — a draft saves progress (§8.3)', () => {
    // `power_source` and `weight_kg` are both required and both absent.
    expect(ok({})).toEqual({});
    expect(ok({ condition_notes: 'Blade sharpened' })).toEqual({
      condition_notes: 'Blade sharpened',
    });
  });

  it('treats null as unanswered rather than as a wrong answer', () => {
    // What an untouched field serialises to. A draft not having answered
    // something is the normal case, not an error.
    expect(ok({ power_source: null, weight_kg: null })).toEqual({});
  });
});

describe('unknown keys', () => {
  it('refuses rather than silently dropping what somebody typed', () => {
    expect(messages({ power_supply: 'petrol' })).toEqual([
      '"power_supply" is not a field of this category. It may have been renamed or ' +
        'removed since this form was opened',
    ]);
  });

  it('names the key so the message survives a rename', () => {
    const result = validateAttributeValues(SCHEMA, { old_key: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.key).toBe('old_key');
  });

  it('reports every unknown key, not only the first', () => {
    expect(messages({ one: 'a', two: 'b' })).toHaveLength(2);
  });
});

describe('text', () => {
  it('stores the trimmed answer', () => {
    expect(ok({ condition_notes: '  Blade sharpened  ' })).toEqual({
      condition_notes: 'Blade sharpened',
    });
  });

  it('refuses a blank answer rather than storing an empty string', () => {
    // Two representations of "not answered" is one too many.
    expect(messages({ condition_notes: '   ' })[0]).toMatch(/must not be blank/);
  });

  it('refuses more than the configured maximum, naming the label', () => {
    expect(messages({ condition_notes: 'x'.repeat(21) })).toEqual([
      'Condition notes must be at most 20 characters',
    ]);
  });

  it('refuses direction-changing characters, as the title does', () => {
    expect(messages({ condition_notes: 'Fine‮ton' })[0]).toMatch(
      /control or direction-changing/,
    );
  });

  it('refuses a non-string', () => {
    expect(messages({ condition_notes: 42 })).toEqual(['Condition notes must be text']);
  });
});

describe('number', () => {
  it('scales what was typed, using the schema rather than anything the client said', () => {
    // 2.5 kg at one decimal place is stored as 25. The scale comes from the
    // definition, so a client cannot supply a value and the scale it means.
    expect(ok({ weight_kg: '2.5' })).toEqual({ weight_kg: 25 });
  });

  it('pads a value given at less precision than the scale', () => {
    expect(ok({ weight_kg: '3' })).toEqual({ weight_kg: 30 });
  });

  it('accepts zero and negatives — ADR 0027 shipped no bounds', () => {
    expect(ok({ weight_kg: '0' })).toEqual({ weight_kg: 0 });
    expect(ok({ weight_kg: '-5' })).toEqual({ weight_kg: -50 });
  });

  it('refuses a bare number, which could not say what scale it meant', () => {
    expect(messages({ weight_kg: 25 })[0]).toMatch(/must be sent as text/);
  });

  it('refuses more precision than the scale, naming the value', () => {
    expect(messages({ weight_kg: '2.55' })).toEqual([
      'Weight "2.55" has more than 1 decimal place',
    ]);
  });

  it.each(['2.5kg', '1,299', '£4', 'heavy', '1e3', '', '   '])(
    'refuses %s',
    (value) => {
      expect(messages({ weight_kg: value })).toHaveLength(1);
    },
  );

  it('names the unit in the message, because that is what the field shows', () => {
    expect(messages({ weight_kg: '2.5kg' })[0]).toMatch(/must be a number in kg/);
  });

  it('refuses a value too large to hold exactly', () => {
    expect(messages({ weight_kg: '999999999999999999' })[0]).toMatch(/too large/);
  });
});

describe('choice', () => {
  it('stores the option value, not its label', () => {
    expect(ok({ power_source: 'cordless' })).toEqual({ power_source: 'cordless' });
  });

  it('refuses a value outside the vocabulary, offering the labels', () => {
    expect(messages({ power_source: 'diesel' })).toEqual([
      'Power source must be one of Petrol, Mains electric, Cordless battery',
    ]);
  });

  it('refuses the label where the value was meant', () => {
    // A client posting what it displayed rather than what it stored.
    expect(messages({ power_source: 'Petrol' })[0]).toMatch(/must be one of/);
  });

  it('gives a wrong type the same message as a wrong value', () => {
    expect(messages({ power_source: 3 })).toEqual(messages({ power_source: 'diesel' }));
  });
});

describe('choice-many', () => {
  it('stores the chosen values', () => {
    expect(ok({ accessories: ['case', 'charger'] })).toEqual({
      accessories: ['case', 'charger'],
    });
  });

  it('stores them in the schema order, whatever order they arrived in', () => {
    // Two listings with the same answers must store the same value, or a later
    // comparison depends on how a form happened to serialise.
    expect(ok({ accessories: ['charger', 'case'] })).toEqual({
      accessories: ['case', 'charger'],
    });
  });

  it('refuses an unknown entry', () => {
    expect(messages({ accessories: ['case', 'trailer'] })[0]).toMatch(
      /may only contain/,
    );
  });

  it('refuses the same choice twice', () => {
    expect(messages({ accessories: ['case', 'case'] })).toEqual([
      'Accessories lists the same choice twice',
    ]);
  });

  it('refuses an empty list — absent is how nothing is said', () => {
    expect(messages({ accessories: [] })[0]).toMatch(/must not be an empty list/);
  });

  it('refuses a bare string where a list was meant', () => {
    expect(messages({ accessories: 'case' })[0]).toMatch(/must be a list of/);
  });

  it('refuses a non-string entry', () => {
    expect(messages({ accessories: [1] })[0]).toMatch(/may only contain/);
  });
});

describe('the stored result', () => {
  it('is keyed in the schema order regardless of how it arrived', () => {
    const values = ok({
      accessories: ['blade'],
      condition_notes: 'Fine',
      weight_kg: '3',
      power_source: 'petrol',
    });
    expect(Object.keys(values)).toEqual([
      'power_source',
      'weight_kg',
      'condition_notes',
      'accessories',
    ]);
  });

  it('collects every problem rather than stopping at the first', () => {
    expect(messages({ power_source: 'diesel', weight_kg: '1.55' })).toHaveLength(2);
  });

  it('accepts a category with no attributes at all', () => {
    const result = validateAttributeValues([], {});
    expect(result).toEqual({ ok: true, values: {} });
  });

  it('refuses any answer to a category with no attributes', () => {
    const result = validateAttributeValues([], { anything: 'x' });
    expect(result.ok).toBe(false);
  });
});

describe('describing an issue', () => {
  it('does not prefix the key, which the reader has never seen', () => {
    // Every other contract error here reads `field: message`, because there the
    // path *is* the field name on screen. An attribute's path is its key, and
    // ADR 0027 made the key internal on purpose — prefixing produced
    // "weight_kg: Weight ..." which names the field twice, once unrecognisably.
    expect(
      describeAttributeIssue({ key: 'weight_kg', message: 'Weight must be a number' }),
    ).toBe('Weight must be a number');
  });

  it('leaves a whole-value problem alone too', () => {
    expect(describeAttributeIssue({ key: null, message: 'Not an object' })).toBe(
      'Not an object',
    );
  });

  it('keeps the key on the issue, for whatever renders errors beside fields', () => {
    const result = validateAttributeValues(SCHEMA, { weight_kg: '2.55' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.key).toBe('weight_kg');
  });
});
