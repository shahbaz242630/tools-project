/**
 * The listing adapter against a real database.
 *
 * Needs `pnpm db:up` and migrations applied to the test database:
 *   pnpm db:up && pnpm db:migrate:test
 *
 * The tests worth having here are the ones a double cannot fake: the composite
 * foreign key that makes a listing's category and its pinned version agree, the
 * RESTRICT that stops an owner disappearing, and what Postgres does with an
 * integer amount. Everything else about this store is covered by the integration
 * tests.
 */

import { randomUUID } from 'node:crypto';
import { buildPostgresUrl, loadEnv } from '@platform/config';
import { createPrismaClient } from '@platform/database';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  CategoryAttribute,
  ListingAttributeValues,
  ListingCollectionLocation,
  ListingRateCard,
  TransportRequirement,
} from '@platform/contracts';
import { UNPRICED_RATE_CARD } from '@platform/contracts';
import type { LocatedListingPoint } from './listing-locator.js';
import { createFieldEncryptor } from '../encryption/field-encryption.js';
import { PrismaCategoryStore } from './prisma-category-store.js';
import { PrismaListingStore } from './prisma-listing-store.js';
import { CategoryChangedError, UnknownCategoryError } from './listing-store.js';
import type { ModerationDecision } from './listing-store.js';
import { CATEGORY_LIST_LIMIT, EXPORTED_LISTING_LIMIT } from './limits.js';

/**
 * A priced category (BRD §8.2, §3.4, slice 2.7a).
 *
 * Real rates rather than zeroes: zero is what an unpriced category defaults to,
 * so a suite where every fixture is unpriced could not tell a policy that was
 * carried through from one that was silently dropped.
 */
const FEE_POLICY = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' as const },
  minimumPlatformFee: { amount: 100, currency: 'GBP' as const },
};

const env = loadEnv();

const client = createPrismaClient({
  connectionString: buildPostgresUrl({
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_TEST_DB,
  }),
});

const categories = new PrismaCategoryStore(client);

/**
 * A real encryptor with a throwaway key.
 *
 * Not a pass-through double: what these tests need to establish is that the
 * street lines are unreadable *in the database* and readable through the store,
 * and a fake that returned its input would let both halves of that pass while
 * the column held plaintext.
 */
const KEY = Buffer.alloc(32, 7).toString('base64');
const store = new PrismaListingStore(client, createFieldEncryptor(KEY));

async function newUser(): Promise<string> {
  const user = await client.user.create({
    data: {
      clerkUserId: `user_${randomUUID()}`,
      email: `user-${randomUUID()}@example.invalid`,
    },
  });
  return user.id;
}

const slug = (): string => `cat-${randomUUID().slice(0, 8)}`;

/** One of each type, so a round trip through JSONB is exercised for all four. */
const SCHEMA: readonly CategoryAttribute[] = [
  {
    key: 'power_source',
    label: 'Power source',
    required: true,
    type: 'choice',
    options: [
      { value: 'petrol', label: 'Petrol' },
      { value: 'cordless', label: 'Cordless battery' },
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
    key: 'condition_notes',
    label: 'Condition notes',
    required: false,
    type: 'text',
    maxLength: 40,
  },
  {
    key: 'accessories',
    label: 'Accessories',
    required: false,
    type: 'choice-many',
    options: [
      { value: 'case', label: 'Carry case' },
      { value: 'blade', label: 'Spare blade' },
    ],
  },
];

async function newCategory(
  authorId: string,
  identity = slug(),
  attributes: readonly CategoryAttribute[] = SCHEMA,
) {
  return categories.create(
    {
      slug: identity,
      name: 'Outdoor and gardening',
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes,
      feePolicy: FEE_POLICY,
      transportOptions: [],
    },
    authorId,
  );
}

const draft = (
  ownerId: string,
  categorySlug: string,
  overrides: {
    readonly attributes?: ListingAttributeValues;
    readonly categoryVersionNumber?: number;
    readonly transportRequirement?: TransportRequirement | null;
    readonly requiresTwoPersonLift?: boolean;
    readonly collectionLocation?: ListingCollectionLocation | null;
    readonly locatedPoint?: LocatedListingPoint | null;
    readonly rates?: ListingRateCard;
  } = {},
) => ({
  ownerId,
  categorySlug,
  title: 'Petrol hedge trimmer',
  description: 'Serviced last spring.',
  replacementValue: { amount: 24_999, currency: 'GBP' } as const,
  // Already validated by the service by the time the store sees them — see
  // `ListingDraft`. These are the stored shapes, so the number is scaled.
  attributes: overrides.attributes ?? {},
  // Null by default, which is what a draft that has not said looks like. The
  // store does not check whether the category offers it — that is the service's
  // decision, and these tests are about what Postgres does with the row.
  transportRequirement: overrides.transportRequirement ?? null,
  requiresTwoPersonLift: overrides.requiresTwoPersonLift ?? false,
  // Null by default too — a draft that has not said where the item is. The
  // postcode arrives already normalised, because the contract normalises it
  // before the service is reached.
  collectionLocation: overrides.collectionLocation ?? null,
  // Null by default: a listing whose postcode has not been geocoded, which is a
  // legitimate state (§8.3) and the one every existing test is in.
  locatedPoint: overrides.locatedPoint ?? null,
  // Unpriced by default, which is what every listing created before slice 2.7b
  // is and what a draft nobody has priced looks like.
  rates: overrides.rates ?? UNPRICED_RATE_CARD,
  categoryVersionNumber: overrides.categoryVersionNumber ?? 1,
});

/**
 * BS7 8AA as postcodes.io really returns it, displaced by a fixed offset.
 *
 * A *fixed* offset in the fixture, not a drawn one, so that a test asserting
 * what landed in the columns asserts an exact value. The randomness is the
 * service's and is covered in `fuzz.test.ts`.
 */
const LOCATED: LocatedListingPoint = {
  latitude: 51.470761,
  longitude: -2.593052,
  fuzzBearingDegrees: 137,
  fuzzDistanceMetres: 742,
  fuzzedLatitude: 51.46587,
  fuzzedLongitude: -2.58575,
};

const ADDRESS: ListingCollectionLocation = {
  line1: '12 Gloucester Road',
  line2: 'Flat 3',
  town: 'Bristol',
  postcode: 'BS7 8AA',
};

beforeEach(async () => {
  await client.listing.deleteMany();
  await client.categoryVersion.deleteMany();
  await client.category.deleteMany();
  await client.sellerTaxProfile.deleteMany();
  await client.auditLog.deleteMany();
  await client.adminApproval.deleteMany();
  await client.authenticationEvent.deleteMany();
  // Before `users`: `feature_flag_overrides.changedById` is ON DELETE
  // RESTRICT, so an override left behind blocks the account it names
  // (slice H3a). Children before parents — the rule every file here keeps.
  await client.featureFlagOverride.deleteMany();
  await client.user.deleteMany();
});

afterAll(async () => {
  await client.$disconnect();
});

describe('creating a draft', () => {
  it('writes the row and reads it back', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(draft(owner, category.slug));

    expect(created.title).toBe('Petrol hedge trimmer');
    expect(created.status).toBe('DRAFT');
    expect(created.categorySlug).toBe(category.slug);
    expect(await store.findOwnedBy(created.id, owner)).toMatchObject({
      id: created.id,
    });
  });

  it('pins the version in force at the moment it is written', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    await categories.addVersion(
      category.slug,
      {
        name: 'Garden and outdoor',
        riskLevel: 'high',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      owner,
    );

    const created = await store.createDraft(
      draft(owner, category.slug, { categoryVersionNumber: 2 }),
    );

    expect(created.categoryVersionNumber).toBe(2);
  });

  it('refuses to write when the version it would pin is not the one stated', async () => {
    // The window this closes is between the service reading the schema and the
    // store writing the row. The service checks too; only this check is inside
    // the write, and only this one can see what is actually being pinned.
    const owner = await newUser();
    const category = await newCategory(owner);
    await categories.addVersion(
      category.slug,
      {
        name: 'Garden and outdoor',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      owner,
    );

    await expect(
      store.createDraft(draft(owner, category.slug, { categoryVersionNumber: 1 })),
    ).rejects.toBeInstanceOf(CategoryChangedError);
  });

  it('writes no row when it refuses', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    await store
      .createDraft(draft(owner, category.slug, { categoryVersionNumber: 7 }))
      .catch(() => undefined);

    expect(await client.listing.count()).toBe(0);
  });

  it('leaves the pin alone when the category is reconfigured afterwards', async () => {
    // The property slice 2.4b depends on: the attribute values a listing holds
    // were validated against *this* schema, and a later reconfiguration must not
    // retroactively change which one that was.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await categories.addVersion(
      category.slug,
      {
        name: 'Garden and outdoor',
        riskLevel: 'high',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      owner,
    );

    const read = await store.findOwnedBy(created.id, owner);
    expect(read?.categoryVersionNumber).toBe(1);
    // And the name it reports is the pinned version's, not the current one.
    expect(read?.categoryName).toBe('Outdoor and gardening');
  });

  it('refuses a category that does not exist', async () => {
    const owner = await newUser();

    await expect(
      store.createDraft(draft(owner, 'no-such-category')),
    ).rejects.toBeInstanceOf(UnknownCategoryError);
  });

  it('stores the amount as an integer and the currency beside it', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    const row = await client.listing.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.replacementValueAmount).toBe(24_999);
    expect(Number.isInteger(row.replacementValueAmount)).toBe(true);
    expect(row.replacementValueCurrency).toBe('GBP');
  });
});

describe('the attribute values', () => {
  const ANSWERS: ListingAttributeValues = {
    power_source: 'cordless',
    weight_kg: 52,
    condition_notes: 'Blade sharpened',
    accessories: ['case', 'blade'],
  };

  it('round-trips every type through JSONB unchanged', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, { attributes: ANSWERS }),
    );

    expect(created.attributes).toEqual(ANSWERS);
    expect((await store.findOwnedBy(created.id, owner))?.attributes).toEqual(ANSWERS);
  });

  it('keeps a scaled number an integer, never a float', async () => {
    // The whole reason ADR 0027 scales rather than storing decimals: JSON has
    // one number type, and a value that arrives as a float is one Phase 3 will
    // bucket into a search facet.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(
      draft(owner, category.slug, { attributes: { weight_kg: 52 } }),
    );

    const row = await client.listing.findUniqueOrThrow({ where: { id: created.id } });
    const stored = row.attributes as { weight_kg: number };
    expect(Number.isInteger(stored.weight_kg)).toBe(true);
    expect(stored.weight_kg).toBe(52);
  });

  it('defaults to an empty object, which is what an unanswered draft has', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    expect(created.attributes).toEqual({});
    const row = await client.listing.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.attributes).toEqual({});
  });

  it('reads the pinned schema, not the category as it stands now', async () => {
    // **The answer to the renamed-key question.** A rename mints a new version;
    // this listing still points at the old one, whose schema still has the old
    // key. The value and the definition it was written against stay together.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(
      draft(owner, category.slug, { attributes: { weight_kg: 52 } }),
    );

    await categories.addVersion(
      category.slug,
      {
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        // `weight_kg` renamed. Nothing migrates the stored value, and nothing
        // needs to.
        attributes: [
          {
            key: 'mass_kg',
            label: 'Mass',
            required: true,
            type: 'number',
            unit: 'kg',
            decimalPlaces: 1,
          },
        ],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      owner,
    );

    const read = await store.findOwnedBy(created.id, owner);
    expect(read?.attributes).toEqual({ weight_kg: 52 });
    expect(read?.categoryAttributes.map((one) => one.key)).toContain('weight_kg');
    expect(read?.categoryAttributes.map((one) => one.key)).not.toContain('mass_kg');
  });

  it('refuses to read values this build cannot make sense of', async () => {
    // Only the validated path writes here, so this means a hand-edited row or a
    // migration bug — and reading it as "no answers" would present somebody's
    // filled-in listing as empty.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await client.$executeRaw`
      UPDATE listings SET attributes = '{"weight_kg": {"nested": true}}'::jsonb
      WHERE id = ${created.id}::uuid`;

    await expect(store.findOwnedBy(created.id, owner)).rejects.toThrow(/cannot read/);
  });

  it('refuses to read values that are not an object at all', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await client.$executeRaw`
      UPDATE listings SET attributes = '[]'::jsonb WHERE id = ${created.id}::uuid`;

    await expect(store.findOwnedBy(created.id, owner)).rejects.toThrow(/not an object/);
  });
});

describe('the categories an owner may choose', () => {
  it('offers one category with its current schema and version', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    expect(await store.findOption(category.slug)).toEqual({
      slug: category.slug,
      name: 'Outdoor and gardening',
      attributes: SCHEMA,
      transportOptions: [],
      versionNumber: 1,
    });
  });

  it('answers null for a slug that names nothing', async () => {
    expect(await store.findOption('no-such-category')).toBeNull();
  });

  it('moves to the newest configuration when one is added', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    await categories.addVersion(
      category.slug,
      {
        name: 'Garden and outdoor',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      owner,
    );

    expect(await store.findOption(category.slug)).toMatchObject({
      name: 'Garden and outdoor',
      attributes: [],
      versionNumber: 2,
    });
  });
});

describe('the constraints', () => {
  it('will not let a listing claim one category and pin another’s version', async () => {
    // **The reason the composite foreign key exists.** Two independent keys
    // would each be individually valid in this state, nothing would notice, and
    // the listing would be validated against a schema from a category it does
    // not belong to.
    const owner = await newUser();
    const mine = await newCategory(owner);
    const other = await newCategory(owner);

    const otherVersion = await client.categoryVersion.findFirstOrThrow({
      where: { categoryId: other.id },
    });

    await expect(
      client.listing.create({
        data: {
          ownerId: owner,
          // Category from one, version from the other.
          categoryId: mine.id,
          categoryVersionId: otherVersion.id,
          title: 'Mismatched',
          description: '',
          replacementValueAmount: 1_000,
          replacementValueCurrency: 'GBP',
          status: 'DRAFT',
        },
      }),
    ).rejects.toThrow();
  });

  it('accepts the pair when they do agree', async () => {
    // The other half: the constraint must not be refusing everything.
    const owner = await newUser();
    const category = await newCategory(owner);
    const version = await client.categoryVersion.findFirstOrThrow({
      where: { categoryId: category.id },
    });

    const created = await client.listing.create({
      data: {
        ownerId: owner,
        categoryId: category.id,
        categoryVersionId: version.id,
        title: 'Matched',
        description: '',
        replacementValueAmount: 1_000,
        replacementValueCurrency: 'GBP',
        status: 'DRAFT',
      },
    });

    expect(created.id).toBeTruthy();
  });

  it('will not let an owner be deleted out from under a listing', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    await store.createDraft(draft(owner, category.slug));

    await expect(client.user.delete({ where: { id: owner } })).rejects.toThrow();
  });

  it('will not let a pinned category version be deleted', async () => {
    // `category_versions` still allows DELETE (slice 2.1 left it deliberately),
    // and from here a listing is what actually holds one in place.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await expect(
      client.categoryVersion.delete({
        where: { id: await pinnedVersionIdOf(created.id) },
      }),
    ).rejects.toThrow();
  });
});

describe('reading', () => {
  it('gives nothing back to somebody who is not the owner', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    expect(await store.findOwnedBy(created.id, stranger)).toBeNull();
  });

  it('answers null for a listing that does not exist', async () => {
    const stranger = await newUser();

    expect(
      await store.findOwnedBy('00000000-0000-4000-9000-000000000999', stranger),
    ).toBeNull();
  });

  it('refuses to read a status this build does not know', async () => {
    // The same treatment `riskLevel` gets. Reading an unknown status as `DRAFT`
    // would present somebody's published listing as unpublished — and from 2.8
    // would offer to publish something that already is.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await client.$executeRaw`
      UPDATE "listings" SET "status" = 'ARCHIVED' WHERE "id" = ${created.id}::uuid
    `;

    await expect(store.findOwnedBy(created.id, owner)).rejects.toThrow(/status/i);
  });
});

describe('the category options', () => {
  it('lists categories oldest first with their current name', async () => {
    const author = await newUser();
    const first = await newCategory(author);
    const second = await newCategory(author);
    await categories.addVersion(
      second.slug,
      {
        name: 'Renamed',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      author,
    );

    const options = await store.listOptions(CATEGORY_LIST_LIMIT);

    expect(options.map((option) => option.slug)).toEqual([first.slug, second.slug]);
    expect(options[1]?.name).toBe('Renamed');
  });

  /** Slice H2 — the bound is in the query, which only a db test can see. */
  it('asks the database for no more categories than the limit', async () => {
    const author = await newUser();
    const first = await newCategory(author);
    await newCategory(author);
    await newCategory(author);

    const options = await store.listOptions(1);

    // Oldest first, so the one kept is the first created — `take` applied after
    // `orderBy`, matching the admin list rather than diverging from it.
    expect(options.map((option) => option.slug)).toEqual([first.slug]);
  });

  it('exposes what an owner needs to fill in the form, and nothing more', async () => {
    // The risk level and the reportable-activity flag are administrative and
    // stay on `CategoryStore`. The attribute schema is here because it *is* the
    // form the owner is about to fill in.
    const author = await newUser();
    await newCategory(author);

    expect(
      Object.keys((await store.listOptions(CATEGORY_LIST_LIMIT))[0] ?? {}).sort(),
    ).toEqual([
      'attributes',
      'name',
      'slug',
      // Also the form the owner is about to fill in, from 2.4c-ii: which
      // requirements the field offers, and the thresholds the browser computes
      // the suggestion from. Still no risk level, still no reportable flag.
      'transportOptions',
      'versionNumber',
    ]);
  });

  it('carries each category’s own schema', async () => {
    const author = await newUser();
    await newCategory(author, 'aaa-with-schema');
    await newCategory(author, 'bbb-without', []);

    const options = await store.listOptions(CATEGORY_LIST_LIMIT);
    expect(options.find((one) => one.slug === 'aaa-with-schema')?.attributes).toEqual(
      SCHEMA,
    );
    expect(options.find((one) => one.slug === 'bbb-without')?.attributes).toEqual([]);
  });
});

async function pinnedVersionIdOf(listingId: string): Promise<string> {
  const row = await client.listing.findUniqueOrThrow({ where: { id: listingId } });
  return row.categoryVersionId;
}

describe('the transport requirement', () => {
  it('round-trips a requirement and the lift flag', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, {
        transportRequirement: 'van_required',
        requiresTwoPersonLift: true,
      }),
    );

    const read = await store.findOwnedBy(created.id, owner);
    expect(read?.transportRequirement).toBe('van_required');
    expect(read?.requiresTwoPersonLift).toBe(true);
  });

  it('stores null for a draft that has not said, and false for the lift', async () => {
    // The defaults a real draft has, and the state every listing written before
    // this migration is in.
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(draft(owner, category.slug));

    const read = await store.findOwnedBy(created.id, owner);
    expect(read?.transportRequirement).toBeNull();
    expect(read?.requiresTwoPersonLift).toBe(false);
  });

  it('does not check whether the category offers it, because that is not its job', async () => {
    // The store's guarantee is narrower than the service's and deliberately so:
    // it promises the version it pins is the one the values were checked
    // against, and nothing about what those values mean (BRD §5.1). A CHECK
    // constraint here would be a second copy of a rule that lives in TypeScript.
    const owner = await newUser();
    const category = await newCategory(owner, slug(), SCHEMA);

    const created = await store.createDraft(
      draft(owner, category.slug, { transportRequirement: 'trailer_required' }),
    );

    expect(created.transportRequirement).toBe('trailer_required');
  });

  it('refuses to read a requirement this build does not know', async () => {
    // Written by a newer build. Both lenient readings are wrong: null would
    // present an owner's stated requirement as unanswered, and passing it
    // through would put an unrenderable value in front of a renter deciding
    // whether they can collect the thing.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await client.listing.update({
      where: { id: created.id },
      data: { transportRequirement: 'helicopter_required' },
    });

    await expect(store.findOwnedBy(created.id, owner)).rejects.toThrow(
      /transport requirement/i,
    );
  });

  it('offers a category’s transport options to somebody choosing one', async () => {
    const author = await newUser();
    const identity = slug();
    await categories.create(
      {
        slug: identity,
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: SCHEMA,
        feePolicy: FEE_POLICY,
        transportOptions: [
          { requirement: 'car_boot', suggestedUpToKg: 25 },
          { requirement: 'van_required', suggestedUpToKg: 150 },
        ],
      },
      author,
    );

    expect((await store.findOption(identity))?.transportOptions).toEqual([
      { requirement: 'car_boot', suggestedUpToKg: 25 },
      { requirement: 'van_required', suggestedUpToKg: 150 },
    ]);
  });

  it('keeps the options the listing pinned after the category withdraws them', async () => {
    // The property that makes withdrawing an option safe, at the level that
    // actually stores it.
    const owner = await newUser();
    const identity = slug();
    const category = await categories.create(
      {
        slug: identity,
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: SCHEMA,
        feePolicy: FEE_POLICY,
        transportOptions: [{ requirement: 'van_required', suggestedUpToKg: 150 }],
      },
      owner,
    );

    const created = await store.createDraft(
      draft(owner, category.slug, { transportRequirement: 'van_required' }),
    );

    await categories.addVersion(
      identity,
      {
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: SCHEMA,
        feePolicy: FEE_POLICY,
        transportOptions: [],
      },
      owner,
    );

    // Still readable, still says what the owner said. The listing points at
    // version 1, whose options included the van.
    expect((await store.findOwnedBy(created.id, owner))?.transportRequirement).toBe(
      'van_required',
    );
  });
});

/**
 * The collection address (slice 2.5a).
 *
 * These are the tests a double cannot fake. Whether the street lines are
 * *actually* unreadable in the column, whether the two halves land in two
 * tables, whether the CHECK fires, and whether cascade and erasure do what the
 * comments claim are all facts about Postgres and the cipher.
 */
describe('the collection address', () => {
  it('stores the district on the listing and the rest in its own table', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, { collectionLocation: ADDRESS }),
    );

    const row = await client.listing.findUniqueOrThrow({
      where: { id: created.id },
      include: { location: true },
    });

    // Derived on write, from the postcode that was stored beside it.
    expect(row.outwardCode).toBe('BS7');
    expect(row.town).toBe('Bristol');
    expect(row.location?.postcode).toBe('BS7 8AA');
  });

  it('leaves no street line readable in the database', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, { collectionLocation: ADDRESS }),
    );

    const stored = await client.listingLocation.findUniqueOrThrow({
      where: { listingId: created.id },
    });

    // The whole point of the envelope. A pass-through encryptor would fail
    // here, which is why this test uses a real one.
    expect(stored.encryptedDetail).not.toContain('Gloucester');
    expect(stored.encryptedDetail).not.toContain('Flat 3');
    expect(stored.encryptedDetail).toMatch(/^v1:/);
  });

  it('reads the whole address back for its owner', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, { collectionLocation: ADDRESS }),
    );

    expect((await store.findOwnedBy(created.id, owner))?.collectionLocation).toEqual(
      ADDRESS,
    );
  });

  it('refuses an envelope moved onto another listing', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const withAddress = await store.createDraft(
      draft(owner, category.slug, { collectionLocation: ADDRESS }),
    );
    const other = await store.createDraft(draft(owner, category.slug));

    const stolen = await client.listingLocation.findUniqueOrThrow({
      where: { listingId: withAddress.id },
    });

    // The attack this binding exists to stop: database write access, no key.
    // Both listings belong to the same owner, which is why the listing id is
    // bound rather than the owner id — the profile store's binding would let
    // this succeed.
    await client.listingLocation.create({
      data: {
        listingId: other.id,
        postcode: stolen.postcode,
        encryptedDetail: stolen.encryptedDetail,
      },
    });

    await expect(store.findOwnedBy(other.id, owner)).rejects.toThrow(
      /could not be decrypted/,
    );
  });

  it('refuses a district with no town', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    // `location_is_complete`. Not reachable through the store — which always
    // writes both — so it is provoked directly, because a constraint nothing
    // tests is a constraint that silently stops existing.
    await expect(
      client.listing.update({
        where: { id: created.id },
        data: { outwardCode: 'BS7' },
      }),
    ).rejects.toThrow(/location_is_complete/);
  });

  it('takes the address with the listing when the listing goes', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, { collectionLocation: ADDRESS }),
    );

    await client.listing.delete({ where: { id: created.id } });

    // ON DELETE CASCADE. An address with no listing is an address belonging to
    // nothing, and every integration teardown depends on this working.
    expect(
      await client.listingLocation.findUnique({ where: { listingId: created.id } }),
    ).toBeNull();
  });
});

describe('erasing an owner', () => {
  it('deletes the listing outright, not just its address', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, { collectionLocation: ADDRESS }),
    );

    await store.deleteAllOwnedBy(owner);

    // **The row is gone**, which is the change 2.8b made. Until then this
    // asserted the opposite — that the listing survived with its address
    // removed — and that assertion is the reason this test is worth reading
    // rather than skimming: it was correct, it was well argued, and the product
    // owner decided otherwise on 10 August 2026.
    expect(await client.listing.findUnique({ where: { id: created.id } })).toBeNull();
    expect(await store.findOwnedBy(created.id, owner)).toBeNull();
  });

  it('takes the precise location with it, by cascade', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, { collectionLocation: ADDRESS }),
    );

    await store.deleteAllOwnedBy(owner);

    // The delete is one statement against `listings`, so this asserts the
    // foreign key is doing the rest. If somebody ever changes that key away
    // from `onDelete: Cascade`, the address survives its listing and this is
    // the test that says so.
    expect(
      await client.listingLocation.findUnique({ where: { listingId: created.id } }),
    ).toBeNull();
  });

  it('leaves another owner alone', async () => {
    const mine = await newUser();
    const theirs = await newUser();
    const category = await newCategory(mine);

    const ours = await store.createDraft(
      draft(mine, category.slug, { collectionLocation: ADDRESS }),
    );
    const other = await store.createDraft(
      draft(theirs, category.slug, { collectionLocation: ADDRESS }),
    );

    await store.deleteAllOwnedBy(mine);

    // The one that matters most on a `deleteMany`: a missing owner filter here
    // would delete the whole table, and every other assertion in this file
    // would still pass.
    expect(await store.findOwnedBy(ours.id, mine)).toBeNull();
    expect((await store.findOwnedBy(other.id, theirs))?.collectionLocation).toEqual(
      ADDRESS,
    );
  });

  it('succeeds when there is nothing to erase', async () => {
    const owner = await newUser();

    // Idempotence is what `PersonalDataEraser` requires, and the case that
    // matters is a retry after a partial failure — which looks exactly like
    // this second call.
    await expect(store.deleteAllOwnedBy(owner)).resolves.toBeUndefined();
    await expect(store.deleteAllOwnedBy(owner)).resolves.toBeUndefined();
  });
});

describe('listing what an owner has', () => {
  it('returns their own listings, newest first', async () => {
    const mine = await newUser();
    const theirs = await newUser();
    const category = await newCategory(mine);

    const first = await store.createDraft(draft(mine, category.slug));
    const second = await store.createDraft(draft(mine, category.slug));
    await store.createDraft(draft(theirs, category.slug));

    const listed = await store.listOwnedBy(mine, EXPORTED_LISTING_LIMIT);

    expect(listed.map((listing) => listing.id)).toEqual([second.id, first.id]);
  });

  /**
   * Slice H2, and it has to be a db test.
   *
   * **The service-level test cannot prove this.** `Paging.fitTo` trims whatever
   * it is handed, so a service reading every row and slicing afterwards behaves
   * identically to one whose query was bounded — same list, same truncation
   * flag, same everything. The difference is entirely in what Postgres was asked
   * for, and the only place that is observable is here. Confirmed by removing
   * `take` from the adapter and watching this fail while the service tests
   * stayed green.
   *
   * A small explicit limit rather than `EXPORTED_LISTING_LIMIT`, so the
   * assertion costs three rows instead of a thousand and one.
   */
  it('asks the database for no more rows than the limit', async () => {
    const mine = await newUser();
    const category = await newCategory(mine);

    await store.createDraft(draft(mine, category.slug));
    const second = await store.createDraft(draft(mine, category.slug));
    const third = await store.createDraft(draft(mine, category.slug));

    const listed = await store.listOwnedBy(mine, 2);

    // The newest two, because `take` applies after `orderBy` — which is the
    // half worth pinning. A bound that kept the oldest rows would cut an
    // export down to the listings least likely to matter.
    expect(listed.map((listing) => listing.id)).toEqual([third.id, second.id]);
  });
});

/**
 * Coordinates, the fuzz offset and the PostGIS column (slice 2.5b).
 *
 * These are the tests only a real database can carry: that the trigger builds
 * the geography from the *fuzzed* pair in the right argument order, that the
 * CHECK constraints fire, and that the offset survives a round trip unchanged.
 */
describe('the geocoded point', () => {
  it('stores all six values, and the trigger derives the geography', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, {
        collectionLocation: ADDRESS,
        locatedPoint: LOCATED,
      }),
    );

    const row = await client.listingLocation.findUniqueOrThrow({
      where: { listingId: created.id },
    });

    expect(row.latitude).toBeCloseTo(LOCATED.latitude, 6);
    expect(row.fuzzBearingDegrees).toBe(137);
    expect(row.fuzzDistanceMetres).toBe(742);
    expect(row.fuzzedLatitude).toBeCloseTo(LOCATED.fuzzedLatitude, 6);
  });

  it('builds the geography from the fuzzed pair, longitude first', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, {
        collectionLocation: ADDRESS,
        locatedPoint: LOCATED,
      }),
    );

    // `ST_MakePoint` takes x then y — longitude then latitude — which is the
    // reverse of how the pair is spoken and written everywhere else in this
    // codebase, and is the single easiest thing to get wrong. Swapped, this
    // listing would sit in the Indian Ocean off Somalia.
    const [point] = await client.$queryRawUnsafe<
      { lat: number; lng: number; srid: number }[]
    >(
      `SELECT ST_Y("fuzzedPoint"::geometry) AS lat,
              ST_X("fuzzedPoint"::geometry) AS lng,
              ST_SRID("fuzzedPoint") AS srid
         FROM listing_locations WHERE "listingId" = $1`,
      created.id,
    );

    expect(point?.lat).toBeCloseTo(LOCATED.fuzzedLatitude, 6);
    expect(point?.lng).toBeCloseTo(LOCATED.fuzzedLongitude, 6);
    expect(point?.srid).toBe(4326);
  });

  it('publishes the fuzzed point and not the true one', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, {
        collectionLocation: ADDRESS,
        locatedPoint: LOCATED,
      }),
    );

    // The whole of BRD §8.4.1 in one assertion: the indexed, publicly queryable
    // point is at least 500 m from where the item actually is. An index built on
    // the true pair would put this at zero.
    const [distance] = await client.$queryRawUnsafe<{ metres: number }[]>(
      `SELECT ST_Distance(
                "fuzzedPoint",
                ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326)::geography
              ) AS metres
         FROM listing_locations WHERE "listingId" = $1`,
      created.id,
      LOCATED.longitude,
      LOCATED.latitude,
    );

    expect(Number(distance?.metres)).toBeGreaterThanOrEqual(500);
  });

  it('leaves the geography null for a listing that could not be geocoded', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, { collectionLocation: ADDRESS }),
    );

    const row = await client.listingLocation.findUniqueOrThrow({
      where: { listingId: created.id },
    });

    expect(row.latitude).toBeNull();
    expect((await store.findOwnedBy(created.id, owner))?.isLocated).toBe(false);
  });

  it('reports a geocoded listing as located, without disclosing where', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, {
        collectionLocation: ADDRESS,
        locatedPoint: LOCATED,
      }),
    );

    const record = await store.findOwnedBy(created.id, owner);

    expect(record?.isLocated).toBe(true);
    // §8.4.1: no coordinate reaches anything above the store. There is no field
    // on the record that could carry one, which is what makes this hold.
    expect(JSON.stringify(record)).not.toContain('51.47');
  });

  it('refuses a half-geocoded row', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(
      draft(owner, category.slug, { collectionLocation: ADDRESS }),
    );

    // A true point with no offset is a listing published at its owner front
    // door. Not reachable through the store, which writes all six together, so
    // it is provoked directly — a constraint nothing tests is one that silently
    // stops existing.
    await expect(
      client.listingLocation.update({
        where: { listingId: created.id },
        data: { latitude: 51.470761, longitude: -2.593052 },
      }),
    ).rejects.toThrow(/location_is_geocoded_or_not/);
  });

  it('refuses a displacement below the 500 m floor', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(
      draft(owner, category.slug, {
        collectionLocation: ADDRESS,
        locatedPoint: LOCATED,
      }),
    );

    // BRD §8.4.1 floor, held in the database as well as in `fuzz.ts`. An edit to
    // the constant that lowered it would fail here rather than quietly
    // publishing points closer to people homes.
    await expect(
      client.listingLocation.update({
        where: { listingId: created.id },
        data: { fuzzDistanceMetres: 100 },
      }),
    ).rejects.toThrow(/fuzz_offset_is_within_bounds/);
  });

  it('keeps the offset exactly as drawn across a round trip', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, {
        collectionLocation: ADDRESS,
        locatedPoint: LOCATED,
      }),
    );

    const first = await client.listingLocation.findUniqueOrThrow({
      where: { listingId: created.id },
    });
    const second = await client.listingLocation.findUniqueOrThrow({
      where: { listingId: created.id },
    });

    // §8.4.1 "stored once and never recomputed", asserted rather than assumed.
    // Two reads returning different displacements would be the averaging attack
    // the rule exists to prevent, arriving from our own code.
    expect(first.fuzzBearingDegrees).toBe(second.fuzzBearingDegrees);
    expect(first.fuzzedLatitude).toBe(second.fuzzedLatitude);
    expect(first.fuzzBearingDegrees).toBe(137);
  });

  it('takes the coordinates with the address when the owner is erased', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, {
        collectionLocation: ADDRESS,
        locatedPoint: LOCATED,
      }),
    );

    await store.deleteAllOwnedBy(owner);

    // The whole row goes, so the point goes with the street. A deletion that
    // removed the address and left a coordinate on somebody's house would be
    // the erasure failing at exactly the thing it is for — and since 2.8b the
    // listing goes too, so there is nothing left to read a coordinate from.
    expect(
      await client.listingLocation.findUnique({ where: { listingId: created.id } }),
    ).toBeNull();
    expect(await store.findOwnedBy(created.id, owner)).toBeNull();
  });
});

/**
 * The rate card and the current fee policy, against a real database
 * (slice 2.7b, rewritten by 2.7c — ADR 0042, ADR 0033).
 *
 * The integration test above proves the *controller* prices from
 * `listing.currentFeePolicy`. It cannot prove which row that value comes from,
 * and this is where the join is real: the adapter reads the category's latest
 * version on every read, so a listing written months ago is priced under today's
 * terms.
 */
describe('the rate card', () => {
  it('round-trips all three rates', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, {
        rates: {
          daily: { amount: 1_800, currency: 'GBP' },
          weekend: { amount: 3_000, currency: 'GBP' },
          weekly: { amount: 9_000, currency: 'GBP' },
        },
      }),
    );

    expect(created.rates.daily).toEqual({ amount: 1_800, currency: 'GBP' });

    // Read back rather than trusted from the write: the four columns are
    // reassembled on the way out, and a mapping that dropped one would still
    // return what `createDraft` was handed.
    const reread = await store.findOwnedBy(created.id, owner);
    expect(reread?.rates).toEqual({
      daily: { amount: 1_800, currency: 'GBP' },
      weekend: { amount: 3_000, currency: 'GBP' },
      weekly: { amount: 9_000, currency: 'GBP' },
    });
  });

  it('reads an unpriced listing as three nulls rather than three zeroes', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    const reread = await store.findOwnedBy(created.id, owner);
    expect(reread?.rates).toEqual({ daily: null, weekend: null, weekly: null });
  });

  it('refuses a weekly rate with no daily rate, in the database', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    // The contract refuses this first, so this write goes through the store
    // directly — which is the point. The CHECK is what holds when a future
    // caller reaches the row another way.
    await expect(
      client.listing.create({
        data: {
          ownerId: owner,
          categoryId: category.id,
          categoryVersionId: (
            await client.categoryVersion.findFirstOrThrow({
              where: { categoryId: category.id },
            })
          ).id,
          title: 'Probe',
          description: '',
          status: 'DRAFT',
          replacementValueAmount: 10_000,
          replacementValueCurrency: 'GBP',
          weeklyRateAmount: 9_000,
        },
      }),
    ).rejects.toThrow(/rate_card_has_a_daily_rate_if_it_has_any/);
  });
});

describe('the current fee policy', () => {
  it('is read from the category, and matches while nothing has changed', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(
      draft(owner, category.slug, {
        rates: {
          daily: { amount: 1_800, currency: 'GBP' },
          weekend: null,
          weekly: null,
        },
      }),
    );

    expect(created.currentFeePolicy.renterFeeBasisPoints).toBe(800);
  });

  /**
   * **This test asserted the exact opposite until slice 2.7c**, and the inversion
   * is the whole of ADR 0042 in one assertion.
   *
   * It used to be titled *"does not move when the category is repriced"* and it
   * cited §8.2 — a booking retains the terms it was made under. The rule is real
   * and the subject was wrong: **a listing is not a booking.** A listing is an
   * offer, and §3.4.4 wants the price on an offer to be the price payable today.
   * Pinning the policy to the listing also meant that editing a listing moved it
   * to a newer version and silently changed what its owner is paid.
   *
   * §8.2's guarantee has not been dropped. It moves to the **booking**, which
   * pins the policy at the moment it is made, in Phase 5.
   */
  it('moves when the category is repriced, though the pin does not', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(
      draft(owner, category.slug, {
        rates: {
          daily: { amount: 1_800, currency: 'GBP' },
          weekend: null,
          weekly: null,
        },
      }),
    );

    await categories.addVersion(
      category.slug,
      {
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: SCHEMA,
        transportOptions: [],
        feePolicy: { ...FEE_POLICY, renterFeeBasisPoints: 1_600 },
      },
      owner,
    );

    const reread = await store.findOwnedBy(created.id, owner);

    // **Both halves in one assertion pair, because the pair is the decision.**
    // The pin has not moved — the listing's stored answers are still read against
    // version 1, which is what keeps a stored `25` meaning 2.5 kg (ADR 0029) —
    // and the fee policy has, because it is read from the category's latest.
    expect(reread?.categoryVersionNumber).toBe(1);
    expect(reread?.currentFeePolicy.renterFeeBasisPoints).toBe(1_600);

    // The attribute schema comes from the pinned version, not the latest, and
    // that is asserted here rather than trusted: the two now come from different
    // rows of the same table in one query, and the failure worth catching is the
    // join being wired to the wrong one.
    expect(reread?.categoryAttributes).toEqual(SCHEMA);
  });

  it('is the latest version even when several have been appended', async () => {
    // `take: 1` on a descending order, exercised past the one-extra-version case
    // — an `orderBy` accidentally ascending would pass with two versions and
    // fail here.
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    for (const rate of [900, 1_100, 1_300]) {
      await categories.addVersion(
        category.slug,
        {
          name: 'Outdoor and gardening',
          riskLevel: 'medium',
          reportableActivity: 'none',
          attributes: SCHEMA,
          transportOptions: [],
          feePolicy: { ...FEE_POLICY, renterFeeBasisPoints: rate },
        },
        owner,
      );
    }

    const reread = await store.findOwnedBy(created.id, owner);

    expect(reread?.currentFeePolicy.renterFeeBasisPoints).toBe(1_300);
    expect(reread?.categoryVersionNumber).toBe(1);
  });

  it('prices every listing in a list from the current policy', async () => {
    // `listOwnedBy` builds its records through the same mapper, and a join
    // written for the single read but forgotten on the list is exactly the kind
    // of drift that shows up as one page disagreeing with another.
    const owner = await newUser();
    const category = await newCategory(owner);
    await store.createDraft(draft(owner, category.slug));

    await categories.addVersion(
      category.slug,
      {
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: SCHEMA,
        transportOptions: [],
        feePolicy: { ...FEE_POLICY, renterFeeBasisPoints: 1_600 },
      },
      owner,
    );

    const [listed] = await store.listOwnedBy(owner, 10);

    expect(listed?.currentFeePolicy.renterFeeBasisPoints).toBe(1_600);
  });
});

/**
 * Rewriting a listing, against a real database (slice 2.9b-i, ADR 0042).
 *
 * **What only this file can prove**: that the `UPDATE` touches the columns it is
 * given and no others. The in-memory double spreads over a held record, so a
 * store method that wrote `outwardCode: null` or dropped the location row would
 * behave identically there and destroy an address here.
 */
describe('updating a listing', () => {
  const EDIT = {
    title: 'Renamed',
    description: 'Rewritten.',
    replacementValue: { amount: 30_000, currency: 'GBP' as const },
    attributes: { power_source: 'cordless', weight_kg: 41 },
    transportRequirement: null,
    requiresTwoPersonLift: true,
    rates: {
      daily: { amount: 2_000, currency: 'GBP' as const },
      weekend: null,
      weekly: null,
    },
    /*
     * **`cleared`, and it is doing something rather than nothing** (slice
     * 2.9b-ii). Through 2.9b-i an edit carried no address at all and the store
     * left the row alone; now every edit states what happens to it, so the
     * default here has to be a real case. `cleared` is the honest one for these
     * tests: the listings they build have no address, so removing one removes
     * nothing and the assertions stay about titles, versions and status.
     *
     * The tests that are *about* the address override it, below.
     */
    collectionLocation: { kind: 'cleared' } as const,
    categoryVersionNumber: 1,
  };

  /** An address in Bristol, and the point postcodes.io would place it at. */
  const BRISTOL: ListingCollectionLocation = {
    line1: '12 Gloucester Road',
    line2: null,
    town: 'Bristol',
    postcode: 'BS7 8AA',
  };

  const BRISTOL_POINT: LocatedListingPoint = {
    latitude: 51.4779,
    longitude: -2.5872,
    fuzzBearingDegrees: 90,
    fuzzDistanceMetres: 700,
    fuzzedLatitude: 51.4779,
    fuzzedLongitude: -2.5771,
  };

  it('writes what it is given', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    const updated = await store.update(created.id, owner, EDIT);

    expect(updated?.title).toBe('Renamed');
    expect(updated?.replacementValue).toEqual({ amount: 30_000, currency: 'GBP' });
    expect(updated?.requiresTwoPersonLift).toBe(true);
    expect(updated?.rates.daily).toEqual({ amount: 2_000, currency: 'GBP' });
  });

  it('resolves to null for somebody else’s listing, and writes nothing', async () => {
    const mine = await newUser();
    const theirs = await newUser();
    const category = await newCategory(mine);
    const created = await store.createDraft(draft(mine, category.slug));

    expect(await store.update(created.id, theirs, EDIT)).toBeNull();

    // The owner is inside the statement rather than a comparison beside it, so
    // this is what proves the write did not happen rather than merely that the
    // caller was told no.
    const reread = await store.findOwnedBy(created.id, mine);
    expect(reread?.title).not.toBe('Renamed');
  });

  /**
   * The collection address, against a real database (slice 2.9b-ii).
   *
   * **Only this file can prove any of it.** The in-memory double keeps a record
   * and a map; the real store keeps two tables, a derived pair of columns, two
   * CHECK constraints and a trigger, and every defect worth catching here lives
   * between them.
   */
  describe('the collection address', () => {
    /** The private row as it actually sits in Postgres, coordinates and all. */
    const locationRow = (listingId: string) =>
      client.listingLocation.findUnique({
        where: { listingId },
        select: {
          postcode: true,
          latitude: true,
          longitude: true,
          fuzzBearingDegrees: true,
          fuzzDistanceMetres: true,
          fuzzedLatitude: true,
          fuzzedLongitude: true,
        },
      });

    /** The publishable pair, read from the column rather than the record. */
    const publishedHalf = (listingId: string) =>
      client.listing.findUniqueOrThrow({
        where: { id: listingId },
        select: { outwardCode: true, town: true },
      });

    const located = async (owner: string, slug: string) =>
      store.createDraft(
        draft(owner, slug, {
          collectionLocation: BRISTOL,
          locatedPoint: BRISTOL_POINT,
        }),
      );

    it('rewrites the lines and leaves the point untouched, for the same postcode', async () => {
      /*
       * **The assertion the slice exists for.** `address-only` must not so much
       * as name the six coordinate columns: the stored fuzz offset is what makes
       * a listing publish the same displaced point every time, and redrawing it
       * across saves is the averaging attack §8.4.1 and ADR 0032 exist to stop.
       */
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await located(owner, category.slug);
      const before = await locationRow(created.id);

      await store.update(created.id, owner, {
        ...EDIT,
        collectionLocation: {
          kind: 'address-only',
          location: { ...BRISTOL, line1: '12a Gloucester Road', line2: 'Flat 2' },
        },
      });

      const after = await locationRow(created.id);
      expect(after).toEqual(before);

      const reread = await store.findOwnedBy(created.id, owner);
      expect(reread?.collectionLocation?.line1).toBe('12a Gloucester Road');
      expect(reread?.collectionLocation?.line2).toBe('Flat 2');
      expect(reread?.isLocated).toBe(true);
    });

    it('keeps the published pair rather than nulling it', async () => {
      /*
       * `outwardCode` and `town` sit on `listings` beside every column an edit
       * *does* write, so a `data:` object is one keystroke from nulling them —
       * and `location_is_complete` would accept both being null quite happily,
       * because the pair would still agree with itself.
       */
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await located(owner, category.slug);

      await store.update(created.id, owner, {
        ...EDIT,
        collectionLocation: { kind: 'address-only', location: BRISTOL },
      });

      expect(await publishedHalf(created.id)).toEqual({
        outwardCode: 'BS7',
        town: 'Bristol',
      });
    });

    it('moves the point and the published pair to a new postcode', async () => {
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await located(owner, category.slug);

      await store.update(created.id, owner, {
        ...EDIT,
        collectionLocation: {
          kind: 'relocated',
          location: {
            line1: '4 Mill Lane',
            line2: null,
            town: 'Bath',
            postcode: 'BA1 1AA',
          },
          point: {
            latitude: 51.3811,
            longitude: -2.359,
            // **The offset the listing already had**, which is what the service
            // hands down. Asserting it survives here is what proves the adapter
            // writes what it is given rather than inventing a displacement.
            fuzzBearingDegrees: BRISTOL_POINT.fuzzBearingDegrees,
            fuzzDistanceMetres: BRISTOL_POINT.fuzzDistanceMetres,
            fuzzedLatitude: 51.3811,
            fuzzedLongitude: -2.3489,
          },
        },
      });

      const row = await locationRow(created.id);
      expect(row?.postcode).toBe('BA1 1AA');
      expect(row?.latitude).toBeCloseTo(51.3811, 4);
      expect(row?.fuzzBearingDegrees).toBe(BRISTOL_POINT.fuzzBearingDegrees);
      expect(row?.fuzzDistanceMetres).toBe(BRISTOL_POINT.fuzzDistanceMetres);

      expect(await publishedHalf(created.id)).toEqual({
        outwardCode: 'BA1',
        town: 'Bath',
      });
    });

    it('moves the PostGIS geography with the fuzzed pair', async () => {
      /*
       * The trigger is `BEFORE INSERT OR UPDATE OF "fuzzedLatitude",
       * "fuzzedLongitude"`, so it fires here only because `relocated` names those
       * columns. A stale `fuzzedPoint` would be invisible until Phase 3's radius
       * search returned a listing at the address it used to be at — which is a
       * defect that would be found by a user, months from now.
       *
       * `ST_MakePoint` takes (longitude, latitude), which is the reverse of how
       * the pair is written everywhere else and the easiest thing here to get
       * wrong. `createDraft` has the same assertion for the insert path.
       */
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await located(owner, category.slug);

      await store.update(created.id, owner, {
        ...EDIT,
        collectionLocation: {
          kind: 'relocated',
          location: {
            line1: '4 Mill Lane',
            line2: null,
            town: 'Bath',
            postcode: 'BA1 1AA',
          },
          point: {
            latitude: 51.3811,
            longitude: -2.359,
            fuzzBearingDegrees: 90,
            fuzzDistanceMetres: 700,
            fuzzedLatitude: 51.3811,
            fuzzedLongitude: -2.3489,
          },
        },
      });

      const [point] = await client.$queryRaw<{ latitude: number; longitude: number }[]>`
        SELECT ST_Y("fuzzedPoint"::geometry) AS latitude,
               ST_X("fuzzedPoint"::geometry) AS longitude
        FROM "listing_locations" WHERE "listingId" = ${created.id}::uuid
      `;

      expect(point?.latitude).toBeCloseTo(51.3811, 4);
      expect(point?.longitude).toBeCloseTo(-2.3489, 4);
    });

    it('nulls all six coordinates when the new postcode cannot be placed', async () => {
      /*
       * The `update` branch writes the six explicitly rather than spreading an
       * empty object, and this is why: an update that omits a column keeps what
       * was there, so a spread would leave the listing published at the last
       * place it was, under an address it has moved away from.
       */
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await located(owner, category.slug);

      await store.update(created.id, owner, {
        ...EDIT,
        collectionLocation: {
          kind: 'relocated',
          location: {
            line1: '1 Nowhere Street',
            line2: null,
            town: 'Bath',
            postcode: 'BA1 9ZZ',
          },
          point: null,
        },
      });

      expect(await locationRow(created.id)).toEqual({
        postcode: 'BA1 9ZZ',
        latitude: null,
        longitude: null,
        fuzzBearingDegrees: null,
        fuzzDistanceMetres: null,
        fuzzedLatitude: null,
        fuzzedLongitude: null,
      });

      const reread = await store.findOwnedBy(created.id, owner);
      expect(reread?.isLocated).toBe(false);
    });

    it('gives an address to a listing that never had one', async () => {
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await store.createDraft(draft(owner, category.slug));
      expect(created.collectionLocation).toBeNull();

      await store.update(created.id, owner, {
        ...EDIT,
        collectionLocation: {
          kind: 'relocated',
          location: BRISTOL,
          point: BRISTOL_POINT,
        },
      });

      const reread = await store.findOwnedBy(created.id, owner);
      expect(reread?.collectionLocation).toEqual(BRISTOL);
      expect(reread?.isLocated).toBe(true);
      expect(await publishedHalf(created.id)).toEqual({
        outwardCode: 'BS7',
        town: 'Bristol',
      });
    });

    it('removes the row and the published pair when the address is cleared', async () => {
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await located(owner, category.slug);

      await store.update(created.id, owner, {
        ...EDIT,
        collectionLocation: { kind: 'cleared' },
      });

      expect(await locationRow(created.id)).toBeNull();
      expect(await publishedHalf(created.id)).toEqual({
        outwardCode: null,
        town: null,
      });
    });

    it('clears an address a listing never had, without complaining', async () => {
      // `deleteMany`, not `delete`. The commonest edit in the system is one to a
      // draft with no address by somebody who still has not given one, and
      // `delete` would throw on it.
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await store.createDraft(draft(owner, category.slug));

      await expect(
        store.update(created.id, owner, {
          ...EDIT,
          collectionLocation: { kind: 'cleared' },
        }),
      ).resolves.not.toBeNull();
    });

    it('re-encrypts under the same listing id, so the lines still read back', async () => {
      // The envelope binds the listing id as additional authenticated data, and
      // an edit does not change the id — so this is really asserting that the
      // rewrite went through `encrypt` at all rather than storing plaintext.
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await located(owner, category.slug);

      await store.update(created.id, owner, {
        ...EDIT,
        collectionLocation: {
          kind: 'address-only',
          location: { ...BRISTOL, line1: 'Rear workshop, 12 Gloucester Road' },
        },
      });

      const stored = await client.listingLocation.findUniqueOrThrow({
        where: { listingId: created.id },
        select: { encryptedDetail: true },
      });
      expect(stored.encryptedDetail).not.toContain('Gloucester');

      const reread = await store.findOwnedBy(created.id, owner);
      expect(reread?.collectionLocation?.line1).toBe(
        'Rear workshop, 12 Gloucester Road',
      );
    });

    it('writes neither table when the category has moved underneath the edit', async () => {
      /*
       * The two rows are written in one transaction, and the version guard runs
       * before it opens. This proves the address survives a refusal — a listing
       * whose address had been rewritten but whose title had not would be the
       * worst outcome available, because nothing would ever say so.
       */
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await located(owner, category.slug);

      await categories.addVersion(
        category.slug,
        {
          name: 'Outdoor and gardening',
          riskLevel: 'medium',
          reportableActivity: 'none',
          attributes: SCHEMA,
          transportOptions: [],
          feePolicy: FEE_POLICY,
        },
        owner,
      );

      await expect(
        store.update(created.id, owner, {
          ...EDIT,
          collectionLocation: { kind: 'cleared' },
        }),
      ).rejects.toThrow(CategoryChangedError);

      const reread = await store.findOwnedBy(created.id, owner);
      expect(reread?.collectionLocation).toEqual(BRISTOL);
      expect(await publishedHalf(created.id)).toEqual({
        outwardCode: 'BS7',
        town: 'Bristol',
      });
    });

    it('returns the stored offset, and no coordinates with it', async () => {
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await located(owner, category.slug);

      const offset = await store.findFuzzOffset(created.id, owner);

      expect(offset).toEqual({
        bearingDegrees: BRISTOL_POINT.fuzzBearingDegrees,
        distanceMetres: BRISTOL_POINT.fuzzDistanceMetres,
      });
      // The whole shape, not a property check: this is the one method that
      // reaches into `listing_locations` for something other than the address,
      // and a `select` widened later would show up right here.
      expect(Object.keys(offset ?? {})).toEqual(['bearingDegrees', 'distanceMetres']);
    });

    it('has no offset for a listing whose postcode was never placed', async () => {
      const owner = await newUser();
      const category = await newCategory(owner);
      const created = await store.createDraft(
        draft(owner, category.slug, { collectionLocation: BRISTOL }),
      );

      // An address with no coordinates: the geocoder was down or did not know
      // the postcode. There is no offset to honour, so the next save draws the
      // listing's first — which is what `null` tells the service to do.
      expect(await store.findFuzzOffset(created.id, owner)).toBeNull();
    });

    it('has no offset for somebody else’s listing', async () => {
      const mine = await newUser();
      const theirs = await newUser();
      const category = await newCategory(mine);
      const created = await located(mine, category.slug);

      expect(await store.findFuzzOffset(created.id, theirs)).toBeNull();
    });
  });

  it('leaves the status and the moderation decision alone', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));
    await store.publish(created.id, owner);
    await store.moderate({
      listingId: created.id,
      state: 'UNDER_REVIEW',
      reason: 'Checking the serial number against the register',
      moderatorId: owner,
      decidedAt: new Date(),
    });

    await store.update(created.id, owner, EDIT);

    const reread = await store.findOwnedBy(created.id, owner);
    expect(reread?.status).toBe('PUBLISHED');
    expect(reread?.moderationState).toBe('UNDER_REVIEW');
  });

  it('re-pins to the category’s current version, keeping the category', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));
    expect(created.categoryVersionNumber).toBe(1);

    await categories.addVersion(
      category.slug,
      {
        name: 'Renamed category',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: SCHEMA,
        transportOptions: [],
        feePolicy: FEE_POLICY,
      },
      owner,
    );

    const updated = await store.update(created.id, owner, {
      ...EDIT,
      categoryVersionNumber: 2,
    });

    expect(updated?.categoryVersionNumber).toBe(2);
    // The composite foreign key means the category cannot change with it, and
    // the name proves the join followed the new version rather than the old.
    expect(updated?.categorySlug).toBe(category.slug);
    expect(updated?.categoryName).toBe('Renamed category');
  });

  it('refuses an edit validated against a version that has been replaced', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await categories.addVersion(
      category.slug,
      {
        name: 'Outdoor and gardening',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: SCHEMA,
        transportOptions: [],
        feePolicy: FEE_POLICY,
      },
      owner,
    );

    // The guard inside the write, which the service's own check cannot close:
    // between its read and this one a reconfiguration can land.
    await expect(store.update(created.id, owner, EDIT)).rejects.toThrow(
      CategoryChangedError,
    );

    const reread = await store.findOwnedBy(created.id, owner);
    expect(reread?.title).not.toBe('Renamed');
    expect(reread?.categoryVersionNumber).toBe(1);
  });
});

/**
 * The publication transition, against a real database (slice 2.8a).
 *
 * The service tests prove which listings *may* publish; these prove what the
 * adapter does with the row — that the owner is part of the write rather than a
 * check beside it, and that publishing twice is not an error.
 */
describe('publishing', () => {
  it('moves a draft to published and re-reads it', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));
    expect(created.status).toBe('DRAFT');

    const published = await store.publish(created.id, owner);

    expect(published?.status).toBe('PUBLISHED');
    // Read back independently: `publish` re-reads rather than constructing the
    // record from what it wrote, and this is what would catch it inventing one.
    expect((await store.findOwnedBy(created.id, owner))?.status).toBe('PUBLISHED');
  });

  it('is idempotent', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await store.publish(created.id, owner);
    const again = await store.publish(created.id, owner);

    // Not null, and not an error. A filter of `status: 'DRAFT'` would have made
    // the second call indistinguishable from somebody else's listing.
    expect(again?.status).toBe('PUBLISHED');
  });

  /**
   * The owner is in the `where`, not a comparison afterwards. On a read that
   * mistake discloses a listing; on a write it changes somebody else's.
   */
  it('will not publish a listing belonging to somebody else', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    expect(await store.publish(created.id, stranger)).toBeNull();
    // And the row is untouched, which is the half a null return does not prove.
    expect((await store.findOwnedBy(created.id, owner))?.status).toBe('DRAFT');
  });

  it('answers null for a listing that does not exist', async () => {
    const owner = await newUser();
    expect(
      await store.publish('11111111-1111-4111-8111-111111111111', owner),
    ).toBeNull();
  });

  it('refuses a status the vocabulary does not know, in the database', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await client.$executeRawUnsafe(
      `UPDATE listings SET status = 'SOLD' WHERE id = '${created.id}'::uuid`,
    );

    // `asStatus` throws rather than defaulting: a row written by a newer build
    // read as DRAFT would hide a listing its owner believes is live.
    await expect(store.findOwnedBy(created.id, owner)).rejects.toThrow(/status/i);
  });
});

describe('pausing', () => {
  it('moves a published listing to paused and re-reads it', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));
    await store.publish(created.id, owner);

    const paused = await store.pause(created.id, owner);

    expect(paused?.status).toBe('PAUSED');
    // Read back independently, for `publish`'s reason: the method re-reads
    // rather than constructing a record, and this is what catches it inventing
    // one.
    expect((await store.findOwnedBy(created.id, owner))?.status).toBe('PAUSED');
  });

  it('is idempotent', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));
    await store.publish(created.id, owner);

    await store.pause(created.id, owner);
    const again = await store.pause(created.id, owner);

    expect(again?.status).toBe('PAUSED');
  });

  it('will not pause a listing belonging to somebody else', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));
    await store.publish(created.id, owner);

    expect(await store.pause(created.id, stranger)).toBeNull();
    // And the row is untouched. A null return says the write was refused; only
    // this says the listing is still live, which is what the owner cares about.
    expect((await store.findOwnedBy(created.id, owner))?.status).toBe('PUBLISHED');
  });

  it('answers null for a listing that does not exist', async () => {
    const owner = await newUser();
    expect(await store.pause('11111111-1111-4111-8111-111111111111', owner)).toBeNull();
  });

  it('goes back to published, because pausing is reversible', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await store.publish(created.id, owner);
    await store.pause(created.id, owner);
    const resumed = await store.publish(created.id, owner);

    // The round trip, against a real database. Reversibility is the entire
    // reason archive was removed from the BRD rather than built beside this.
    expect(resumed?.status).toBe('PUBLISHED');
  });
});

describe('moderation', () => {
  const decision = (
    listingId: string,
    moderatorId: string,
    over: Partial<ModerationDecision> = {},
  ) => ({
    listingId,
    state: 'REJECTED' as const,
    reason: 'The photographs show a different item',
    moderatedById: moderatorId,
    ...over,
    moderatorId,
    decidedAt: new Date('2026-08-10T12:00:00.000Z'),
  });

  it('defaults a new listing to approved, with nobody having decided it', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(draft(owner, category.slug));

    // The column default, read back through the adapter. `APPROVED` is the
    // absence of a decision rather than one somebody made — which is why the
    // author and the reason are null beside it.
    expect(created.moderationState).toBe('APPROVED');
    expect(created.moderationReason).toBeNull();

    const row = await client.listing.findUnique({ where: { id: created.id } });
    expect(row?.moderatedById).toBeNull();
    expect(row?.moderatedAt).toBeNull();
  });

  it('records the decision, its reason and its author', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    const moderated = await store.moderate(decision(created.id, admin));

    expect(moderated?.moderationState).toBe('REJECTED');
    expect(moderated?.moderationReason).toBe('The photographs show a different item');

    const row = await client.listing.findUnique({ where: { id: created.id } });
    expect(row?.moderatedById).toBe(admin);
    expect(row?.moderatedAt).toEqual(new Date('2026-08-10T12:00:00.000Z'));
  });

  it('leaves the owner’s status alone, which is the whole of ADR 0041', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));
    await store.publish(created.id, owner);

    await store.moderate(decision(created.id, admin));

    // Against a real row rather than a double: with one field this would now
    // read `REJECTED` and the owner's intent would be gone.
    const row = await client.listing.findUnique({ where: { id: created.id } });
    expect(row?.status).toBe('PUBLISHED');
    expect(row?.moderationState).toBe('REJECTED');
  });

  it('clears the reason when a listing is put back', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));
    await store.moderate(decision(created.id, admin));

    const reinstated = await store.moderate(
      decision(created.id, admin, { state: 'APPROVED', reason: null }),
    );

    expect(reinstated?.moderationState).toBe('APPROVED');
    expect(reinstated?.moderationReason).toBeNull();
  });

  it('answers null for a listing that does not exist', async () => {
    const admin = await newUser();

    expect(
      await store.moderate(decision('11111111-1111-4111-8111-111111111111', admin)),
    ).toBeNull();
  });

  it('reads a listing that is not the caller’s, which is the point', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    // `findOwnedBy` would answer null for anybody but the owner. This is the
    // one read in the module that deliberately does not, and the guard is what
    // stands in front of it.
    expect((await store.findForModeration(created.id))?.id).toBe(created.id);
  });

  it('refuses to hide a listing with no reason, in the database', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    // The service refuses first; this is the backstop, and it is what makes the
    // rule true of any future writer that forgets to ask.
    await expect(
      client.$executeRawUnsafe(
        `UPDATE listings SET "moderationState" = 'REJECTED' WHERE id = '${created.id}'::uuid`,
      ),
    ).rejects.toThrow(/moderation_hidden_has_a_reason/);
  });

  it('refuses a blank reason too, not merely a null one', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    // `"   "` satisfies NOT NULL and satisfies nobody reading it. The `btrim`
    // in the constraint is what closes that, and it matches the contract's own
    // trim so the two agree about what "absent" means.
    await expect(
      client.$executeRawUnsafe(
        `UPDATE listings SET "moderationState" = 'REJECTED', "moderationReason" = '   ' WHERE id = '${created.id}'::uuid`,
      ),
    ).rejects.toThrow(/moderation_hidden_has_a_reason/);
  });

  it('refuses an author with no timestamp', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    await expect(
      client.$executeRawUnsafe(
        `UPDATE listings SET "moderatedById" = '${owner}'::uuid WHERE id = '${created.id}'::uuid`,
      ),
    ).rejects.toThrow(/moderation_authorship_is_complete/);
  });

  it('refuses a state the vocabulary does not know, when read', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);
    const created = await store.createDraft(draft(owner, category.slug));

    // A reason is supplied because the setup could not proceed without one, and
    // that is a free confirmation worth keeping: `moderation_hidden_has_a_reason`
    // is written as "not APPROVED implies a reason" rather than naming the two
    // hiding states, so **a state nobody has declared yet already inherits the
    // rule**. The constraint refused this test's own first draft.
    await client.$executeRawUnsafe(
      `UPDATE listings SET "moderationState" = 'SHADOWBANNED', "moderationReason" = 'from a newer build' WHERE id = '${created.id}'::uuid`,
    );

    // `asModerationState` throws rather than defaulting, for `asStatus`' reason
    // and one of its own: defaulting to APPROVED would make a listing somebody
    // deliberately hid visible again, silently.
    await expect(store.findForModeration(created.id)).rejects.toThrow(/moderation/i);
  });
});
