import { describe, expect, it } from 'vitest';
import { readSubmittedAttributes } from './submitted-attributes';

describe('reading the posted attribute answers', () => {
  it('reads the object the form serialised', () => {
    expect(
      readSubmittedAttributes('{"power_source":"petrol","weight_kg":"5.2"}'),
    ).toEqual({
      ok: true,
      value: { power_source: 'petrol', weight_kg: '5.2' },
    });
  });

  it('reads an empty set — a draft may answer nothing', () => {
    expect(readSubmittedAttributes('{}')).toEqual({ ok: true, value: {} });
  });

  it('does not judge the values, because only the API holds the schema', () => {
    // Which keys are legal and what each type accepts is category
    // configuration. A second opinion here is the one that drifts.
    expect(readSubmittedAttributes('{"not_a_field":{"deeply":"odd"}}').ok).toBe(true);
  });

  it.each(['', 'not json', 'null', '[]', '"a string"', '42'])(
    'refuses %s as a set of answers',
    (raw) => {
      const result = readSubmittedAttributes(raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toMatch(/could not be read/i);
    },
  );

  it('refuses a missing field rather than assuming no answers', () => {
    // An absent field means the form was not the one we rendered. Reading it as
    // `{}` would save a listing with the category's fields silently blank.
    expect(readSubmittedAttributes(null).ok).toBe(false);
  });

  it('refuses a file entry', () => {
    expect(
      readSubmittedAttributes(new File([''], 'x.txt') as FormDataEntryValue).ok,
    ).toBe(false);
  });
});
