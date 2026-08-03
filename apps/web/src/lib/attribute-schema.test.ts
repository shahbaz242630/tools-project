import { describe, expect, it } from 'vitest';
import { readAttributeSchema } from './attribute-schema';

const CHOICE = {
  key: 'power_source',
  label: 'Power source',
  required: true,
  type: 'choice',
  options: [
    { value: 'petrol', label: 'Petrol' },
    { value: 'cordless', label: 'Cordless' },
  ],
};

describe('readAttributeSchema', () => {
  it('reads a schema the editor posted', () => {
    const outcome = readAttributeSchema(JSON.stringify([CHOICE]));

    expect(outcome).toEqual({ kind: 'read', attributes: [CHOICE] });
  });

  it('reads an explicitly empty schema', () => {
    // Distinct from an absent field, and the distinction is the point.
    expect(readAttributeSchema('[]')).toEqual({ kind: 'read', attributes: [] });
  });

  it.each([[null], [undefined], [''], ['   ']])(
    'refuses %s rather than treating it as no attributes',
    (raw) => {
      // ADR 0025's lesson at the one boundary where the form could lie by
      // omission: guessing "they meant none" would clear the schema of every
      // listing in the category while answering as though the save worked.
      const outcome = readAttributeSchema(raw);

      expect(outcome.kind).toBe('unreadable');
      if (outcome.kind === 'unreadable') {
        expect(outcome.message).toMatch(/did not reach the server/i);
      }
    },
  );

  it('refuses something that is not JSON', () => {
    const outcome = readAttributeSchema('not json at all');

    expect(outcome.kind).toBe('unreadable');
    if (outcome.kind === 'unreadable') {
      expect(outcome.message).toMatch(/could not be read/i);
    }
  });

  it('refuses valid JSON that is not a schema, and says which field', () => {
    const outcome = readAttributeSchema(
      JSON.stringify([{ ...CHOICE, options: [CHOICE.options[0]] }]),
    );

    expect(outcome.kind).toBe('unreadable');
    if (outcome.kind === 'unreadable') {
      expect(outcome.message).toMatch(/at least two options/i);
    }
  });

  it('refuses a type outside the vocabulary', () => {
    // The exit gate in one assertion: a field no renderer can draw must not
    // reach storage, whatever posts it.
    const outcome = readAttributeSchema(
      JSON.stringify([{ key: 'from', label: 'From', required: false, type: 'date' }]),
    );

    expect(outcome.kind).toBe('unreadable');
  });

  it('refuses a JSON object where an array belongs', () => {
    expect(readAttributeSchema(JSON.stringify({ power_source: 'petrol' })).kind).toBe(
      'unreadable',
    );
  });
});
