import { describe, expect, it } from 'vitest';
import { ContractViolationError } from './parse.js';
import {
  LISTING_DESCRIPTION_MAX_LENGTH,
  LISTING_TITLE_MAX_LENGTH,
  MAX_REPLACEMENT_VALUE_MINOR,
  MIN_REPLACEMENT_VALUE_MINOR,
  parseListingDraft,
} from './listings.js';

const validDraft = {
  categorySlug: 'outdoor-gardening',
  title: 'Petrol hedge trimmer',
  description: 'Serviced last spring. Blade recently sharpened.',
  replacementValue: { amount: 24_999, currency: 'GBP' },
};

function issuesOf(read: () => unknown): readonly string[] {
  try {
    read();
  } catch (error) {
    if (error instanceof ContractViolationError) return error.issues;
    throw error;
  }
  throw new Error('Expected the contract to reject this, and it did not');
}

describe('the listing draft', () => {
  it('accepts a complete draft', () => {
    expect(parseListingDraft(validDraft).title).toBe('Petrol hedge trimmer');
  });

  it('does not let the caller choose the category version', () => {
    // The server pins whichever version is current when the row is written. A
    // client-chosen version would let a form left open overnight pin
    // configuration that was replaced while it sat there — the one thing the
    // pin exists to prevent. Zod strips unknown keys, so this asserts the
    // stripping rather than a rejection.
    const parsed = parseListingDraft({ ...validDraft, categoryVersionId: 'anything' });

    expect(parsed).not.toHaveProperty('categoryVersionId');
  });

  it('has no status field, because a draft is the only thing this creates', () => {
    const parsed = parseListingDraft({ ...validDraft, status: 'PUBLISHED' });

    expect(parsed).not.toHaveProperty('status');
  });
});

describe('the title', () => {
  it('trims before measuring length', () => {
    expect(parseListingDraft({ ...validDraft, title: '  Mower  ' }).title).toBe(
      'Mower',
    );
  });

  it('rejects one too short to say anything', () => {
    expect(() => parseListingDraft({ ...validDraft, title: 'ab' })).toThrow(
      ContractViolationError,
    );
  });

  it('rejects one past the limit', () => {
    expect(() =>
      parseListingDraft({
        ...validDraft,
        title: 'x'.repeat(LISTING_TITLE_MAX_LENGTH + 1),
      }),
    ).toThrow(ContractViolationError);
  });

  it('rejects a direction-changing character', () => {
    // U+202E reverses the rendering of everything after it, which is how a
    // title is made to read as something it is not.
    expect(() => parseListingDraft({ ...validDraft, title: 'Mower ‮gnittuc' })).toThrow(
      ContractViolationError,
    );
  });

  it('rejects a newline, because a title is one line', () => {
    expect(() => parseListingDraft({ ...validDraft, title: 'Mower\nCheap' })).toThrow(
      ContractViolationError,
    );
  });

  it('accepts a name that is not ASCII', () => {
    expect(parseListingDraft({ ...validDraft, title: 'Motosierra — 40cm' }).title).toBe(
      'Motosierra — 40cm',
    );
  });
});

describe('the description', () => {
  it('is required to be present', () => {
    // ADR 0025: an absent field is a silent default, and the silent default
    // here would quietly blank what somebody wrote.
    const withoutDescription = Object.fromEntries(
      Object.entries(validDraft).filter(([key]) => key !== 'description'),
    );

    expect(() => parseListingDraft(withoutDescription)).toThrow(ContractViolationError);
  });

  it('is allowed to be empty, because a draft holds progress', () => {
    // §8.3: "owners create draft listings and save progress". Requiring prose
    // before a draft can be saved is what makes people abandon the form.
    // Publication is where completeness is enforced (2.8).
    expect(parseListingDraft({ ...validDraft, description: '' }).description).toBe('');
  });

  it('allows newlines, because it is a paragraph field', () => {
    const description = 'Serviced last spring.\n\nCollection from the driveway.';

    expect(parseListingDraft({ ...validDraft, description }).description).toBe(
      description,
    );
  });

  it('still rejects a direction-changing character', () => {
    expect(() =>
      parseListingDraft({ ...validDraft, description: 'Good condition ‮' }),
    ).toThrow(ContractViolationError);
  });

  it('rejects a control character that is not a line break', () => {
    expect(() =>
      parseListingDraft({ ...validDraft, description: 'Goodcondition' }),
    ).toThrow(ContractViolationError);
  });

  it('rejects one past the limit', () => {
    expect(() =>
      parseListingDraft({
        ...validDraft,
        description: 'x'.repeat(LISTING_DESCRIPTION_MAX_LENGTH + 1),
      }),
    ).toThrow(ContractViolationError);
  });
});

describe('the replacement value', () => {
  it('is money, not a number', () => {
    // The currency travels with the amount. A bare number is ambiguous the day
    // a second currency exists, with no way to tell which rows were which.
    expect(() =>
      parseListingDraft({ ...validDraft, replacementValue: 24_999 }),
    ).toThrow(ContractViolationError);
  });

  it('rejects fractional pence', () => {
    // What a caller sending pounds where pence were meant looks like. Without
    // this it would be rounded somewhere downstream and found by a ledger that
    // stopped balancing.
    expect(
      issuesOf(() =>
        parseListingDraft({
          ...validDraft,
          replacementValue: { amount: 10.5, currency: 'GBP' },
        }),
      ).join(' '),
    ).toMatch(/whole number of pence/i);
  });

  it('rejects a currency the platform cannot do arithmetic in', () => {
    expect(() =>
      parseListingDraft({
        ...validDraft,
        replacementValue: { amount: 24_999, currency: 'EUR' },
      }),
    ).toThrow(ContractViolationError);
  });

  it('rejects a value below the floor, naming pounds rather than pence', () => {
    // The message is read by an owner in a form. "must be at least 100" would
    // be telling them about a unit they never typed.
    expect(
      issuesOf(() =>
        parseListingDraft({
          ...validDraft,
          replacementValue: {
            amount: MIN_REPLACEMENT_VALUE_MINOR - 1,
            currency: 'GBP',
          },
        }),
      ).join(' '),
    ).toContain('£1');
  });

  it('rejects a value above the ceiling', () => {
    expect(
      issuesOf(() =>
        parseListingDraft({
          ...validDraft,
          replacementValue: {
            amount: MAX_REPLACEMENT_VALUE_MINOR + 1,
            currency: 'GBP',
          },
        }),
      ).join(' '),
    ).toContain('£100,000');
  });

  it('accepts both bounds exactly', () => {
    for (const amount of [MIN_REPLACEMENT_VALUE_MINOR, MAX_REPLACEMENT_VALUE_MINOR]) {
      expect(
        parseListingDraft({
          ...validDraft,
          replacementValue: { amount, currency: 'GBP' },
        }).replacementValue.amount,
      ).toBe(amount);
    }
  });

  it('rejects a negative value', () => {
    // Negative money is legitimate in the ledger and meaningless here — an item
    // cannot cost less than nothing to replace.
    expect(() =>
      parseListingDraft({
        ...validDraft,
        replacementValue: { amount: -24_999, currency: 'GBP' },
      }),
    ).toThrow(ContractViolationError);
  });
});
