import { describe, expect, it } from 'vitest';
import { readCollectionLocation } from './collection-location';

const BLANK = { line1: '', line2: '', town: '', postcode: '' };
const FULL = {
  line1: '12 Gloucester Road',
  line2: '',
  town: 'Bristol',
  postcode: 'bs7 8aa',
};

describe('reading a collection address off the form', () => {
  it('reads four empty fields as "not said yet"', () => {
    // §8.3 lets an owner save progress, so this is a real answer rather than a
    // missing one.
    expect(readCollectionLocation(BLANK)).toEqual({ ok: true, value: null });
  });

  it('treats whitespace as empty', () => {
    expect(
      readCollectionLocation({
        line1: '  ',
        line2: '\t',
        town: ' ',
        postcode: '   ',
      }),
    ).toEqual({ ok: true, value: null });
  });

  it('normalises the postcode rather than storing what was typed', () => {
    const outcome = readCollectionLocation(FULL);

    expect(outcome.ok).toBe(true);
    // `bs7 8aa` in, `BS7 8AA` out. Normalising in the contract means every
    // layer below sees one representation, and the outward code that gets
    // published is derived from the same string that gets stored.
    expect(outcome.ok && outcome.value?.postcode).toBe('BS7 8AA');
  });

  it('reads an absent second line as null, not as an empty string', () => {
    const outcome = readCollectionLocation(FULL);

    expect(outcome.ok && outcome.value?.line2).toBeNull();
  });

  it('keeps a second line that was given', () => {
    const outcome = readCollectionLocation({ ...FULL, line2: 'Flat 3' });

    expect(outcome.ok && outcome.value?.line2).toBe('Flat 3');
  });

  /**
   * The decision this module exists for.
   *
   * Reading a half-typed address as "not said" would throw away what somebody
   * wrote with no error anywhere — the same failure 2.4b's "unknown keys are
   * refused, not dropped" prevents, arriving through a different door.
   */
  describe('a partly filled address', () => {
    it('is refused rather than dropped', () => {
      const outcome = readCollectionLocation({ ...BLANK, line1: '12 Gloucester Road' });

      expect(outcome.ok).toBe(false);
    });

    it('counts a second line alone as having started', () => {
      const outcome = readCollectionLocation({ ...BLANK, line2: 'Flat 3' });

      expect(outcome.ok).toBe(false);
    });

    it('names the fields by their labels, never by the contract key', () => {
      const outcome = readCollectionLocation({ ...BLANK, line1: '12 Gloucester Road' });

      // `line1` and `town` appear nowhere on the form. 2.4b's finding, twice
      // over: an error naming a key the reader cannot see is one they cannot
      // act on.
      expect(outcome.ok === false && outcome.message).toContain('the town');
      expect(outcome.ok === false && outcome.message).toContain('the postcode');
      expect(outcome.ok === false && outcome.message).not.toContain('postcode:');
    });

    it('refuses a postcode that is not one', () => {
      const outcome = readCollectionLocation({ ...FULL, postcode: 'NOT A POSTCODE' });

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.message).toContain('the postcode');
    });
  });
});
