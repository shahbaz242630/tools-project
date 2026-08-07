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

    const options = await store.listOptions();

    expect(options.map((option) => option.slug)).toEqual([first.slug, second.slug]);
    expect(options[1]?.name).toBe('Renamed');
  });

  it('exposes what an owner needs to fill in the form, and nothing more', async () => {
    // The risk level and the reportable-activity flag are administrative and
    // stay on `CategoryStore`. The attribute schema is here because it *is* the
    // form the owner is about to fill in.
    const author = await newUser();
    await newCategory(author);

    expect(Object.keys((await store.listOptions())[0] ?? {}).sort()).toEqual([
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

    const options = await store.listOptions();
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
  it('removes the precise half and keeps the listing', async () => {
    const owner = await newUser();
    const category = await newCategory(owner);

    const created = await store.createDraft(
      draft(owner, category.slug, { collectionLocation: ADDRESS }),
    );

    await store.eraseLocationsFor(owner);

    const row = await client.listing.findUnique({
      where: { id: created.id },
      include: { location: true },
    });

    // The listing survives — from Phase 4 a booking references it — and
    // collapses to the coarseness it was always published at.
    expect(row?.location).toBeNull();
    expect(row?.outwardCode).toBe('BS7');
    expect(row?.town).toBe('Bristol');
    expect((await store.findOwnedBy(created.id, owner))?.collectionLocation).toBeNull();
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

    await store.eraseLocationsFor(mine);

    expect((await store.findOwnedBy(ours.id, mine))?.collectionLocation).toBeNull();
    expect((await store.findOwnedBy(other.id, theirs))?.collectionLocation).toEqual(
      ADDRESS,
    );
  });

  it('succeeds when there is nothing to erase', async () => {
    const owner = await newUser();

    // Idempotence is what `PersonalDataEraser` requires, and the case that
    // matters is a retry after a partial failure — which looks exactly like
    // this second call.
    await expect(store.eraseLocationsFor(owner)).resolves.toBeUndefined();
    await expect(store.eraseLocationsFor(owner)).resolves.toBeUndefined();
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

    const listed = await store.listOwnedBy(mine);

    expect(listed.map((listing) => listing.id)).toEqual([second.id, first.id]);
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

    await store.eraseLocationsFor(owner);

    // The whole row goes, so the point goes with the street. A deletion that
    // removed the address and left a coordinate on somebody house would be the
    // erasure failing at exactly the thing it is for.
    expect(
      await client.listingLocation.findUnique({ where: { listingId: created.id } }),
    ).toBeNull();
    expect((await store.findOwnedBy(created.id, owner))?.isLocated).toBe(false);
  });
});

/**
 * The rate card and the pinned fee policy, against a real database
 * (slice 2.7b, ADR 0029, ADR 0033).
 *
 * The integration test above proves the *controller* prices from
 * `listing.categoryFeePolicy`. It cannot prove where that value comes from,
 * because the in-memory double captures the policy when the listing is created
 * and so could never re-price one. Only here, where the adapter genuinely
 * re-reads the pinned version row on every read, is that a real assertion.
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

describe('the pinned fee policy', () => {
  it('is read from the version the listing points at', async () => {
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

    expect(created.categoryFeePolicy.renterFeeBasisPoints).toBe(800);
  });

  /**
   * **The guarantee §8.2 asks this table to provide, proved where it can fail.**
   *
   * The category is repriced, minting a new version. The listing still points at
   * the old one, so its fee policy must not move — otherwise reconfiguring a
   * category would silently re-price every listing already written under it.
   */
  it('does not move when the category is repriced', async () => {
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

    expect(reread?.categoryVersionNumber).toBe(1);
    expect(reread?.categoryFeePolicy.renterFeeBasisPoints).toBe(800);

    // And the category itself has genuinely moved on, so the assertion above is
    // about the pin rather than about a reconfiguration that did not happen.
    expect(
      (await categories.findBySlug(category.slug))?.feePolicy.renterFeeBasisPoints,
    ).toBe(1_600);
  });
});
