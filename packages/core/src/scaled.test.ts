import { describe, expect, it } from 'vitest';
import * as S from './scaled.js';

describe('reading a decimal string at a fixed scale', () => {
  it.each([
    ['2.5', 1, 25],
    ['2', 1, 20],
    ['18', 0, 18],
    ['0', 0, 0],
    ['0.0', 1, 0],
    ['0.001', 3, 1],
    ['12.75', 2, 1275],
    [' 7.5 ', 1, 75],
    ['-4.5', 1, -45],
  ])('reads %s at %d places as %d', (input, places, expected) => {
    expect(S.fromDecimalString(input, places)).toBe(expected);
  });

  it.each(['', 'abc', '1,299', '2.5kg', '£4', '1e3', '.5', '5.', '+5'])(
    'refuses %s',
    (input) => {
      expect(() => S.fromDecimalString(input, 2)).toThrow(S.ScaledError);
    },
  );

  it('refuses more precision than the scale allows rather than rounding it away', () => {
    // Rounding 2.55 to 2.5 without saying so is how somebody's number quietly
    // becomes a different number on a page they are held to.
    expect(() => S.fromDecimalString('2.55', 1)).toThrow(/more than 1 decimal place/);
  });

  it('says "whole number" rather than "0 decimal places" at zero scale', () => {
    expect(() => S.fromDecimalString('18.5', 0)).toThrow(/must be a whole number/);
  });

  it('pluralises the precision message', () => {
    expect(() => S.fromDecimalString('2.555', 2)).toThrow(/more than 2 decimal places/);
  });

  it('never produces negative zero', () => {
    // -0 survives JSON, compares equal to 0 and prints differently, so a stored
    // value must not be one.
    expect(Object.is(S.fromDecimalString('-0.0', 1), 0)).toBe(true);
  });

  it('refuses a value too large to hold exactly', () => {
    expect(() => S.fromDecimalString('99999999999999999', 3)).toThrow(/too large/);
  });

  it.each([-1, 1.5, 10, Number.NaN])('refuses a scale of %s', (places) => {
    expect(() => S.fromDecimalString('1', places)).toThrow(S.ScaledError);
  });
});

describe('writing a scaled integer back out', () => {
  it.each([
    [25, 1, '2.5'],
    [20, 1, '2.0'],
    [18, 0, '18'],
    [0, 0, '0'],
    [0, 2, '0.00'],
    [1, 3, '0.001'],
    [-45, 1, '-4.5'],
    [1275, 2, '12.75'],
  ])('writes %d at %d places as %s', (value, places, expected) => {
    expect(S.toDecimalString(value, places)).toBe(expected);
  });

  it('round-trips every scale', () => {
    for (const [input, places] of [
      ['2.5', 1],
      ['18', 0],
      ['0.001', 3],
      ['-4.50', 2],
    ] as const) {
      const scaled = S.fromDecimalString(input, places);
      expect(S.fromDecimalString(S.toDecimalString(scaled, places), places)).toBe(
        scaled,
      );
    }
  });

  it('refuses a value that is not a whole number of units', () => {
    expect(() => S.toDecimalString(2.5, 1)).toThrow(S.ScaledError);
  });

  it('refuses an impossible scale', () => {
    expect(() => S.toDecimalString(25, 12)).toThrow(S.ScaledError);
  });
});

describe('formatting for display', () => {
  it('puts the unit after the number', () => {
    expect(S.format(25, 1, 'kg')).toBe('2.5 kg');
  });

  it('leaves no trailing space when a unit is somehow empty', () => {
    expect(S.format(18, 0, '')).toBe('18');
  });
});
