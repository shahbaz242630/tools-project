import { describe, expect, it } from 'vitest';
import { PhoneError, format, isValid, parse } from './phone.js';

/**
 * Numbers from Ofcom's reserved drama ranges (07700 900xxx, 020 7946 0xxx).
 * They can never be allocated to a real subscriber, so a test that somehow
 * escapes into a live SMS send cannot ring a stranger's phone.
 */
const MOBILE = '+447700900123';
const LANDLINE = '+442079460123';

describe('parse', () => {
  it.each([
    ['trunk form', '07700900123'],
    ['trunk form with spaces', '07700 900123'],
    ['E.164', '+447700900123'],
    ['E.164 with spaces', '+44 7700 900123'],
    ['international access code', '00447700900123'],
    ['country code without a plus', '447700900123'],
    ['brackets and hyphens', '(07700) 900-123'],
    ['dots', '07700.900.123'],
    ['a non-breaking space', '07700 900123'],
  ])('normalises %s to E.164', (_label, raw) => {
    // The point of normalising on the way in: these are one number, and a
    // duplicate check across accounts is worthless if they store as nine.
    expect(parse(raw)).toBe(MOBILE);
  });

  it('accepts a London landline', () => {
    expect(parse('020 7946 0123')).toBe(LANDLINE);
  });

  it('accepts a nine-digit national number', () => {
    // Brampton's 016977 range is genuinely nine digits after the trunk zero.
    // A parser that assumes ten rejects real customers in Cumbria.
    expect(parse('016977 3123')).toBe('+44169773123');
  });

  it('does not mistake a national number beginning 44 for a country code', () => {
    // 01440 is a real Haverhill area code. Stripping "44" on the prefix alone
    // would truncate it into a different, shorter number that still looks
    // plausible — the worst kind of parsing bug, because nothing errors.
    expect(parse('01440 123456')).toBe('+441440123456');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too short', '0770090'],
    ['too long', '077009001234567'],
    ['letters', '0770 CALL ME'],
    ['a US number', '+1 555 0100'],
    ['a leading zero after the trunk code', '00123456789'],
    ['a reserved leading digit', '04700900123'],
    ['free text', 'call me'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parse(raw)).toThrow(PhoneError);
  });

  it('rejects a non-UK number rather than storing it as British', () => {
    // The reason this parser is deliberately narrow. Silently keeping
    // "+1 555 0100" as a UK number produces a record that looks fine and can
    // never be called.
    expect(() => parse('+33 1 42 68 53 00')).toThrow(PhoneError);
  });

  it('names the offending value, so a form can show it back', () => {
    expect(() => parse('+1 555 0100')).toThrow(/555/);
  });

  it('says a number is required rather than that it is invalid', () => {
    expect(() => parse('  ')).toThrow(/required/i);
  });
});

describe('isValid', () => {
  it('agrees with parse on both answers', () => {
    expect(isValid('07700 900123')).toBe(true);
    expect(isValid('+1 555 0100')).toBe(false);
  });

  it('does not throw on rubbish', () => {
    expect(isValid('')).toBe(false);
    expect(isValid('call me')).toBe(false);
  });
});

describe('format', () => {
  it('groups a mobile the way a British reader expects', () => {
    expect(format(MOBILE)).toBe('07700 900123');
  });

  it('leaves a landline as one national block', () => {
    // Landline grouping depends on the area code's length — 020 7946 0123 but
    // 0117 496 0123 — and guessing wrong looks worse than not grouping.
    expect(format(LANDLINE)).toBe('02079460123');
  });

  it('returns an unparseable value untouched rather than throwing', () => {
    // A display helper. A profile page that crashes over a badly stored legacy
    // value is a worse outcome than one showing it verbatim.
    expect(format('nonsense')).toBe('nonsense');
  });

  it('round-trips through parse', () => {
    expect(parse(format(MOBILE))).toBe(MOBILE);
  });
});
