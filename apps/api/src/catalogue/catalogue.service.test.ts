import { beforeEach, describe, expect, it } from 'vitest';
import type { CategoryAttribute, CategoryTransportOption } from '@platform/contracts';
import { CategorySlugTakenError } from './category-store.js';
import { CategoryMarginError } from './catalogue.service.js';
import { createCatalogueFakes } from './testing/fakes.js';
import type { CatalogueFakes } from './testing/fakes.js';
import type { Actor } from '../audit/audit-log.js';
import {
  DEFAULT_MAXIMUM_RENTAL_DAYS,
  DEFAULT_REQUEST_EXPIRY_HOURS,
} from '@platform/contracts';

const ADMIN: Actor = {
  userId: '00000000-0000-4000-8000-00000000000a',
  ipAddress: '203.0.113.7',
  sessionId: 'sess_admin',
};

const REASON = 'Opening the launch category';

let fakes: CatalogueFakes;

beforeEach(() => {
  fakes = createCatalogueFakes();
});

/**
 * A priced category, at the launch rates decided on 7 August: 15% owner
 * commission, 8% renter fee (BRD §3.4's mid-band).
 *
 * A fixture with real rates rather than zeroes, because zero is the *default* a
 * category carries when nobody has priced it — and a test suite where every
 * category is unpriced would never notice a path that silently dropped the
 * policy on the way to the store.
 */
const FEE_POLICY = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' },
  minimumPlatformFee: { amount: 200, currency: 'GBP' },
} as const;
/**
 * A real band rather than `null`, for `FEE_POLICY`'s reason applied to §8.7.2:
 * `null` is what a category carries when nobody has configured damage security,
 * so a suite where every fixture is null would never notice a path that silently
 * dropped the band on the way to the store. Tests that mean "no security" say so
 * locally.
 */
const DAMAGE_SECURITY = {
  excessFloor: { amount: 7_500, currency: 'GBP' },
  excessPercentageBasisPoints: 1_500,
  recoveryCeiling: { amount: 50_000, currency: 'GBP' },
} as const;

const draft = {
  slug: 'outdoor-gardening',
  name: 'Outdoor and gardening',
  riskLevel: 'low',
  // The launch category's real value. §8.14.1 concluded rental of general goods
  // is not a Relevant Activity, and a fixture that said otherwise would make
  // every test here describe a platform we are not.
  reportableActivity: 'none',
  attributes: [],
  transportOptions: [],
  feePolicy: FEE_POLICY,
  damageSecurity: DAMAGE_SECURITY,
  maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
  requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
} as const;

/**
 * A schema with one of each shape that has a cross-field rule, so the digest
 * tests are exercising something with structure rather than a flat object.
 */
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
];

/**
 * What the launch category would offer for collection (§8.3, ADR 0031).
 *
 * Already in display order and with increasing thresholds, because the contract
 * normalises and checks both before anything reaches this service — these tests
 * are about what the *service* does with a valid selection, which is carry it
 * and digest it.
 */
const TRANSPORT: readonly CategoryTransportOption[] = [
  { requirement: 'car_boot', suggestedUpToKg: 25 },
  { requirement: 'van_required', suggestedUpToKg: 150 },
];

describe('creating a category', () => {
  it('starts at version 1 and returns the configuration in force', async () => {
    const created = await fakes.service.create(ADMIN, draft, REASON);

    expect(created.slug).toBe('outdoor-gardening');
    expect(created.name).toBe('Outdoor and gardening');
    expect(created.riskLevel).toBe('low');
    expect(created.versionNumber).toBe(1);
  });

  it('records who created it and why', async () => {
    const created = await fakes.service.create(ADMIN, draft, REASON);

    const entries = fakes.audit.log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('category.created');
    expect(entries[0]?.targetType).toBe('category');
    expect(entries[0]?.targetId).toBe(created.id);
    expect(entries[0]?.actorId).toBe(ADMIN.userId);
    expect(entries[0]?.reason).toBe(REASON);
    expect(entries[0]?.sessionId).toBe('sess_admin');
  });

  it('has no before-state, because there was no previous configuration', async () => {
    await fakes.service.create(ADMIN, draft, REASON);

    // Null rather than a digest of an empty object: digesting one would claim a
    // prior version existed, and the trail would read as an edit.
    expect(fakes.audit.log.entries()[0]?.beforeHash).toBeNull();
    expect(fakes.audit.log.entries()[0]?.afterHash).not.toBeNull();
  });

  it('refuses a slug that is already taken', async () => {
    await fakes.service.create(ADMIN, draft, REASON);

    await expect(
      fakes.service.create(ADMIN, { ...draft, name: 'Something else' }, REASON),
    ).rejects.toBeInstanceOf(CategorySlugTakenError);
  });

  it('writes no audit entry when the create is refused', async () => {
    await fakes.service.create(ADMIN, draft, REASON);
    await expect(fakes.service.create(ADMIN, draft, REASON)).rejects.toThrow();

    // One entry, from the first create. An entry for a change that did not
    // happen is worse than none — it is a trail that disagrees with the data.
    expect(fakes.audit.log.entries()).toHaveLength(1);
  });

  it('fails the create when the audit write fails', async () => {
    // ADR 0017's fail-closed rule, and it matters more here than usual: these
    // rows are what every later booking is interpreted under, so a
    // configuration change nobody can attribute is not an acceptable outcome.
    fakes.audit.log.failNextRecord(new Error('audit unavailable'));

    await expect(fakes.service.create(ADMIN, draft, REASON)).rejects.toThrow(
      'audit unavailable',
    );
  });
});

describe('reconfiguring a category', () => {
  beforeEach(async () => {
    await fakes.service.create(ADMIN, draft, REASON);
  });

  it('appends a version rather than changing the existing one', async () => {
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: 'Garden and outdoor',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Renamed after the taxonomy review',
    );

    const versions = fakes.store.versionsOf('outdoor-gardening');
    expect(versions).toHaveLength(2);
    // The first version still says exactly what it said. This is the property a
    // booking created under it depends on.
    expect(versions[0]?.name).toBe('Outdoor and gardening');
    expect(versions[0]?.riskLevel).toBe('low');
    expect(versions[1]?.name).toBe('Garden and outdoor');
    expect(versions[1]?.riskLevel).toBe('medium');
  });

  it('reads back the newest version', async () => {
    const updated = await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: 'Garden and outdoor',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Renamed after the taxonomy review',
    );

    expect(updated?.versionNumber).toBe(2);
    expect(updated?.name).toBe('Garden and outdoor');
    expect((await fakes.service.findBySlug('outdoor-gardening'))?.versionNumber).toBe(
      2,
    );
  });

  it('keeps the slug, because it is the identity', async () => {
    const updated = await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: 'Something completely different',
        riskLevel: 'high',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Testing that the slug is stable',
    );

    // There is no route that can change it — the contract has no such field —
    // so this pins that renaming does not quietly move the URL either.
    expect(updated?.slug).toBe('outdoor-gardening');
  });

  it('records both sides of the change', async () => {
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: 'Garden and outdoor',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Renamed after the taxonomy review',
    );

    const entry = fakes.audit.log.entries()[1];
    expect(entry?.action).toBe('category.reconfigured');
    expect(entry?.reason).toBe('Renamed after the taxonomy review');
    expect(entry?.beforeHash).not.toBeNull();
    expect(entry?.afterHash).not.toBeNull();
    // Different, because the configuration actually changed. If these matched,
    // comparing digests would be telling us nothing.
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('digests the configuration and not the timestamps', async () => {
    // Saving the same values again must produce equal digests. Including
    // `versionNumber` or `createdAt` would make every entry differ from the
    // last whether or not anything meaningful changed, which destroys the only
    // thing comparing digests is for.
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: 'Outdoor and gardening',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Saving the identical configuration again',
    );

    const entry = fakes.audit.log.entries()[1];
    expect(entry?.beforeHash).toBe(entry?.afterHash);
  });

  it('answers null for a category that does not exist', async () => {
    const missing = await fakes.service.reconfigure(
      ADMIN,
      'no-such-category',
      {
        name: 'Nothing',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Should not be possible',
    );

    expect(missing).toBeNull();
    // No entry: nothing changed, so there is nothing to record.
    expect(fakes.audit.log.entries()).toHaveLength(1);
  });
});

describe('reading categories', () => {
  it('lists them oldest first with their current configuration', async () => {
    await fakes.service.create(ADMIN, draft, REASON);
    await fakes.service.create(
      ADMIN,
      {
        slug: 'cleaning-floorcare',
        name: 'Cleaning',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      REASON,
    );
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: 'Garden and outdoor',
        riskLevel: 'medium',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Renamed after the taxonomy review',
    );

    const listed = await fakes.service.list();
    expect(listed.map((category) => category.slug)).toEqual([
      'outdoor-gardening',
      'cleaning-floorcare',
    ]);
    expect(listed[0]?.name).toBe('Garden and outdoor');
    expect(listed[0]?.versionNumber).toBe(2);
  });

  it('does not audit a read', async () => {
    await fakes.service.create(ADMIN, draft, REASON);
    await fakes.service.list();
    await fakes.service.findBySlug('outdoor-gardening');

    // Only the create. A category has no subject to owe an explanation to, and
    // auditing every list would bury the disclosures that do (ADR 0021).
    expect(fakes.audit.log.entries()).toHaveLength(1);
  });

  it('answers null for an unknown slug', async () => {
    expect(await fakes.service.findBySlug('no-such-category')).toBeNull();
  });
});

describe('the attribute schema', () => {
  it('is returned with the configuration in force', async () => {
    const created = await fakes.service.create(
      ADMIN,
      { ...draft, attributes: SCHEMA },
      REASON,
    );

    expect(created.attributes).toEqual(SCHEMA);
  });

  it('leaves the previous version saying exactly what it said', async () => {
    // The property a listing created under version 1 depends on. Without it,
    // adding a required attribute would retroactively make old listings invalid.
    await fakes.service.create(ADMIN, { ...draft, attributes: SCHEMA }, REASON);
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: 'Outdoor and gardening',
        riskLevel: 'low',
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Clearing the schema',
    );

    const versions = fakes.store.versionsOf('outdoor-gardening');
    expect(versions[0]?.attributes).toEqual(SCHEMA);
    expect(versions[1]?.attributes).toEqual([]);
  });

  it('registers as a change in the audit digest', async () => {
    await fakes.service.create(ADMIN, draft, REASON);
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: draft.name,
        riskLevel: draft.riskLevel,
        reportableActivity: 'none',
        attributes: SCHEMA,
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Adding the attribute schema',
    );

    const entry = fakes.audit.log.entries()[1];
    // Name and risk level are untouched, so if the schema were left out of
    // `auditable` these two would match and the trail would record nothing.
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('registers a reorder as a change', async () => {
    // ADR 0027: order is the render order, and `canonicalise` preserves array
    // order deliberately (ADR 0017). A reorder that left no trace would be the
    // one configuration change nobody could account for afterwards.
    await fakes.service.create(ADMIN, { ...draft, attributes: SCHEMA }, REASON);
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: draft.name,
        riskLevel: draft.riskLevel,
        reportableActivity: draft.reportableActivity,
        attributes: [...SCHEMA].reverse(),
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Putting weight first',
    );

    const entry = fakes.audit.log.entries()[1];
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('digests an unchanged schema identically', async () => {
    await fakes.service.create(ADMIN, { ...draft, attributes: SCHEMA }, REASON);
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: draft.name,
        riskLevel: draft.riskLevel,
        reportableActivity: 'none',
        attributes: SCHEMA,
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Saving the identical configuration again',
    );

    const entry = fakes.audit.log.entries()[1];
    expect(entry?.beforeHash).toBe(entry?.afterHash);
  });
});

describe('the transport options', () => {
  it('are returned with the configuration in force', async () => {
    const created = await fakes.service.create(
      ADMIN,
      { ...draft, transportOptions: TRANSPORT },
      REASON,
    );

    expect(created.transportOptions).toEqual(TRANSPORT);
  });

  it('leave the previous version offering exactly what it offered', async () => {
    // The property that makes withdrawing an option safe. A listing created
    // under version 1 said "car boot" against a category that offered it, and
    // that must stay true after the category stops offering it.
    await fakes.service.create(
      ADMIN,
      { ...draft, transportOptions: TRANSPORT },
      REASON,
    );
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: draft.name,
        riskLevel: draft.riskLevel,
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [],
      },
      'Withdrawing the transport options',
    );

    const versions = fakes.store.versionsOf('outdoor-gardening');
    expect(versions[0]?.transportOptions).toEqual(TRANSPORT);
    expect(versions[1]?.transportOptions).toEqual([]);
  });

  it('register as a change in the audit digest', async () => {
    await fakes.service.create(ADMIN, draft, REASON);
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: draft.name,
        riskLevel: draft.riskLevel,
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: TRANSPORT,
      },
      'Offering transport options for the first time',
    );

    const entry = fakes.audit.log.entries()[1];
    // Everything else is untouched, so if the options were left out of
    // `auditable` these two would match and offering a new option would leave
    // no trace at all.
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('register a changed threshold as a change, though nothing is added or removed', async () => {
    // The quiet one. The same two options are offered before and after; only
    // the weight at which the form suggests one has moved. That changes what
    // owners are nudged to say about collection, so it is a configuration
    // decision somebody should be accountable for.
    await fakes.service.create(
      ADMIN,
      { ...draft, transportOptions: TRANSPORT },
      REASON,
    );
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: draft.name,
        riskLevel: draft.riskLevel,
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: [
          { requirement: 'car_boot', suggestedUpToKg: 40 },
          { requirement: 'van_required', suggestedUpToKg: 150 },
        ],
      },
      'Raising the car boot threshold',
    );

    const entry = fakes.audit.log.entries()[1];
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('digest an unchanged selection identically', async () => {
    await fakes.service.create(
      ADMIN,
      { ...draft, transportOptions: TRANSPORT },
      REASON,
    );
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      {
        name: draft.name,
        riskLevel: draft.riskLevel,
        reportableActivity: 'none',
        attributes: [],
        feePolicy: FEE_POLICY,
        damageSecurity: DAMAGE_SECURITY,
        maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
        requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
        transportOptions: TRANSPORT,
      },
      'Saving the identical configuration again',
    );

    const entry = fakes.audit.log.entries()[1];
    expect(entry?.beforeHash).toBe(entry?.afterHash);
  });
});

/**
 * BRD §3.4.3's binding clause, asked by the service (slice 5.3b).
 *
 * **The rule itself is `pricing/`'s and is proved there** — `margin-rule.test.ts`
 * covers the arithmetic against the rates the two launch categories actually
 * carry. What these prove is that the *service* asks it, on both paths, and
 * refuses **before writing anything**: a category that reached the store and was
 * then complained about would be a configuration §3.4.3 forbids sitting in the
 * database, and `category_versions` is append-only, so nobody could remove it.
 */
describe('§3.4.3, the margin rule', () => {
  const losing = {
    ...draft.feePolicy,
    // £1, which is what both launch categories carried until 21 August 2026 and
    // what `unit-economics.mjs` found losing money at their floors.
    minimumPlatformFee: { amount: 100, currency: 'GBP' as const },
  };

  /**
   * The draft's configuration half, which `reconfigure` takes without the slug.
   *
   * `void slug` rather than a `_slug` binding: this config's `no-unused-vars`
   * has no ignore pattern for destructured names, and `delete` is refused
   * because `draft` is `as const`. Discarding it explicitly satisfies both.
   */
  const configuration = (): Omit<typeof draft, 'slug'> => {
    const { slug, ...rest } = draft;
    void slug;
    return rest;
  };

  it('refuses to create a category that loses money at its floor', async () => {
    await expect(
      fakes.service.create(ADMIN, { ...draft, feePolicy: losing }, REASON),
    ).rejects.toBeInstanceOf(CategoryMarginError);
  });

  it('writes nothing when it refuses a creation', async () => {
    await fakes.service
      .create(ADMIN, { ...draft, feePolicy: losing }, REASON)
      .catch(() => undefined);

    expect(await fakes.service.list()).toEqual([]);
  });

  it('says which figures to change', async () => {
    // An administrator refused with "invalid configuration" edits at random
    // until it saves. The sentence names the clause, the floor and the loss.
    const refusal = await fakes.service
      .create(ADMIN, { ...draft, feePolicy: losing }, REASON)
      .catch((error: unknown) => error);

    expect(String(refusal)).toMatch(/§3\.4\.3/);
    expect(String(refusal)).toMatch(/minimum booking total of £10\.00/);
  });

  it('refuses to reconfigure a category into losing money', async () => {
    await fakes.service.create(ADMIN, draft, REASON);

    await expect(
      fakes.service.reconfigure(
        ADMIN,
        'outdoor-gardening',
        { ...configuration(), feePolicy: losing },
        REASON,
      ),
    ).rejects.toBeInstanceOf(CategoryMarginError);
  });

  it('leaves the category on its previous version when it refuses', async () => {
    /*
     * **The version number is the assertion.** `category_versions` is immutable
     * and append-only, so a refused save that had already written would leave a
     * version nobody can delete — and the number is the only thing that makes
     * that visible.
     */
    await fakes.service.create(ADMIN, draft, REASON);

    await fakes.service
      .reconfigure(
        ADMIN,
        'outdoor-gardening',
        { ...configuration(), feePolicy: losing },
        REASON,
      )
      .catch(() => undefined);

    const after = await fakes.service.findBySlug('outdoor-gardening');
    expect(after?.versionNumber).toBe(1);
  });

  it('answers a missing slug before it judges the numbers', async () => {
    /*
     * Order matters. A slug nobody has is a 404, and a margin complaint for it
     * would send an administrator to fix figures on a category that does not
     * exist.
     */
    expect(
      await fakes.service.reconfigure(
        ADMIN,
        'no-such-category',
        { ...configuration(), feePolicy: losing },
        REASON,
      ),
    ).toBeNull();
  });
});
