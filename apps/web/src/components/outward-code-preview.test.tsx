import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OutwardCodePreview } from './outward-code-preview';

/**
 * **Every case here failed against the sentence this replaced**, which had `BS7`
 * written into the markup of both listing forms. Session 43 typed `BS1 5TR` into
 * the real form and was told "Only the first part — BS7 — is ever published".
 * The row that was saved carried `BS1`, so nothing was ever published wrongly —
 * only the promise about it was false, and a promise about privacy is the one a
 * reader cannot check for themselves.
 */
describe('the outward code preview', () => {
  it('names the district that was actually typed', () => {
    render(<OutwardCodePreview postcode="BS1 5TR" />);

    expect(document.body.textContent).toContain('BS1');
    // The specific defect: somebody else's district must never appear.
    expect(document.body.textContent).not.toContain('BS7');
  });

  it('never shows the half that stays private', () => {
    render(<OutwardCodePreview postcode="BS7 8AA" />);

    expect(document.body.textContent).toContain('BS7');
    expect(document.body.textContent).not.toContain('8AA');
  });

  it('explains the rule before anything is typed', () => {
    render(<OutwardCodePreview postcode="" />);
    expect(document.body.textContent).toContain('the bit before the space');
  });

  it.each([
    ['half-typed', 'SW1'],
    ['nonsense', 'not a postcode'],
    ['only whitespace', '   '],
  ])('falls back to the rule for %s rather than erroring', (_case, typed) => {
    // `Postcode.outwardCode` throws on anything it does not recognise, and "SW1"
    // on the way to "SW11 4AB" is not a mistake worth interrupting somebody for.
    render(<OutwardCodePreview postcode={typed} />);
    expect(document.body.textContent).toContain('the bit before the space');
  });

  it('keeps saying "published", not "shown"', () => {
    /*
     * The profile has its own `DistrictPreview` saying "shown publicly". The two
     * are deliberately separate: a listing is *published*, and merging them
     * would quietly drop a distinction somebody chose.
     */
    render(<OutwardCodePreview postcode="M1 4BT" />);
    expect(document.body.textContent).toContain('published');
  });
});
