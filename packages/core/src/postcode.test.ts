import { describe, expect, it } from 'vitest';
import { PostcodeError, isValid, outwardCode, parse } from './postcode.js';

/**
 * Every format in the UK scheme, one example each.
 *
 * Enumerated rather than fuzzed because the formats are a closed set and the
 * bugs live in the rare ones: `EC1A 1BB` and `W1A 0AX` carry a letter where
 * most postcodes carry a digit, and a pattern written from the common cases
 * accepts the first four rows and quietly rejects real central-London addresses.
 */
const FORMATS: ReadonlyArray<readonly [string, string, string]> = [
  ['A9 9AA', 'M1 1AA', 'M1'],
  ['A99 9AA', 'M60 1NW', 'M60'],
  ['A9A 9AA', 'W1A 0AX', 'W1A'],
  ['AA9 9AA', 'CR2 6XH', 'CR2'],
  ['AA99 9AA', 'DN55 1PT', 'DN55'],
  ['AA9A 9AA', 'EC1A 1BB', 'EC1A'],
];

describe('parse', () => {
  it.each(FORMATS)('accepts the %s format (%s)', (_format, postcode) => {
    expect(parse(postcode)).toBe(postcode);
  });

  it('accepts GIR 0AA, which fits none of the general formats', () => {
    // A real postcode (the former Girobank in Bootle). It is in every published
    // pattern as an explicit alternation, and a regex written from the format
    // table alone rejects it.
    expect(parse('GIR 0AA')).toBe('GIR 0AA');
  });

  it.each([
    ['lower case', 'bs7 8aa'],
    ['no space', 'BS78AA'],
    ['extra spaces', 'BS7   8AA'],
    ['leading and trailing space', '  BS7 8AA  '],
    ['mixed case and no space', 'bS78Aa'],
    ['a non-breaking space', 'BS7 8AA'],
  ])('normalises %s to the canonical form', (_label, raw) => {
    // One representation reaching the database is what makes comparison and
    // geocoder lookups reliable. A non-breaking space is in the list because
    // values pasted from a web page or a PDF routinely carry one, and telling
    // someone who typed their postcode correctly that it is invalid is a
    // support ticket rather than a validation.
    expect(parse(raw)).toBe('BS7 8AA');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a partial postcode', 'BS7'],
    ['an inward code alone', '8AA'],
    ['too many digits', 'BS777 8AA'],
    ['a US ZIP', '90210'],
    ['letters where the inward digit belongs', 'BS7 AAA'],
    ['free text', 'not a postcode'],
    ['an injection attempt', "BS7 8AA'; DROP TABLE profiles;--"],
  ])('rejects %s', (_label, raw) => {
    expect(() => parse(raw)).toThrow(PostcodeError);
  });

  it.each(['C', 'I', 'K', 'M', 'O', 'V'])(
    'rejects %s in the inward code, which Royal Mail never issues',
    (letter) => {
      // These six were excluded to stop handwritten postcodes being misread.
      // Accepting them would let a typo through to the geocoder, where it fails
      // as somebody else's error, much later, against a row already stored.
      expect(() => parse(`BS7 8A${letter}`)).toThrow(PostcodeError);
    },
  );

  it('rejects I and Z as the second letter', () => {
    expect(() => parse('BI7 8AA')).toThrow(PostcodeError);
    expect(() => parse('BZ7 8AA')).toThrow(PostcodeError);
  });

  it('names the offending value, so a form can show it back', () => {
    expect(() => parse('90210')).toThrow(/90210/);
  });

  it('says a postcode is required rather than that it is invalid', () => {
    // "Not a valid UK postcode: " with nothing after it reads as a bug in the
    // form, not as an empty field.
    expect(() => parse('  ')).toThrow(/required/i);
  });
});

describe('isValid', () => {
  it('agrees with parse on both answers', () => {
    expect(isValid('bs78aa')).toBe(true);
    expect(isValid('90210')).toBe(false);
  });

  it('does not throw on rubbish', () => {
    expect(isValid('')).toBe(false);
  });
});

describe('outwardCode', () => {
  it.each(FORMATS)(
    'takes the district from the %s format (%s → %s)',
    (_format, postcode, outward) => {
      expect(outwardCode(postcode)).toBe(outward);
    },
  );

  it('takes GIR from GIR 0AA', () => {
    expect(outwardCode('GIR 0AA')).toBe('GIR');
  });

  it('normalises before splitting', () => {
    expect(outwardCode('ec1a1bb')).toBe('EC1A');
  });

  it('never returns the inward code, whatever the spacing', () => {
    // The guarantee the public projection depends on: an outward code is a
    // postal district covering thousands of addresses, an inward code narrows
    // it to roughly fifteen households. If this ever returns the second, every
    // public profile leaks something close to a street address.
    for (const raw of ['BS78AA', 'BS7 8AA', ' bs7  8aa ']) {
      expect(outwardCode(raw)).toBe('BS7');
      expect(outwardCode(raw)).not.toContain('8AA');
    }
  });

  it('refuses to derive a district from an invalid postcode', () => {
    // Splitting on whitespace instead would hand back "not" for "not a
    // postcode" — a plausible-looking district, published to the world. The
    // caller holding an unvalidated string is precisely the one about to show
    // it publicly.
    expect(() => outwardCode('not a postcode')).toThrow(PostcodeError);
    expect(() => outwardCode('BS7')).toThrow(PostcodeError);
  });
});
