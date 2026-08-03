import type { PrismaClient } from '@platform/database';
import type { CategoryRiskLevel } from '@platform/contracts';
import { CATEGORY_RISK_LEVELS } from '@platform/contracts';
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
        createdById: authorId,
      },
    });

    return {
      id: existing.id,
      slug: existing.slug,
      name: version.name,
      riskLevel: asRiskLevel(version.riskLevel),
      versionNumber: version.versionNumber,
      versionCreatedAt: version.createdAt,
      createdAt: existing.createdAt,
    };
  }

  async list(): Promise<readonly CategoryRecord[]> {
    const categories = await this.prisma.category.findMany({
      orderBy: { createdAt: 'asc' },
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
    versionNumber: current.versionNumber,
    versionCreatedAt: current.createdAt,
    createdAt: category.createdAt,
  };
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}
