import { describe, expect, it } from 'vitest';
import type { CategoryAttribute } from './catalogue.js';
import type { CategoryTransportOption } from './transport.js';
import {
  isPublishable,
  parsePublicationRefusal,
  publicationBlockers,
} from './publication.js';
import type { PublicationCandidate } from './publication.js';

const SCHEMA: readonly CategoryAttribute[] = [
  {
    key: 'power_source',
    label: 'Power source',
    required: true,
    type: 'choice',
    options: [
      { value: 'petrol', label: 'Petrol' },
      { value: 'cordless', label: 'Cordless' },
    ],
  },
  {
    key: 'weight_kg',
    label: 'Weight',
    required: true,
    type: 'number',
    unit: 'kg',
    decimalPlaces: 1,
  },
  {
    key: 'notes',
    label: 'Condition notes',
    required: false,
    type: 'text',
    maxLength: 200,
  },
  {
    key: 'accessories',
    label: 'Accessories',
    required: true,
    type: 'choice-many',
    options: [
      { value: 'bag', label: 'Collection bag' },
      { value: 'blade', label: 'Spare blade' },
    ],
  },
];

const TRANSPORT: readonly CategoryTransportOption[] = [
  { requirement: 'car_boot', suggestedUpToKg: 25 },
  { requirement: 'van_required', suggestedUpToKg: 150 },
];

/** A listing with nothing wrong with it. */
const complete: PublicationCandidate = {
  description: 'Serviced last spring. Blade recently sharpened.',
  attributes: { power_source: 'petrol', weight_kg: 52, accessories: ['bag'] },
  categoryAttributes: SCHEMA,
  categoryTransportOptions: TRANSPORT,
  transportRequirement: 'car_boot',
  rates: { daily: { amount: 1_800, currency: 'GBP' }, weekend: null, weekly: null },
  hasCollectionLocation: true,
  isLocated: true,
};

const fields = (listing: PublicationCandidate) =>
  publicationBlockers(listing).map((blocker) => blocker.field);

describe('a complete listing', () => {
  it('has nothing blocking it', () => {
    expect(publicationBlockers(complete)).toEqual([]);
    expect(isPublishable(complete)).toBe(true);
  });

  it('does not require the optional attributes', () => {
    // `notes` is not required and is unanswered — the whole point of the flag.
    expect(complete.attributes['notes']).toBeUndefined();
    expect(isPublishable(complete)).toBe(true);
  });
});

describe('the description', () => {
  it('is required', () => {
    expect(fields({ ...complete, description: '' })).toEqual(['description']);
  });

  it('is not satisfied by whitespace', () => {
    expect(fields({ ...complete, description: '   \n  ' })).toEqual(['description']);
  });
});

describe('required attributes', () => {
  it('blocks an unanswered one, naming its label rather than its key', () => {
    const blockers = publicationBlockers({
      ...complete,
      attributes: { weight_kg: 52, accessories: ['bag'] },
    });

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.field).toBe('attributes.power_source');
    // The label, because the key is deliberately internal (ADR 0027).
    expect(blockers[0]?.message).toContain('Power source');
    expect(blockers[0]?.message).not.toContain('power_source');
  });

  it('blocks an empty string, which is not an answer', () => {
    expect(
      fields({
        ...complete,
        categoryAttributes: [
          {
            key: 'notes',
            label: 'Condition notes',
            required: true,
            type: 'text',
            maxLength: 200,
          },
        ],
        attributes: { notes: '' },
      }),
    ).toEqual(['attributes.notes']);
  });

  it('blocks an empty multi-select, which is also not an answer', () => {
    expect(
      fields({ ...complete, attributes: { ...complete.attributes, accessories: [] } }),
    ).toEqual(['attributes.accessories']);
  });

  it('accepts zero, which is a real answer to a number', () => {
    expect(
      isPublishable({
        ...complete,
        categoryAttributes: [
          {
            key: 'weight_kg',
            label: 'Weight',
            required: true,
            type: 'number',
            unit: 'kg',
            decimalPlaces: 1,
          },
        ],
        attributes: { weight_kg: 0 },
      }),
    ).toBe(true);
  });

  /**
   * ADR 0029, and the reason `categoryAttributes` is on the candidate at all.
   * The schema read is the one the listing pinned; a requirement added to the
   * category last week was never asked of this listing.
   */
  it('reads the pinned schema, not whatever the category asks now', () => {
    const pinnedAskedForLess: PublicationCandidate = {
      ...complete,
      categoryAttributes: [
        {
          key: 'notes',
          label: 'Condition notes',
          required: false,
          type: 'text',
          maxLength: 200,
        },
      ],
      attributes: {},
    };

    // Nothing required on the pinned version, so nothing blocks — even though
    // the fixture's other schema demands three answers.
    expect(isPublishable(pinnedAskedForLess)).toBe(true);
  });
});

describe('the transport requirement', () => {
  /**
   * The question slice 2.4c-i deferred. A category offering nothing means the
   * listing *cannot* say how the item is collected, so requiring it would make
   * every listing in that category permanently unpublishable.
   */
  it('is not required when the category offers no options', () => {
    expect(
      isPublishable({
        ...complete,
        categoryTransportOptions: [],
        transportRequirement: null,
      }),
    ).toBe(true);
  });

  it('is required when the category offers options', () => {
    expect(fields({ ...complete, transportRequirement: null })).toEqual([
      'transportRequirement',
    ]);
  });
});

describe('the price', () => {
  it('blocks a listing with no daily rate', () => {
    expect(
      fields({ ...complete, rates: { daily: null, weekend: null, weekly: null } }),
    ).toEqual(['rates.daily']);
  });
});

describe('the location', () => {
  /**
   * 2.5b's rule. Published without coordinates, the listing is one no search can
   * ever return — worse than absent, because the owner believes it is live.
   */
  it('blocks an address that could not be placed on a map', () => {
    const blockers = publicationBlockers({ ...complete, isLocated: false });

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.field).toBe('collectionLocation');
    // Says what happened and what to do, not "no coordinates".
    expect(blockers[0]?.message).toMatch(/postcode/i);
  });

  /**
   * **Two failures, two messages**, found by pressing the button: a listing with
   * no address at all was being told *"we could not place this address on a
   * map"*, describing a geocoding attempt that never happened. An owner can act
   * on "answer the question" and cannot act on that.
   */
  it('blocks a listing with no address, and says so differently', () => {
    const blockers = publicationBlockers({
      ...complete,
      hasCollectionLocation: false,
      isLocated: false,
    });

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.field).toBe('collectionLocation');
    expect(blockers[0]?.message).toMatch(/collected from/i);
    // Emphatically not the geocoding message: there was no address to place.
    expect(blockers[0]?.message).not.toMatch(/postcode/i);
    expect(blockers[0]?.message).not.toMatch(/could not place/i);
  });

  it('reports one location problem, never two', () => {
    // `hasCollectionLocation: false` implies `isLocated: false`, and an owner
    // told both would be reading one problem described two ways.
    expect(
      publicationBlockers({
        ...complete,
        hasCollectionLocation: false,
        isLocated: false,
      }),
    ).toHaveLength(1);
  });
});

describe('reporting more than one problem', () => {
  /**
   * Every reason at once, not the first. An owner fixing four things across four
   * round trips is the small insult that makes people abandon a form.
   */
  it('names every unmet requirement', () => {
    expect(
      fields({
        description: '',
        attributes: {},
        categoryAttributes: SCHEMA,
        categoryTransportOptions: TRANSPORT,
        transportRequirement: null,
        rates: { daily: null, weekend: null, weekly: null },
        hasCollectionLocation: false,
        isLocated: false,
      }),
    ).toEqual([
      'description',
      'attributes.power_source',
      'attributes.weight_kg',
      'attributes.accessories',
      'transportRequirement',
      'rates.daily',
      'collectionLocation',
    ]);
  });

  it('orders them as the form does, so the list reads top to bottom', () => {
    const order = fields({
      ...complete,
      description: '',
      rates: { daily: null, weekend: null, weekly: null },
      isLocated: false,
    });

    expect(order).toEqual(['description', 'rates.daily', 'collectionLocation']);
  });

  it('gives every blocker a sentence that names its own subject', () => {
    for (const blocker of publicationBlockers({
      description: '',
      attributes: {},
      categoryAttributes: SCHEMA,
      categoryTransportOptions: TRANSPORT,
      transportRequirement: null,
      rates: { daily: null, weekend: null, weekly: null },
      hasCollectionLocation: false,
      isLocated: false,
    })) {
      // The convention `contract-issues.ts` enforces: a sentence stands alone.
      expect(blocker.message).toMatch(/^[A-Z]/);
      expect(blocker.message).toMatch(/\.$/);
    }
  });
});

describe('parsePublicationRefusal', () => {
  it('reads a refusal body', () => {
    const refusal = parsePublicationRefusal({
      message: 'This listing is not ready to be published yet.',
      blockers: [{ field: 'rates.daily', message: 'A daily rate is needed.' }],
    });

    expect(refusal.message).toMatch(/not ready/i);
    expect(refusal.blockers).toEqual([
      { field: 'rates.daily', message: 'A daily rate is needed.' },
    ]);
  });

  it('reads a refusal with no blockers, which should not happen but is well formed', () => {
    expect(
      parsePublicationRefusal({ message: 'Not ready.', blockers: [] }).blockers,
    ).toEqual([]);
  });

  it('refuses a body that is not a refusal', () => {
    // The caller decides what an unreadable body means — the web client shows a
    // generic blocker rather than crashing — but it has to be told.
    expect(() => parsePublicationRefusal({ message: 'Not ready.' })).toThrow();
    expect(() => parsePublicationRefusal({ blockers: [] })).toThrow();
    expect(() => parsePublicationRefusal('not ready')).toThrow();
  });

  it('refuses a blocker missing its message', () => {
    expect(() =>
      parsePublicationRefusal({ message: 'Not ready.', blockers: [{ field: 'x' }] }),
    ).toThrow();
  });
});
