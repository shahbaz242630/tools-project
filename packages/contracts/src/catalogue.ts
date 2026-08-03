/**
 * The catalogue's contract — categories and their versioned configuration.
 *
 * Its own file rather than part of `admin.ts`, even though every route here is
 * administrative today. The authority is the same; the *subject* is not. From
 * slice 2.10 a category is read by anyone with a browser, on a public listing
 * page that must be crawlable (§8.17), and a contract that grew up inside the
 * admin file would arrive at that slice already entangled with types nobody
 * outside an admin session may see.
 *
 * BRD §1.2 is the rule everything here serves: categories are **versioned
 * configuration, never code**. Nothing in this file names a category, a fee or a
 * risk threshold — only the shape one has.
 */

import { z } from 'zod';
import { parseWith } from './parse.js';

/**
 * How much care a category's items demand.
 *
 * A closed union in code rather than a database enum, exactly like
 * `AuditAction`: adding a level should be a reviewed edit to a vocabulary, not a
 * schema migration. This is not the "hard-coded status label" CLAUDE.md bans —
 * the *set* of levels is domain vocabulary, and which one a category carries is
 * configuration an administrator chooses.
 *
 * It does nothing yet. From §8.2 it drives deposit bands, minimum age,
 * verification requirements and prohibited items, and the launch shortlist in
 * `reference-category-taxonomy.md` is already sorted by it — hedge trimmers are
 * not breakers, and neither is a welder.
 */
export const CATEGORY_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type CategoryRiskLevel = (typeof CATEGORY_RISK_LEVELS)[number];

export const categoryRiskLevelSchema = z.enum(CATEGORY_RISK_LEVELS);

/**
 * The URL segment, and the SEO identity §8.17 needs to keep canonical.
 *
 * Lowercase, digits and single hyphens. Deliberately strict: a slug is the one
 * part of a category that must never change, because changing it breaks every
 * link and every indexed page pointing at it. Validating it loosely now means
 * inheriting whatever an administrator typed for as long as the category exists.
 *
 * Bounded at both ends — a one-character slug is not a URL anybody can read, and
 * the upper bound keeps it inside sensible URL limits with room for a listing
 * path after it.
 */
export const MIN_CATEGORY_SLUG_LENGTH = 2;
export const MAX_CATEGORY_SLUG_LENGTH = 64;

export const categorySlugSchema = z
  .string()
  .trim()
  .min(
    MIN_CATEGORY_SLUG_LENGTH,
    `must be at least ${MIN_CATEGORY_SLUG_LENGTH} characters`,
  )
  .max(MAX_CATEGORY_SLUG_LENGTH)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'must be lowercase letters, digits and single hyphens, e.g. "outdoor-gardening"',
  );

/** What an administrator reads and renames. Not the slug. */
export const MIN_CATEGORY_NAME_LENGTH = 2;
export const MAX_CATEGORY_NAME_LENGTH = 120;

export const categoryNameSchema = z
  .string()
  .trim()
  .min(
    MIN_CATEGORY_NAME_LENGTH,
    `must be at least ${MIN_CATEGORY_NAME_LENGTH} characters`,
  )
  .max(MAX_CATEGORY_NAME_LENGTH);

/**
 * A category as an administrator sees it: its identity, plus the configuration
 * currently in force.
 *
 * Flattened rather than nesting the version, because the caller almost always
 * wants "what is this category now" and a nested shape makes the common read
 * two hops deep for no gain. `versionNumber` is what says which snapshot these
 * values came from, and it is present precisely so a reader can tell that the
 * configuration has a history at all.
 */
export interface AdminCategory {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly riskLevel: CategoryRiskLevel;
  readonly versionNumber: number;
  /** ISO 8601 UTC. When this *version* was written, not when the category was. */
  readonly versionCreatedAt: string;
  /** ISO 8601 UTC. When the category first existed. */
  readonly createdAt: string;
}

const adminCategorySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  riskLevel: categoryRiskLevelSchema,
  versionNumber: z.number().int().positive(),
  versionCreatedAt: z.string(),
  createdAt: z.string(),
});

const adminCategoryListSchema = z.object({
  categories: z.array(adminCategorySchema),
});

export function parseAdminCategory(raw: unknown): AdminCategory {
  return parseWith(adminCategorySchema, 'The category response', raw);
}

export function parseAdminCategoryList(raw: unknown): {
  readonly categories: readonly AdminCategory[];
} {
  return parseWith(adminCategoryListSchema, 'The category list response', raw);
}

/**
 * Creating a category.
 *
 * The slug is supplied rather than derived from the name. Deriving it looks
 * friendlier and is a trap: renaming "Garden tools" to "Outdoor & gardening"
 * would either silently change the URL or silently stop matching it, and the
 * administrator would find out from a search console months later. Asking for
 * both once makes the permanence of one of them visible at the moment it is
 * chosen.
 */
export const categoryDraftSchema = z.object({
  slug: categorySlugSchema,
  name: categoryNameSchema,
  riskLevel: categoryRiskLevelSchema,
});
export type CategoryDraftInput = z.infer<typeof categoryDraftSchema>;

export function parseCategoryDraft(raw: unknown): CategoryDraftInput {
  return parseWith(categoryDraftSchema, 'The category', raw);
}

/**
 * Changing a category's configuration, which mints a new version.
 *
 * **There is no slug here, and its absence is the design.** The slug is the
 * category's identity; a route that could change it is a route that can break
 * every indexed URL pointing at the category, and no amount of confirmation
 * dialog makes that safe. If a slug is genuinely wrong, the answer is a new
 * category and a redirect, decided deliberately.
 */
export const categoryConfigurationSchema = z.object({
  name: categoryNameSchema,
  riskLevel: categoryRiskLevelSchema,
});
export type CategoryConfigurationInput = z.infer<typeof categoryConfigurationSchema>;

export function parseCategoryConfiguration(raw: unknown): CategoryConfigurationInput {
  return parseWith(categoryConfigurationSchema, 'The configuration', raw);
}

/** Where an administrator lists and creates categories. */
export const ADMIN_CATEGORIES_PATH = '/admin/categories';
export const ADMIN_CATEGORIES_ROUTE = '/admin/categories';

/** One category, addressed by the slug rather than the id — it is the identity. */
export function adminCategoryPath(slug: string): string {
  return `/admin/categories/${encodeURIComponent(slug)}`;
}

/** The Nest route pattern for the above. Kept beside it so the two cannot drift. */
export const ADMIN_CATEGORY_ROUTE = '/admin/categories/:slug';
