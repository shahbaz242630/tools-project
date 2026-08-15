import { describe, expect, it } from 'vitest';
import { namesAnUnknownCategory } from './search-category';

const KNOWN = [
  { slug: 'outdoor-gardening', name: 'Outdoor and gardening' },
  { slug: 'power-tools', name: 'Power tools' },
];

describe('a search naming a category we do not have', () => {
  it('is caught when the list is known and does not contain it', () => {
    expect(namesAnUnknownCategory('no-such-category', KNOWN)).toBe(true);
  });

  it('is not caught when the category is one we have', () => {
    expect(namesAnUnknownCategory('power-tools', KNOWN)).toBe(false);
  });

  it('is not caught when no category was asked for', () => {
    expect(namesAnUnknownCategory(null, KNOWN)).toBe(false);
    expect(namesAnUnknownCategory(null, [])).toBe(false);
  });

  /*
   * **The condition this module exists to get right.** An empty list is not
   * "there are no categories" — `/browse` collapses a *failed* category read to
   * an empty list so that a searcher can still search. Refusing a filtered
   * search on the strength of a lookup that failed would turn a cosmetic outage
   * into a broken feature: the filter is still valid, the API still applies it,
   * and only the control could not be drawn.
   */
  it('says nothing when the category list could not be read', () => {
    expect(namesAnUnknownCategory('power-tools', [])).toBe(false);
    expect(namesAnUnknownCategory('no-such-category', [])).toBe(false);
  });

  /*
   * Matched on the slug, which is the stable identity — never on the display
   * name, which an administrator renames and which is not what a URL carries.
   */
  it('matches on the slug rather than the name', () => {
    expect(namesAnUnknownCategory('Power tools', KNOWN)).toBe(true);
    expect(namesAnUnknownCategory('power-tools', KNOWN)).toBe(false);
  });
});
