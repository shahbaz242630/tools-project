import { describe, expect, it } from 'vitest';
import { asSentence, asSentences } from './contract-issues';

describe('asSentence', () => {
  /**
   * The case the `field: message` shape was built for and still serves: the
   * path is the field's own name on the form.
   */
  it('prefixes a fragment with its field', () => {
    expect(
      asSentence({ path: ['slug'], message: 'must be at least 2 characters' }),
    ).toBe('slug: must be at least 2 characters');
    expect(asSentence({ path: ['line1'], message: 'is required' })).toBe(
      'line1: is required',
    );
  });

  /**
   * The defect this module exists to retire, found four times on four different
   * fields. A nested path is internal structure; the message has to name its
   * own subject, and then the path would name it twice.
   */
  it('shows a sentence alone, because it already names its subject', () => {
    expect(
      asSentence({
        path: ['rates', 'daily'],
        message: 'A daily rate is needed before a weekend or weekly rate',
      }),
    ).toBe('A daily rate is needed before a weekend or weekly rate');

    expect(
      asSentence({
        path: ['feePolicy', 'minimumPlatformFee', 'amount'],
        message:
          'The minimum platform fee cannot be more than the minimum booking total',
      }),
    ).toBe('The minimum platform fee cannot be more than the minimum booking total');
  });

  it('shows a top-level sentence alone too', () => {
    // The rule is about the message, not about the depth — a self-naming
    // message at the top level does not need its field either.
    expect(
      asSentence({
        path: ['reportingDutiesAcknowledged'],
        message: 'Confirm that counsel has looked at this',
      }),
    ).toBe('Confirm that counsel has looked at this');
  });

  it('shows a pathless issue as itself', () => {
    expect(asSentence({ path: [], message: 'The body could not be read' })).toBe(
      'The body could not be read',
    );
  });

  it('joins a numeric path segment, for an array index', () => {
    expect(asSentence({ path: ['attributes', 0, 'key'], message: 'is required' })).toBe(
      'attributes.0.key: is required',
    );
  });
});

describe('asSentences', () => {
  it('joins several issues', () => {
    expect(
      asSentences([
        { path: ['title'], message: 'is required' },
        { path: ['rates', 'daily'], message: 'A daily rate is needed' },
      ]),
    ).toBe('title: is required; A daily rate is needed');
  });

  it('is empty for no issues', () => {
    expect(asSentences([])).toBe('');
  });
});
