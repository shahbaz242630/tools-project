import { describe, expect, it } from 'vitest';
import { ContractViolationError } from './parse.js';
import {
  MAX_ATTRIBUTE_DECIMAL_PLACES,
  MAX_ATTRIBUTE_OPTIONS,
  MAX_ATTRIBUTE_TEXT_LENGTH,
  MAX_CATEGORY_ATTRIBUTES,
  parseCategoryAttributes,
  parseCategoryConfiguration,
  parseCategoryDraft,
} from './catalogue.js';
import type { CategoryAttribute } from './catalogue.js';

/**
 * The five shapes the category research actually found, in one schema.
 *
 * Kept as the fixture rather than something invented, so a change that breaks
 * the real launch category breaks a test rather than a listing form.
 */
const realisticSchema: readonly CategoryAttribute[] = [
  {
    key: 'power_source',
    label: 'Power source',
    required: true,
    type: 'choice',
    options: [
      { value: 'petrol', label: 'Petrol' },
      { value: 'electric', label: 'Mains electric' },
      { value: 'cordless', label: 'Cordless battery' },
      { value: 'manual', label: 'Manual' },
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
    key: 'motor_spec',
    label: 'Engine or motor',
    required: false,
    type: 'text',
    maxLength: 60,
  },
  {
    key: 'accessories_included',
    label: 'Accessories included',
    required: false,
    type: 'choice-many',
    options: [
      { value: 'carry-case', label: 'Carry case' },
      { value: 'spare-blade', label: 'Spare blade' },
    ],
  },
];

const option = (value: string) => ({ value, label: value });

const choice = (
  overrides: Partial<Extract<CategoryAttribute, { type: 'choice' }>> = {},
): unknown => ({
  key: 'power_source',
  label: 'Power source',
  required: true,
  type: 'choice',
  options: [option('petrol'), option('electric')],
  ...overrides,
});

function issuesOf(read: () => unknown): readonly string[] {
  try {
    read();
  } catch (error) {
    if (error instanceof ContractViolationError) return error.issues;
    throw error;
  }
  throw new Error('Expected the contract to reject this, and it did not');
}

describe('parseCategoryAttributes', () => {
  it('accepts the schema the launch category actually wants', () => {
    expect(parseCategoryAttributes(realisticSchema)).toEqual(realisticSchema);
  });

  it('accepts an empty schema', () => {
    // What every category written before slice 2.2 truthfully has. Rejecting it
    // would make the migration's default unreadable by its own contract.
    expect(parseCategoryAttributes([])).toEqual([]);
  });

  it('preserves order rather than sorting it', () => {
    // Order is the render order, and the audit digest keeps array order for
    // exactly this reason (ADR 0017) — a reorder is a real configuration change.
    const reversed = [...realisticSchema].reverse();
    expect(parseCategoryAttributes(reversed).map((a) => a.key)).toEqual([
      'accessories_included',
      'motor_spec',
      'weight_kg',
      'power_source',
    ]);
  });

  it('rejects two attributes sharing a key, naming the second one', () => {
    // A listing keys its values by attribute key, so the second definition
    // could never hold a value.
    const issues = issuesOf(() =>
      parseCategoryAttributes([choice(), choice({ label: 'Fuel' })]),
    );

    expect(issues).toContain('1.key: duplicate attribute key "power_source"');
  });

  it('rejects more attributes than the cap', () => {
    const many = Array.from({ length: MAX_CATEGORY_ATTRIBUTES + 1 }, (_, index) =>
      choice({ key: `attribute_${String(index)}` }),
    );

    expect(issuesOf(() => parseCategoryAttributes(many))).toContain(
      `must be at most ${String(MAX_CATEGORY_ATTRIBUTES)} attributes`,
    );
  });

  it('accepts exactly the cap', () => {
    const many = Array.from({ length: MAX_CATEGORY_ATTRIBUTES }, (_, index) =>
      choice({ key: `attribute_${String(index)}` }),
    );

    expect(parseCategoryAttributes(many)).toHaveLength(MAX_CATEGORY_ATTRIBUTES);
  });

  it('rejects a type outside the vocabulary', () => {
    // The whole point of ADR 0027: a configured field no renderer can draw is
    // the exit gate failing, so storage must refuse it.
    expect(() =>
      parseCategoryAttributes([
        { key: 'available_from', label: 'From', required: false, type: 'date' },
      ]),
    ).toThrow(ContractViolationError);
  });
});

describe('attribute keys', () => {
  it.each([
    ['power_source', true],
    ['weight_kg', true],
    ['a', false],
    ['Power_Source', false],
    ['power-source', false],
    ['power__source', false],
    ['_power', false],
    ['9lives', false],
    ['power source', false],
  ])('%s is %s', (key, accepted) => {
    const read = () => parseCategoryAttributes([choice({ key })]);

    if (accepted) expect(read()).toHaveLength(1);
    else expect(read).toThrow(ContractViolationError);
  });
});

describe('choice attributes', () => {
  it('rejects a single-answer question with one option', () => {
    // A select offering one answer asks a question already answered. The field
    // should not exist rather than be ticked past.
    expect(
      issuesOf(() =>
        parseCategoryAttributes([choice({ options: [option('petrol')] })]),
      ),
    ).toContain('0.options: a single-answer question needs at least two options');
  });

  it('rejects duplicate option values, naming the offending index', () => {
    const issues = issuesOf(() =>
      parseCategoryAttributes([
        choice({ options: [option('petrol'), option('petrol')] }),
      ]),
    );

    expect(issues).toContain('0.options.1.value: duplicate option value "petrol"');
  });

  it('allows two options to share a label while their values differ', () => {
    // The words on screen are the administrator's business. The stored value is
    // the platform's, and only that has to be unambiguous.
    expect(
      parseCategoryAttributes([
        choice({
          options: [
            { value: 'petrol', label: 'Fuel' },
            { value: 'diesel', label: 'Fuel' },
          ],
        }),
      ]),
    ).toHaveLength(1);
  });

  it('rejects more options than the cap', () => {
    const options = Array.from({ length: MAX_ATTRIBUTE_OPTIONS + 1 }, (_, index) =>
      option(`option-${String(index)}`),
    );

    expect(() => parseCategoryAttributes([choice({ options })])).toThrow(
      ContractViolationError,
    );
  });

  it.each([['cordless'], ['two-stroke'], ['petrol_4t'], ['x1']])(
    'accepts the option value %s',
    (value) => {
      expect(
        parseCategoryAttributes([
          choice({ options: [option(value), option('other')] }),
        ]),
      ).toHaveLength(1);
    },
  );

  it.each([['Cordless'], ['two stroke'], ['-cordless'], ['']])(
    'rejects the option value %s',
    (value) => {
      expect(() =>
        parseCategoryAttributes([
          choice({ options: [option(value), option('other')] }),
        ]),
      ).toThrow(ContractViolationError);
    },
  );

  it('accepts a choice-many with a single option', () => {
    // The honest form of the boolean this vocabulary deliberately lacks:
    // "chain guard included", ticked or not.
    expect(
      parseCategoryAttributes([
        {
          key: 'chain_guard',
          label: 'Chain guard included',
          required: false,
          type: 'choice-many',
          options: [{ value: 'included', label: 'Included' }],
        },
      ]),
    ).toHaveLength(1);
  });
});

describe('number attributes', () => {
  const number = (overrides: Record<string, unknown> = {}): unknown => ({
    key: 'weight_kg',
    label: 'Weight',
    required: true,
    type: 'number',
    unit: 'kg',
    decimalPlaces: 1,
    ...overrides,
  });

  it('accepts a whole-number quantity', () => {
    expect(parseCategoryAttributes([number({ decimalPlaces: 0 })])).toHaveLength(1);
  });

  it('rejects a scale finer than the cap', () => {
    expect(() =>
      parseCategoryAttributes([
        number({ decimalPlaces: MAX_ATTRIBUTE_DECIMAL_PLACES + 1 }),
      ]),
    ).toThrow(ContractViolationError);
  });

  it('rejects a fractional scale', () => {
    // decimalPlaces is a count of digits. A non-integer here would make the
    // stored scale meaningless and every value in the category ambiguous.
    expect(() => parseCategoryAttributes([number({ decimalPlaces: 1.5 })])).toThrow(
      ContractViolationError,
    );
  });

  it('rejects a missing unit', () => {
    expect(() => parseCategoryAttributes([number({ unit: '' })])).toThrow(
      ContractViolationError,
    );
  });

  it('carries no bounds — those arrive in 2.4 with the validator that reads them', () => {
    const parsed = parseCategoryAttributes([number({ minimum: 0, maximum: 500 })]);

    expect(parsed[0]).not.toHaveProperty('minimum');
    expect(parsed[0]).not.toHaveProperty('maximum');
  });
});

describe('text attributes', () => {
  it('rejects a maximum length above the ceiling', () => {
    expect(() =>
      parseCategoryAttributes([
        {
          key: 'motor_spec',
          label: 'Engine',
          required: false,
          type: 'text',
          maxLength: MAX_ATTRIBUTE_TEXT_LENGTH + 1,
        },
      ]),
    ).toThrow(ContractViolationError);
  });

  it('rejects a maximum length of zero', () => {
    expect(() =>
      parseCategoryAttributes([
        {
          key: 'motor_spec',
          label: 'Engine',
          required: false,
          type: 'text',
          maxLength: 0,
        },
      ]),
    ).toThrow(ContractViolationError);
  });
});

describe('the category body schemas', () => {
  it('requires attributes on a draft rather than defaulting them', () => {
    // ADR 0025's lesson, paid for twice: an optional field is a silent default,
    // and a silent default on configuration every booking is read under is the
    // wrong shape. A caller that forgets gets a 400, not an empty schema.
    expect(() =>
      parseCategoryDraft({
        slug: 'outdoor-gardening',
        name: 'Garden',
        riskLevel: 'low',
      }),
    ).toThrow(ContractViolationError);
  });

  it('requires attributes on a reconfiguration for the same reason', () => {
    expect(() =>
      parseCategoryConfiguration({ name: 'Garden', riskLevel: 'low' }),
    ).toThrow(ContractViolationError);
  });

  it('accepts a draft carrying a schema', () => {
    expect(
      parseCategoryDraft({
        slug: 'outdoor-gardening',
        name: 'Garden and outdoor',
        riskLevel: 'low',
        attributes: realisticSchema,
      }).attributes,
    ).toEqual(realisticSchema);
  });

  it('accepts an explicitly empty schema', () => {
    expect(
      parseCategoryConfiguration({ name: 'Garden', riskLevel: 'low', attributes: [] })
        .attributes,
    ).toEqual([]);
  });
});
