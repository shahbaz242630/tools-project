import { describe, expect, it } from 'vitest';
import { readTransportOptions } from './transport-options';

describe('readTransportOptions', () => {
  it('reads a selection the editor posted', () => {
    const outcome = readTransportOptions(
      JSON.stringify([{ requirement: 'car_boot', suggestedUpToKg: 25 }]),
    );

    expect(outcome).toEqual({
      kind: 'read',
      options: [{ requirement: 'car_boot', suggestedUpToKg: 25 }],
    });
  });

  it('reads an explicitly empty selection', () => {
    // Distinct from an absent field, and the distinction is the point.
    expect(readTransportOptions('[]')).toEqual({ kind: 'read', options: [] });
  });

  it.each([[null], [undefined], [''], ['   ']])(
    'refuses %s rather than treating it as offering nothing',
    (raw) => {
      // Guessing "they meant none" would silently stop every listing in the
      // category being asked how the item is collected, while answering as
      // though the save had worked.
      const outcome = readTransportOptions(raw);

      expect(outcome.kind).toBe('unreadable');
      if (outcome.kind === 'unreadable') {
        expect(outcome.message).toMatch(/did not reach the server/i);
      }
    },
  );

  it('refuses something that is not JSON', () => {
    const outcome = readTransportOptions('not json at all');

    expect(outcome.kind).toBe('unreadable');
    if (outcome.kind === 'unreadable') {
      expect(outcome.message).toMatch(/could not be read/i);
    }
  });

  it('refuses a requirement outside the vocabulary', () => {
    expect(
      readTransportOptions(JSON.stringify([{ requirement: 'roof_rack' }])).kind,
    ).toBe('unreadable');
  });

  it('refuses thresholds that do not increase, naming the options', () => {
    const outcome = readTransportOptions(
      JSON.stringify([
        { requirement: 'car_boot', suggestedUpToKg: 50 },
        { requirement: 'van_required', suggestedUpToKg: 20 },
      ]),
    );

    expect(outcome.kind).toBe('unreadable');
    if (outcome.kind === 'unreadable') {
      // The administrator reads this in a form, so it names the options the way
      // they appear on screen rather than by their stored values.
      expect(outcome.message).toContain('Van or large vehicle');
    }
  });

  it('normalises the order, so the action sends what the API would store', () => {
    const outcome = readTransportOptions(
      JSON.stringify([{ requirement: 'van_required' }, { requirement: 'car_boot' }]),
    );

    expect(outcome).toEqual({
      kind: 'read',
      options: [{ requirement: 'car_boot' }, { requirement: 'van_required' }],
    });
  });

  it('refuses a JSON object where an array belongs', () => {
    expect(readTransportOptions(JSON.stringify({ requirement: 'car_boot' })).kind).toBe(
      'unreadable',
    );
  });
});
