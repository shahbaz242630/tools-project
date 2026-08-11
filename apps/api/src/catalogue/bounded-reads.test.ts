import { beforeEach, describe, expect, it } from 'vitest';
import { UNPRICED_RATE_CARD } from '@platform/contracts';
import {
  CATEGORY_LIST_LIMIT,
  EXPORTED_LISTING_LIMIT,
  OWNED_LISTING_LIMIT,
} from './limits.js';
import { createCatalogueFakes, createListingFakes } from './testing/fakes.js';
import type { CatalogueFakes, ListingFakes } from './testing/fakes.js';

/**
 * Slice H2 — every list read in this module is bounded, and no bound is silent.
 *
 * Kept in one file rather than split across `catalogue.service.test.ts` and the
 * listings tests, because it is **one rule applied to four reads** and the rule
 * is what a later reader needs to see. Split up, each half looks like a local
 * quirk of the method it sits beside, and the read added in slice 2.9 would
 * arrive without one.
 *
 * The two kinds of bound are deliberately tested differently, because ADR 0035
 * makes them different things: the category bound is a guardrail whose firing is
 * an operational event, so it is asserted through the log; the export bound is
 * declared to the person reading the document, so it is asserted through the
 * value returned.
 *
 * **The fourth read arrived in slice 2.9a, which is the read this file predicted
 * would "arrive without one".** It is asserted both ways — the value, because the
 * page has to tell the owner, and the log, because nobody operating the platform
 * would otherwise know a guardrail had fired.
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

/**
 * Seeded through the *store*, for the reason the categories are: the service's
 * create path validates attributes and geocodes, and this file is testing reads.
 *
 * At module scope since 2.9a, because the export and the owner's own list both
 * need it and a second copy is how the two come to seed subtly different rows.
 */
async function seedListings(
  fakes: ListingFakes,
  ownerId: string,
  count: number,
): Promise<void> {
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

describe('the listings section of a data export', () => {
  let fakes: ListingFakes;
  let categories: CatalogueFakes;

  beforeEach(async () => {
    categories = createCatalogueFakes();
    fakes = createListingFakes(categories.store);
    await seedCategories(categories, 1);
  });

  it('carries an ordinary owner’s listings whole, and declares them complete', async () => {
    await seedListings(fakes, OWNER, 3);

    const section = await fakes.service.exportFor(OWNER);

    expect(section.listings).toHaveLength(3);
    // False rather than absent. §10.1 requires a subject-access response to be
    // complete, so the document has to state that it is — a missing flag would
    // be read as "unknown", which is not an answer.
    expect(section.truncated).toBe(false);
  });

  it('declares a section of exactly the limit complete', async () => {
    await seedListings(fakes, OWNER, EXPORTED_LISTING_LIMIT);

    const section = await fakes.service.exportFor(OWNER);

    expect(section.listings).toHaveLength(EXPORTED_LISTING_LIMIT);
    expect(section.truncated).toBe(false);
  });

  it('cuts at the limit and declares the cut', async () => {
    await seedListings(fakes, OWNER, EXPORTED_LISTING_LIMIT + 1);

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
    await seedListings(fakes, OWNER, 2);
    await seedListings(fakes, OTHER_OWNER, EXPORTED_LISTING_LIMIT + 5);

    const section = await fakes.service.exportFor(OWNER);

    expect(section.listings).toHaveLength(2);
    expect(section.truncated).toBe(false);
  });
});

describe('the owner’s own list of listings', () => {
  let fakes: ListingFakes;
  let categories: CatalogueFakes;

  beforeEach(async () => {
    categories = createCatalogueFakes();
    fakes = createListingFakes(categories.store);
    await seedCategories(categories, 1);
  });

  it('serves an ordinary owner’s listings whole, and says nothing', async () => {
    await seedListings(fakes, OWNER, 3);

    const page = await fakes.service.listOwned(OWNER);

    expect(page.items).toHaveLength(3);
    expect(page.truncated).toBe(false);

    /*
     * **Ordering is deliberately not asserted here, and the reason is a trap
     * worth leaving marked.** The fake stamps `Time.nowUtc()` per row, so three
     * rows seeded in a loop share a millisecond; its sort then compares equal and
     * a stable sort hands back insertion order. An assertion that the newest came
     * first would therefore pass or fail on how fast the machine is, and — worse —
     * would have *failed* here while the production query was perfectly correct.
     *
     * Newest-first is the store's guarantee and is pinned where it is actually
     * observable: `prisma-listing-store.db.test.ts` proves it against Postgres,
     * with `take` applied after `orderBy`. This method adds no ordering of its
     * own; it bounds and reports.
     */

    // A guardrail this far above real use must not log on an ordinary page load.
    expect(fakes.logger.at('warn')).toHaveLength(0);
  });

  it('serves exactly the limit whole, and still says nothing', async () => {
    // The case the probe exists for, one read along: two hundred rows came back
    // from a query for two hundred and one, so there is no two hundred and
    // first. Claiming truncation here would send somebody looking for a listing
    // they do not have.
    await seedListings(fakes, OWNER, OWNED_LISTING_LIMIT);

    const page = await fakes.service.listOwned(OWNER);

    expect(page.items).toHaveLength(OWNED_LISTING_LIMIT);
    expect(page.truncated).toBe(false);
    expect(fakes.logger.at('warn')).toHaveLength(0);
  });

  it('cuts at the limit, tells the owner, and tells the log', async () => {
    await seedListings(fakes, OWNER, OWNED_LISTING_LIMIT + 1);

    const page = await fakes.service.listOwned(OWNER);

    expect(page.items).toHaveLength(OWNED_LISTING_LIMIT);
    // **Both halves, unlike the two reads above which assert one each.** The
    // value is what lets the page say so — a list that quietly stops is one
    // somebody reads as their whole record — and the log is what lets anybody
    // running the platform know a bound meant for nobody has started catching
    // somebody.
    expect(page.truncated).toBe(true);

    const warnings = fakes.logger.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('owned listing list truncated');
    expect(warnings[0]?.fields).toMatchObject({
      limit: OWNED_LISTING_LIMIT,
      surface: 'owner-dashboard',
    });
  });

  it('never shows one owner another owner’s listings', async () => {
    await seedListings(fakes, OWNER, 2);
    await seedListings(fakes, OTHER_OWNER, 3);

    const page = await fakes.service.listOwned(OWNER);

    // The isolation clause, at the read this page is built on. It is asserted in
    // the integration tests against a real database too; here it also proves the
    // bound is applied inside the owner-scoped query rather than to the table,
    // which is what stops a busy platform truncating everybody at once.
    expect(page.items).toHaveLength(2);
    expect(page.items.every((listing) => listing.ownerId === OWNER)).toBe(true);
  });

  it('gives somebody with no listings an empty page rather than a truncated one', async () => {
    const page = await fakes.service.listOwned(OWNER);

    expect(page.items).toHaveLength(0);
    // False, not absent. The page distinguishes "you have listed nothing" from
    // "we could not show you everything", and both would be wrong if this were
    // ever undefined.
    expect(page.truncated).toBe(false);
  });
});
