import { beforeEach, describe, expect, it } from 'vitest';
import { UNPRICED_RATE_CARD } from '@platform/contracts';
import { CATEGORY_LIST_LIMIT, EXPORTED_LISTING_LIMIT } from './limits.js';
import { createCatalogueFakes, createListingFakes } from './testing/fakes.js';
import type { CatalogueFakes, ListingFakes } from './testing/fakes.js';

/**
 * Slice H2 — every list read in this module is bounded, and no bound is silent.
 *
 * Kept in one file rather than split across `catalogue.service.test.ts` and the
 * listings tests, because it is **one rule applied to three reads** and the rule
 * is what a later reader needs to see. Split up, each half looks like a local
 * quirk of the method it sits beside, and the third read added in slice 2.9
 * would arrive without one.
 *
 * The two kinds of bound are deliberately tested differently, because ADR 0035
 * makes them different things: the category bound is a guardrail whose firing is
 * an operational event, so it is asserted through the log; the export bound is
 * declared to the person reading the document, so it is asserted through the
 * value returned.
 */

const FEE_POLICY = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' },
  minimumPlatformFee: { amount: 100, currency: 'GBP' },
} as const;

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const OTHER_OWNER = '00000000-0000-4000-8000-0000000000bb';

/**
 * Seeded through the *store* rather than the service.
 *
 * The service's create path validates attributes and geocodes an address, and
 * five hundred round trips through it would be testing that instead. What is
 * under test here is the read.
 */
async function seedCategories(fakes: CatalogueFakes, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await fakes.store.create(
      {
        slug: `category-${String(index).padStart(4, '0')}`,
        name: `Category ${String(index)}`,
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        transportOptions: [],
        feePolicy: FEE_POLICY,
      },
      OWNER,
    );
  }
}

describe('the category list, on the admin surface', () => {
  let fakes: CatalogueFakes;

  beforeEach(() => {
    fakes = createCatalogueFakes();
  });

  it('serves an ordinary catalogue whole, and says nothing', async () => {
    await seedCategories(fakes, 3);

    expect(await fakes.service.list()).toHaveLength(3);
    // The guardrail is not a page control. A log line every time somebody opens
    // the admin page is a log nobody reads.
    expect(fakes.logger.at('warn')).toHaveLength(0);
  });

  it('serves exactly the limit whole, and still says nothing', async () => {
    // The case the probe exists for. Five hundred rows came back from a query
    // that asked for five hundred and one, so there is no five hundred and
    // first — reporting truncation here would claim a category that does not
    // exist, and send somebody looking for it.
    await seedCategories(fakes, CATEGORY_LIST_LIMIT);

    expect(await fakes.service.list()).toHaveLength(CATEGORY_LIST_LIMIT);
    expect(fakes.logger.at('warn')).toHaveLength(0);
  });

  it('cuts the list at the limit and reports that it did', async () => {
    await seedCategories(fakes, CATEGORY_LIST_LIMIT + 1);

    const listed = await fakes.service.list();

    expect(listed).toHaveLength(CATEGORY_LIST_LIMIT);
    // Oldest first is preserved, so what was dropped is the newest — and the
    // slug proves the cut happened at the store's ordering rather than after a
    // re-sort.
    expect(listed[0]?.slug).toBe('category-0000');
    expect(listed.at(-1)?.slug).toBe(
      `category-${String(CATEGORY_LIST_LIMIT - 1).padStart(4, '0')}`,
    );

    // The half that matters. Bounding the query without this would make a
    // catalogue that is too large indistinguishable from one that is complete,
    // and nothing anywhere would know.
    const warnings = fakes.logger.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('category list truncated');
    expect(warnings[0]?.fields).toMatchObject({
      limit: CATEGORY_LIST_LIMIT,
      surface: 'admin',
    });
  });
});

describe('the category picker, on the listing form', () => {
  let fakes: ListingFakes;
  let categories: CatalogueFakes;

  beforeEach(() => {
    categories = createCatalogueFakes();
    fakes = createListingFakes(categories.store);
  });

  it('offers an ordinary catalogue whole, and says nothing', async () => {
    await seedCategories(categories, 3);

    expect(await fakes.service.categoryOptions()).toHaveLength(3);
    expect(fakes.logger.at('warn')).toHaveLength(0);
  });

  it('cuts the picker at the limit and reports it as its own surface', async () => {
    await seedCategories(categories, CATEGORY_LIST_LIMIT + 1);

    expect(await fakes.service.categoryOptions()).toHaveLength(CATEGORY_LIST_LIMIT);

    // Reported separately from the admin list rather than through one shared
    // call site, because the consequence is worse: a category missing from this
    // list is one **nobody can list an item in**, on a form that looks entirely
    // normal.
    const warnings = fakes.logger.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({
      limit: CATEGORY_LIST_LIMIT,
      surface: 'owner-picker',
    });
  });
});

describe('the listings section of a data export', () => {
  let fakes: ListingFakes;
  let categories: CatalogueFakes;

  beforeEach(async () => {
    categories = createCatalogueFakes();
    fakes = createListingFakes(categories.store);
    await seedCategories(categories, 1);
  });

  async function seedListings(ownerId: string, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await fakes.listings.createDraft({
        ownerId,
        categorySlug: 'category-0000',
        title: `Listing ${String(index)}`,
        description: '',
        replacementValue: { amount: 10_000, currency: 'GBP' },
        attributes: {},
        transportRequirement: null,
        requiresTwoPersonLift: false,
        rates: UNPRICED_RATE_CARD,
        collectionLocation: null,
        locatedPoint: null,
        categoryVersionNumber: 1,
      });
    }
  }

  it('carries an ordinary owner’s listings whole, and declares them complete', async () => {
    await seedListings(OWNER, 3);

    const section = await fakes.service.exportFor(OWNER);

    expect(section.listings).toHaveLength(3);
    // False rather than absent. §10.1 requires a subject-access response to be
    // complete, so the document has to state that it is — a missing flag would
    // be read as "unknown", which is not an answer.
    expect(section.truncated).toBe(false);
  });

  it('declares a section of exactly the limit complete', async () => {
    await seedListings(OWNER, EXPORTED_LISTING_LIMIT);

    const section = await fakes.service.exportFor(OWNER);

    expect(section.listings).toHaveLength(EXPORTED_LISTING_LIMIT);
    expect(section.truncated).toBe(false);
  });

  it('cuts at the limit and declares the cut', async () => {
    await seedListings(OWNER, EXPORTED_LISTING_LIMIT + 1);

    const section = await fakes.service.exportFor(OWNER);

    expect(section.listings).toHaveLength(EXPORTED_LISTING_LIMIT);
    // The whole reason the bound was allowed to exist. A `take` with no flag
    // beside it would answer a UK GDPR Article 15 request with a partial file
    // that reads exactly like a complete one.
    expect(section.truncated).toBe(true);
  });

  it('bounds one owner without counting another’s listings', async () => {
    // The bound is applied inside the owner-scoped query, not to the table. If
    // it were not, a platform with many owners would truncate everybody's export
    // as soon as the *table* passed the limit.
    await seedListings(OWNER, 2);
    await seedListings(OTHER_OWNER, EXPORTED_LISTING_LIMIT + 5);

    const section = await fakes.service.exportFor(OWNER);

    expect(section.listings).toHaveLength(2);
    expect(section.truncated).toBe(false);
  });
});
