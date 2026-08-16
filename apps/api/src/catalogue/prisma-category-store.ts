import type { PrismaClient } from '@platform/database';
import type {
  CategoryAttribute,
  CategoryFeePolicy,
  CategoryReportableActivity,
  CategoryRiskLevel,
  CategoryTransportOption,
} from '@platform/contracts';
import {
  CATEGORY_REPORTABLE_ACTIVITIES,
  CATEGORY_RISK_LEVELS,
  parseCategoryAttributes,
  parseCategoryTransportOptions,
} from '@platform/contracts';
import { Money } from '@platform/core';
import { CategorySlugTakenError } from './category-store.js';
import type {
  CategoryConfiguration,
  CategoryRecord,
  CategoryStore,
} from './category-store.js';

/**
 * Postgres-backed categories.
 *
 * There is no `update` anywhere in this file against `categoryVersion`, and
 * there cannot usefully be: a trigger refuses it. What looks like an edit is
 * always an insert of the next version.
 *
 * "Current configuration" is the highest `versionNumber` for a category. That
 * is a `take: 1` against the unique index on `(categoryId, versionNumber)`,
 * which a btree serves backwards — so it costs a seek rather than a scan, and
 * there is no pointer column that can disagree with the rows.
 */
export class PrismaCategoryStore implements CategoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    input: CategoryConfiguration & { readonly slug: string },
    authorId: string,
  ): Promise<CategoryRecord> {
    try {
      const category = await this.prisma.category.create({
        data: {
          slug: input.slug,
          versions: {
            // Created together, in the one statement Prisma turns into a
            // transaction. A category with no version has no configuration, and
            // every read below would have to handle a state that must not exist.
            create: {
              versionNumber: FIRST_VERSION,
              name: input.name,
              riskLevel: input.riskLevel,
              reportableActivity: input.reportableActivity,
              // Prisma's Json input type does not accept a readonly array, and
              // the spread is the cheapest honest way to hand it a mutable copy
              // rather than widening the port's type to suit the ORM.
              attributes: [...input.attributes],
              transportOptions: [...input.transportOptions],
              ...feePolicyColumns(input.feePolicy),
              maximumRentalDays: input.maximumRentalDays,
              createdById: authorId,
            },
          },
        },
        include: { versions: LATEST_VERSION },
      });

      return toRecord(category);
    } catch (error) {
      // P2002 is the unique violation. Translated here rather than at the route,
      // because the Prisma error code is exactly the sort of provider detail the
      // adapter exists to keep from leaking upward.
      if (isUniqueViolation(error)) throw new CategorySlugTakenError(input.slug);
      throw error;
    }
  }

  async addVersion(
    slug: string,
    configuration: CategoryConfiguration,
    authorId: string,
  ): Promise<CategoryRecord | null> {
    const existing = await this.prisma.category.findUnique({
      where: { slug },
      include: { versions: LATEST_VERSION },
    });
    if (existing === null) return null;

    const current = existing.versions[0];
    // Unreachable while `create` writes both rows together, which is the only
    // path that makes a category. Guarding rather than asserting, because the
    // alternative is a crash reading `undefined.versionNumber` if that ever
    // stops being true.
    if (current === undefined) return null;

    const version = await this.prisma.categoryVersion.create({
      data: {
        categoryId: existing.id,
        // Computed from what was read, then written under a unique constraint.
        // Two administrators saving at once compute the same number and the
        // second insert fails, which is the intended outcome — it surfaces as a
        // conflict rather than as one edit silently disappearing.
        versionNumber: current.versionNumber + 1,
        name: configuration.name,
        riskLevel: configuration.riskLevel,
        reportableActivity: configuration.reportableActivity,
        attributes: [...configuration.attributes],
        transportOptions: [...configuration.transportOptions],
        ...feePolicyColumns(configuration.feePolicy),
        maximumRentalDays: configuration.maximumRentalDays,
        createdById: authorId,
      },
    });

    return {
      id: existing.id,
      slug: existing.slug,
      name: version.name,
      riskLevel: asRiskLevel(version.riskLevel),
      reportableActivity: asReportableActivity(version.reportableActivity),
      attributes: asAttributes(version.attributes, existing.slug),
      transportOptions: asTransportOptions(version.transportOptions, existing.slug),
      feePolicy: asFeePolicy(version, existing.slug),
      maximumRentalDays: version.maximumRentalDays,
      versionNumber: version.versionNumber,
      versionCreatedAt: version.createdAt,
      createdAt: existing.createdAt,
    };
  }

  async list(limit: number): Promise<readonly CategoryRecord[]> {
    const categories = await this.prisma.category.findMany({
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { versions: LATEST_VERSION },
    });

    return categories.map(toRecord);
  }

  async findBySlug(slug: string): Promise<CategoryRecord | null> {
    const category = await this.prisma.category.findUnique({
      where: { slug },
      include: { versions: LATEST_VERSION },
    });

    return category === null ? null : toRecord(category);
  }
}

const FIRST_VERSION = 1;

/** The current configuration: highest version number, one row. */
const LATEST_VERSION = { orderBy: { versionNumber: 'desc' }, take: 1 } as const;

interface CategoryRow {
  id: string;
  slug: string;
  createdAt: Date;
  versions: readonly {
    name: string;
    riskLevel: string;
    reportableActivity: string;
    attributes: unknown;
    transportOptions: unknown;
    ownerCommissionBasisPoints: number;
    renterFeeBasisPoints: number;
    minimumBookingTotalAmount: number;
    minimumBookingTotalCurrency: string;
    minimumPlatformFeeAmount: number;
    minimumPlatformFeeCurrency: string;
    maximumRentalDays: number;
    versionNumber: number;
    createdAt: Date;
  }[];
}

function toRecord(category: CategoryRow): CategoryRecord {
  const current = category.versions[0];
  if (current === undefined) {
    // Not a defensive default. A category without a version means the
    // transaction in `create` was defeated somehow, and serving it as though it
    // were configured would hand a listing form a category with no rules.
    throw new Error(`Category ${category.slug} has no configuration version`);
  }

  return {
    id: category.id,
    slug: category.slug,
    name: current.name,
    riskLevel: asRiskLevel(current.riskLevel),
    reportableActivity: asReportableActivity(current.reportableActivity),
    attributes: asAttributes(current.attributes, category.slug),
    transportOptions: asTransportOptions(current.transportOptions, category.slug),
    feePolicy: asFeePolicy(current, category.slug),
    maximumRentalDays: current.maximumRentalDays,
    versionNumber: current.versionNumber,
    versionCreatedAt: current.createdAt,
    createdAt: category.createdAt,
  };
}

/**
 * The fee policy, flattened into the six columns that hold it.
 *
 * One function rather than six properties written at each of the two call
 * sites, because `create` and `addVersion` must agree exactly: a policy written
 * one way on creation and another on reconfiguration would produce categories
 * whose price depends on which route last touched them, and nothing would
 * report it.
 */
function feePolicyColumns(policy: CategoryFeePolicy) {
  return {
    ownerCommissionBasisPoints: policy.ownerCommissionBasisPoints,
    renterFeeBasisPoints: policy.renterFeeBasisPoints,
    minimumBookingTotalAmount: policy.minimumBookingTotal.amount,
    minimumBookingTotalCurrency: policy.minimumBookingTotal.currency,
    minimumPlatformFeeAmount: policy.minimumPlatformFee.amount,
    minimumPlatformFeeCurrency: policy.minimumPlatformFee.currency,
  };
}

/**
 * The six columns, on the way back out.
 *
 * **The currency gets `asRiskLevel`'s treatment rather than a cast**, and the
 * reason is the one ADR 0002 keeps making: a currency code this build cannot do
 * arithmetic in is not a display problem, it is an amount nothing can add up.
 * `Money`'s operations refuse a mismatched pair, so a row carrying an unknown
 * code would fail somewhere deep in a fee calculation with a message about
 * currencies rather than about a category — if it failed at all. Naming the
 * category here is the only useful question.
 *
 * The numbers themselves are not re-validated against the contract's bounds.
 * Three CHECK constraints already hold them, so a row outside those bounds is
 * not a row this adapter can be handed — and re-asserting them here would be a
 * second copy of a rule that lives in two places already.
 */
function asFeePolicy(
  version: {
    ownerCommissionBasisPoints: number;
    renterFeeBasisPoints: number;
    minimumBookingTotalAmount: number;
    minimumBookingTotalCurrency: string;
    minimumPlatformFeeAmount: number;
    minimumPlatformFeeCurrency: string;
  },
  slug: string,
): CategoryFeePolicy {
  return {
    ownerCommissionBasisPoints: version.ownerCommissionBasisPoints,
    renterFeeBasisPoints: version.renterFeeBasisPoints,
    minimumBookingTotal: {
      amount: version.minimumBookingTotalAmount,
      currency: asCurrency(version.minimumBookingTotalCurrency, slug),
    },
    minimumPlatformFee: {
      amount: version.minimumPlatformFeeAmount,
      currency: asCurrency(version.minimumPlatformFeeCurrency, slug),
    },
  };
}

function asCurrency(value: string, slug: string): Money.CurrencyCode {
  if ((Money.SUPPORTED_CURRENCIES as readonly string[]).includes(value)) {
    return value as Money.CurrencyCode;
  }
  throw new Error(
    `Category ${slug} has a fee policy in a currency this build cannot do arithmetic in: ${value}`,
  );
}

/**
 * The column is `jsonb`, so this is where JSON becomes a schema.
 *
 * Postgres guarantees the value is JSON and nothing more — a CHECK constraint
 * that tried to validate the vocabulary would be a second copy of something that
 * lives in `@platform/contracts` and changes with a deploy (ADR 0027).
 *
 * Throws rather than falling back to an empty schema, for `asRiskLevel`'s
 * reason. A schema this build cannot parse means the row was written by a newer
 * version of the application, and quietly reading it as "no attributes" would
 * hand a listing form a category whose required fields have silently vanished —
 * and a listing saved through that form would be missing data nobody asked for.
 * Failing names the category, because that is the only useful question.
 */
function asAttributes(value: unknown, slug: string): readonly CategoryAttribute[] {
  try {
    return parseCategoryAttributes(value);
  } catch (error) {
    throw new Error(
      `Category ${slug} has an attribute schema this build cannot read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      // The contract violation carries the field-level issues. Losing it would
      // leave a log line saying a schema is unreadable and not which part.
      { cause: error },
    );
  }
}

/**
 * The transport selection, on the way out of `jsonb`.
 *
 * Throws for `asAttributes`' reason, and here the failure is quieter and so
 * worth more. A selection this build cannot read means the row was written by a
 * newer application, and falling back to an empty list would present the
 * category as offering **no** transport options at all — a listing form that
 * silently stops asking how an item is collected, which is precisely the failed
 * handover §8.3 exists to prevent. There would be nothing on screen to suggest
 * anything was missing.
 */
function asTransportOptions(
  value: unknown,
  slug: string,
): readonly CategoryTransportOption[] {
  try {
    return parseCategoryTransportOptions(value);
  } catch (error) {
    throw new Error(
      `Category ${slug} has transport options this build cannot read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * The column is `TEXT` with a closed union in code, so this is where the two
 * meet.
 *
 * Throws rather than falling back to a default. A row holding a level this
 * build does not know about means the database was written by a newer version
 * of the application, and quietly reading it as `low` would understate the
 * handling requirements of an item — which is the wrong direction to be wrong in
 * for something that will drive deposits and verification.
 */
function asRiskLevel(value: string): CategoryRiskLevel {
  if ((CATEGORY_RISK_LEVELS as readonly string[]).includes(value)) {
    return value as CategoryRiskLevel;
  }
  throw new Error(`Unknown category risk level in the database: ${value}`);
}

/**
 * The same treatment `riskLevel` gets, and here the argument is stronger.
 *
 * A row holding a head this build does not know means the database was written
 * by a newer version of the application. Falling back to `none` would read an
 * in-scope category as out of scope — silently answering "no statutory
 * obligation" on the strength of not recognising a word — and the failure would
 * surface as a missing annual return rather than as an error. Throwing is the
 * only safe direction to be wrong in.
 */
function asReportableActivity(value: string): CategoryReportableActivity {
  if ((CATEGORY_REPORTABLE_ACTIVITIES as readonly string[]).includes(value)) {
    return value as CategoryReportableActivity;
  }
  throw new Error(`Unknown category reportable activity in the database: ${value}`);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}
