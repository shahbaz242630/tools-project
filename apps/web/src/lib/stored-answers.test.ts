import { describe, expect, it } from 'vitest';
import type { CategoryAttribute } from '@platform/contracts';
import { toStoredAnswers } from './stored-answers';

/**
 * Stored values back into form answers (slice 2.9b-i).
 *
 * **The property this file is really about is the round trip.** An owner who
 * opens the edit form and presses Save without touching anything must get back
 * exactly what they had. Nothing else would catch a failure — a weight of 385 kg
 * where 38.5 kg was meant is a legal value, it saves cleanly, and the only
 * evidence is on the listing page afterwards.
 */

const SCHEMA: readonly CategoryAttribute[] = [
  { key: 'notes', label: 'Notes', required: false, type: 'text', maxLength: 40 },
  {
    key: 'weight_kg',
    label: 'Weight',
    required: true,
    type: 'number',
    unit: 'kg',
    decimalPlaces: 1,
  },
  {
    key: 'power_source',
    label: 'Power source',
    required: true,
    type: 'choice',
    options: [
      { value: 'petrol', label: 'Petrol' },
      { value: 'cordless', label: 'Cordless' },
    ],
  },
  {
    key: 'accessories',
    label: 'Accessories',
    required: false,
    type: 'choice-many',
    options: [
      { value: 'case', label: 'Case' },
      { value: 'blade', label: 'Spare blade' },
    ],
  },
];

describe('turning stored values back into what the form holds', () => {
  it('unscales a number to the decimal the person typed', () => {
    // The whole point. `385` is stored, `38.5` was typed, and the scale is
    // category configuration (ADR 0029) — so this has to read `decimalPlaces`
    // rather than assume anything.
    expect(toStoredAnswers(SCHEMA, { weight_kg: 385 }).weight_kg).toBe('38.5');
  });

  it('round-trips a number through the scale the server applies', () => {
    // Asserted as the inverse rather than as a literal, because the pair is what
    // matters: whatever the server does on the way in, this must undo exactly.
    for (const typed of ['0.1', '5.2', '38.5', '120.0']) {
      const scaled = Math.round(Number(typed) * 10);

      expect(toStoredAnswers(SCHEMA, { weight_kg: scaled }).weight_kg).toBe(typed);
    }
  });

  it('keeps text and a single choice as they are', () => {
    const answers = toStoredAnswers(SCHEMA, {
      notes: 'Blade recently sharpened',
      power_source: 'petrol',
    });

    expect(answers.notes).toBe('Blade recently sharpened');
    expect(answers.power_source).toBe('petrol');
  });

  it('copies a multi-choice rather than sharing the array', () => {
    // The form mutates its own answers as fields change. Sharing the reference
    // would let it rewrite the listing object the page is still rendering from.
    const stored = { accessories: ['case', 'blade'] };
    const answers = toStoredAnswers(SCHEMA, stored);

    expect(answers.accessories).toEqual(['case', 'blade']);
    expect(answers.accessories).not.toBe(stored.accessories);
  });

  it('leaves an unanswered attribute absent rather than blank', () => {
    // Absent is what an untouched field holds, and the platform has one
    // representation of "not answered" (2.4b). An empty string here would be
    // submitted back as an answer.
    expect(toStoredAnswers(SCHEMA, {})).toEqual({});
    expect('notes' in toStoredAnswers(SCHEMA, {})).toBe(false);
  });

  it('drops a value the current schema no longer has a field for', () => {
    // ADR 0042: editing brings a listing onto the current configuration, and a
    // question the platform no longer asks has no field to render into. The
    // value goes when the edit saves, which is the accepted consequence.
    const answers = toStoredAnswers(SCHEMA, { retired_key: 'something' });

    expect(answers).toEqual({});
  });

  it('drops a stored value whose shape does not match the definition', () => {
    /*
     * An attribute redefined from `text` to `number` between the listing being
     * written and now. The stored string is not a scaled integer, and
     * `Scaled.toDecimalString` throws on one — which would take down the whole
     * edit form over a single field.
     *
     * Dropping is the right failure: the field renders empty, the owner answers
     * it, and the publication gate refuses until they do if it is required.
     */
    expect(() => toStoredAnswers(SCHEMA, { weight_kg: 'heavy' })).not.toThrow();
    expect(toStoredAnswers(SCHEMA, { weight_kg: 'heavy' })).toEqual({});

    // And the mirror: a number stored where a `choice` now stands.
    expect(toStoredAnswers(SCHEMA, { power_source: 12 })).toEqual({});
  });

  it('reads against the schema it is given, not against every stored key', () => {
    // The two are genuinely different here: the values were written against the
    // pinned version and the schema is the current one.
    const answers = toStoredAnswers([SCHEMA[1] as CategoryAttribute], {
      weight_kg: 385,
      power_source: 'petrol',
      notes: 'kept elsewhere',
    });

    expect(answers).toEqual({ weight_kg: '38.5' });
  });
});
