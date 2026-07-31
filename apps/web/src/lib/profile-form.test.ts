import { describe, expect, it } from 'vitest';
import { readProfileForm } from './profile-form';

/** A stand-in for FormData — the real thing sends `""` for every untouched box. */
function form(values: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => values[name] ?? null };
}

const complete = {
  displayName: 'Sarah M.',
  phone: '07700 900123',
  line1: '12 Acacia Avenue',
  line2: 'Flat 3',
  town: 'Bristol',
  postcode: 'bs7 8aa',
};

describe('readProfileForm', () => {
  it('reads a complete form and normalises it', () => {
    const result = readProfileForm(form(complete));

    expect(result).toEqual({
      kind: 'ok',
      input: {
        displayName: 'Sarah M.',
        phone: '+447700900123',
        address: {
          line1: '12 Acacia Avenue',
          line2: 'Flat 3',
          town: 'Bristol',
          postcode: 'BS7 8AA',
        },
      },
    });
  });

  it('treats an untouched optional box as absent, not as an empty string', () => {
    // The mapping this function exists for. HTML forms have no null, so `""`
    // reaching the API as a phone number would fail validation for a field the
    // person deliberately left alone.
    const result = readProfileForm(
      form({
        displayName: 'Sarah M.',
        phone: '',
        line1: '',
        line2: '',
        town: '',
        postcode: '',
      }),
    );

    expect(result).toEqual({
      kind: 'ok',
      input: { displayName: 'Sarah M.', phone: null, address: null },
    });
  });

  it('treats an entirely blank address as no address', () => {
    const result = readProfileForm(form({ displayName: 'Sarah M.' }));
    expect(result).toMatchObject({ kind: 'ok', input: { address: null } });
  });

  it('keeps an optional second address line as null when blank', () => {
    const result = readProfileForm(form({ ...complete, line2: '  ' }));
    expect(result).toMatchObject({ kind: 'ok', input: { address: { line2: null } } });
  });

  it('reports what is missing when an address is half-filled', () => {
    // Somebody who typed a postcode and stopped has started entering an
    // address, and should be told what is missing rather than silently having
    // the whole thing dropped.
    const result = readProfileForm(
      form({ displayName: 'Sarah M.', postcode: 'BS7 8AA', line1: '', town: '' }),
    );

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.issues.join('\n')).toContain('line1');
    expect(result.issues.join('\n')).toContain('town');
  });

  it('rejects a display name that is only whitespace', () => {
    const result = readProfileForm(form({ ...complete, displayName: '   ' }));
    expect(result.kind).toBe('invalid');
  });

  it('rejects a postcode that is not a UK postcode', () => {
    const result = readProfileForm(form({ ...complete, postcode: '90210' }));

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.issues.join('\n')).toContain('postcode');
  });

  it('rejects a non-UK phone number', () => {
    const result = readProfileForm(form({ ...complete, phone: '+1 555 0100' }));
    expect(result.kind).toBe('invalid');
  });

  it('names every problem at once', () => {
    // A form that reveals one error per submission is a form people abandon.
    const result = readProfileForm(
      form({
        displayName: 'x',
        phone: 'nope',
        postcode: '90210',
        line1: 'a',
        town: 'b',
      }),
    );

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });

  it('trims what it keeps', () => {
    const result = readProfileForm(form({ ...complete, displayName: '  Sarah M.  ' }));
    expect(result).toMatchObject({ kind: 'ok', input: { displayName: 'Sarah M.' } });
  });
});
