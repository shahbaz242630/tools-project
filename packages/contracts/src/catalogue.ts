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
 * Whether this category's activity is reportable to HMRC — the one piece of
 * category configuration that can change the platform's regulatory status.
 *
 * BRD §8.14.1: under the UK digital platform reporting rules a Relevant Activity
 * is only the sale of goods or a Relevant Service, and a Relevant Service is only
 * rental of immovable property, a Personal Service, or rental of a **means of
 * transport**. Rental of general goods is none of those, so the launch category
 * is `none` and the platform is not a Reporting Platform Operator.
 *
 * §8.14.2 is why this is a field rather than a conclusion: because the engine is
 * category-agnostic, that scope can change **by configuration rather than by a
 * deploy**. A trailer, a van, an e-bike, a mobility scooter or anything
 * labour-based drags us into seller tax-data collection, verification and an
 * annual return, and nothing about adding a category would otherwise say so.
 *
 * The values name the *statutory head* rather than a yes/no, because the
 * collected fields and the deadline differ between them, and a boolean would
 * have to be widened later by a migration on rows that already matter.
 */
export const CATEGORY_REPORTABLE_ACTIVITIES = [
  'none',
  'means_of_transport',
  'personal_service',
  'sale_of_goods',
] as const;
export type CategoryReportableActivity =
  (typeof CATEGORY_REPORTABLE_ACTIVITIES)[number];

export const categoryReportableActivitySchema = z.enum(CATEGORY_REPORTABLE_ACTIVITIES);

/**
 * The single place that decides whether a flag value switches reporting on.
 *
 * One function rather than `!== 'none'` written in five places: the rule is
 * "anything but `none`" today, and if a value is ever added that does not
 * activate collection, every caller has to change at once or one of them
 * silently keeps the old meaning.
 */
export function activatesSellerReporting(
  activity: CategoryReportableActivity,
): boolean {
  return activity !== 'none';
}

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
 * The attribute vocabulary — four types, and that number is the design.
 *
 * ADR 0027. BRD §8.2 asks for "a JSON-schema-like set of required and optional
 * attributes"; BRD §14's Phase 2 exit gate requires a listing to render its
 * category's fields **without a frontend change per field**. Those only hold
 * together if everything the vocabulary can express, some renderer can draw — so
 * the vocabulary is closed, and each type has exactly one input control, one
 * validator and one display form.
 *
 * Adding an attribute is configuration. Adding a *type* is a deploy, because a
 * type is a renderer. There is deliberately no `custom` or `json` escape hatch:
 * one would reintroduce everything ADR 0027 rejected while looking like a small
 * addition.
 *
 * `boolean` is absent on purpose — it is a `choice` with two options, and every
 * type here is a case every consumer must handle for as long as the platform
 * exists.
 */
export const CATEGORY_ATTRIBUTE_TYPES = [
  'text',
  'number',
  'choice',
  'choice-many',
] as const;
export type CategoryAttributeType = (typeof CATEGORY_ATTRIBUTE_TYPES)[number];

/**
 * A hard bound, not a policy.
 *
 * It exists so an administrator cannot store unbounded JSON or configure a page
 * nothing can render, and it sits far above the 3–6 the category research
 * recommends. The recommendation belongs in the interface as guidance; this
 * belongs in the validator as a limit. Confusing the two would turn a commercial
 * finding into a constraint nobody can lift without a deploy.
 */
export const MAX_CATEGORY_ATTRIBUTES = 12;

/**
 * What the research actually found: a mature UK hire operator with thousands of
 * products exposes three attributes per item. The form says so; nothing enforces
 * it.
 */
export const RECOMMENDED_MAX_CATEGORY_ATTRIBUTES = 6;

export const MAX_ATTRIBUTE_LABEL_LENGTH = 60;
export const MAX_ATTRIBUTE_UNIT_LENGTH = 12;
export const MAX_ATTRIBUTE_OPTIONS = 24;
export const MAX_ATTRIBUTE_OPTION_LABEL_LENGTH = 60;

/** The ceiling on what a `text` attribute may accept, not the value itself. */
export const MAX_ATTRIBUTE_TEXT_LENGTH = 200;

/** ADR 0027: values are integers scaled by this, so the scale is bounded too. */
export const MAX_ATTRIBUTE_DECIMAL_PLACES = 3;

/**
 * The stable identifier a listing's stored values are keyed by, and the one part
 * of an attribute that must not be edited casually.
 *
 * `snake_case` for the same reason the slug is strict: renaming it later orphans
 * every value already stored under the old key, and the failure shows up as a
 * field that has silently gone blank rather than as an error.
 */
export const attributeKeySchema = z
  .string()
  .trim()
  .min(2, 'must be at least 2 characters')
  .max(40)
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
    'must be lowercase words joined by single underscores, e.g. "power_source"',
  );

/** What the owner filling in a listing form reads. Renamed freely. */
const attributeLabelSchema = z
  .string()
  .trim()
  .min(2, 'must be at least 2 characters')
  .max(MAX_ATTRIBUTE_LABEL_LENGTH);

/**
 * One selectable option.
 *
 * `value` is stored on the listing and `label` is shown, split for the reason
 * every enumeration in this codebase is: the words on screen change, and a
 * stored value that changes with them takes every existing listing's meaning
 * with it.
 */
export const attributeOptionSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .max(40)
    .regex(
      /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
      'must be lowercase letters, digits, hyphens and underscores, e.g. "cordless"',
    ),
  label: z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .max(MAX_ATTRIBUTE_OPTION_LABEL_LENGTH),
});
export type AttributeOption = z.infer<typeof attributeOptionSchema>;

const attributeCore = {
  key: attributeKeySchema,
  label: attributeLabelSchema,
  /** Whether a listing must supply it. Enforced from slice 2.4, where values exist. */
  required: z.boolean(),
};

const textAttributeSchema = z.object({
  ...attributeCore,
  type: z.literal('text'),
  maxLength: z.number().int().min(1).max(MAX_ATTRIBUTE_TEXT_LENGTH),
});

/**
 * A quantity with a unit, stored as an integer scaled by `decimalPlaces`.
 *
 * 2.5 kg is `25` at one decimal place. Not because a weight is money, but
 * because `parseFloat` is banned for ADR 0002's reasons, Phase 3 will bucket
 * these into search facets, and a float that is harmless in a form field is not
 * harmless as a facet boundary.
 *
 * **`unit` means nothing to the system** — it is a display suffix. Anything that
 * needs to know an attribute *is* a weight, such as §8.3's transport-requirement
 * suggestion, must key off the attribute key rather than parse this string. A
 * closed unit vocabulary was rejected as a deploy for every `psi` and `dB` a
 * future category wants.
 *
 * No minimum or maximum: a bound constrains a value, and the validator that
 * would enforce one arrives in slice 2.4 with the first values to enforce
 * against. Two numbers nothing reads are indistinguishable from a bound that has
 * stopped working.
 */
const numberAttributeSchema = z.object({
  ...attributeCore,
  type: z.literal('number'),
  unit: z.string().trim().min(1, 'must not be empty').max(MAX_ATTRIBUTE_UNIT_LENGTH),
  decimalPlaces: z.number().int().min(0).max(MAX_ATTRIBUTE_DECIMAL_PLACES),
});

/**
 * Exactly one of several — a select.
 *
 * At least **two** options, unlike `choice-many`. A select offering one answer
 * asks a question that has already been answered, which is a field that should
 * not exist rather than a field an owner should have to tick past.
 */
const choiceAttributeSchema = z.object({
  ...attributeCore,
  type: z.literal('choice'),
  options: z
    .array(attributeOptionSchema)
    .min(2, 'a single-answer question needs at least two options')
    .max(MAX_ATTRIBUTE_OPTIONS),
});

/**
 * Any number of several — a checkbox group.
 *
 * One option is legitimate here and is the honest form of the `boolean` this
 * vocabulary deliberately lacks: "chain guard included", ticked or not.
 */
const choiceManyAttributeSchema = z.object({
  ...attributeCore,
  type: z.literal('choice-many'),
  options: z
    .array(attributeOptionSchema)
    .min(1, 'must offer at least one option')
    .max(MAX_ATTRIBUTE_OPTIONS),
});

/**
 * One attribute definition.
 *
 * The cross-field rule lives here rather than on the individual object schemas
 * because a `.refine`d member stops being a plain object schema and
 * `discriminatedUnion` can no longer discriminate on it.
 */
export const categoryAttributeSchema = z
  .discriminatedUnion('type', [
    textAttributeSchema,
    numberAttributeSchema,
    choiceAttributeSchema,
    choiceManyAttributeSchema,
  ])
  .superRefine((attribute, ctx) => {
    if (attribute.type !== 'choice' && attribute.type !== 'choice-many') return;

    const seen = new Set<string>();
    attribute.options.forEach((option, index) => {
      if (seen.has(option.value)) {
        // Two options with one stored value means a listing can hold a value
        // whose label is ambiguous, and no later code could tell which was meant.
        ctx.addIssue({
          code: 'custom',
          message: `duplicate option value "${option.value}"`,
          path: ['options', index, 'value'],
        });
      }
      seen.add(option.value);
    });
  });

export type CategoryAttribute = z.infer<typeof categoryAttributeSchema>;

/**
 * A category's whole attribute schema, in render order.
 *
 * Order is meaningful and is preserved everywhere — it is the order the fields
 * appear in on a listing form, and the audit digest keeps array order for
 * exactly this reason (ADR 0017). Reordering is therefore a real configuration
 * change and mints a version.
 */
export const categoryAttributesSchema = z
  .array(categoryAttributeSchema)
  .max(
    MAX_CATEGORY_ATTRIBUTES,
    `must be at most ${String(MAX_CATEGORY_ATTRIBUTES)} attributes`,
  )
  .superRefine((attributes, ctx) => {
    const seen = new Set<string>();
    attributes.forEach((attribute, index) => {
      if (seen.has(attribute.key)) {
        // A listing keys its values by attribute key. Two definitions sharing
        // one key means one of them can never hold a value.
        ctx.addIssue({
          code: 'custom',
          message: `duplicate attribute key "${attribute.key}"`,
          path: [index, 'key'],
        });
      }
      seen.add(attribute.key);
    });
  });

export function parseCategoryAttributes(raw: unknown): readonly CategoryAttribute[] {
  return parseWith(categoryAttributesSchema, 'The attribute schema', raw);
}

/**
 * The confirmation §8.14.2 requires — *"the admin interface must warn on
 * category creation that a non-`none` flag triggers statutory reporting duties,
 * registration and an annual deadline, and must require explicit
 * confirmation"* — expressed where it cannot be walked around.
 *
 * **It is a field on the request, not a tick box on a page.** A confirmation
 * that lives only in the form is a confirmation the API does not have: anything
 * else holding an admin token could set the flag that changes our regulatory
 * status without ever meeting it. Making it a required assertion means the
 * server refuses, and the form is then merely the thing that explains why.
 *
 * **It is not stored.** It is true of a request, not of a category — every
 * saved version with a non-`none` flag was necessarily acknowledged, so a
 * column would record a constant. What survives is the audit entry: who set the
 * flag, to what, and the reason they typed.
 *
 * The wording names counsel deliberately. §8.14.2 requires scope determination
 * to be confirmed by counsel *before* a non-`none` category is enabled, and a
 * confirmation that says only "I understand" is one somebody can honestly tick
 * without that having happened.
 */
const reportingConfiguration = {
  reportableActivity: categoryReportableActivitySchema,
  reportingDutiesAcknowledged: z.boolean(),
};

function requireReportingAcknowledgement(
  value: {
    readonly reportableActivity: CategoryReportableActivity;
    readonly reportingDutiesAcknowledged: boolean;
  },
  ctx: z.RefinementCtx,
): void {
  if (!activatesSellerReporting(value.reportableActivity)) return;
  if (value.reportingDutiesAcknowledged) return;

  ctx.addIssue({
    code: 'custom',
    message:
      `a category flagged "${value.reportableActivity}" activates seller ` +
      'tax-data collection, verification and an annual return — confirm that ' +
      'counsel has determined the scope before enabling it',
    path: ['reportingDutiesAcknowledged'],
  });
}

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
  /**
   * Which statutory reporting head this category's activity falls under, if any
   * (§8.14.2). `none` is what every category has until counsel says otherwise.
   */
  readonly reportableActivity: CategoryReportableActivity;
  /** In render order. Empty is a legitimate schema — it is what a pre-2.2 category has. */
  readonly attributes: readonly CategoryAttribute[];
  readonly versionNumber: number;
  /** ISO 8601 UTC. When this *version* was written, not when the category was. */
  readonly versionCreatedAt: string;
  /** ISO 8601 UTC. When the category first existed. */
  readonly createdAt: string;
}

/**
 * The read is validated with the same schema as the write.
 *
 * A stored schema carrying a type this build does not know is a category the
 * frontend cannot render, and the parse failing loudly is the right outcome —
 * the alternative is a listing form that silently omits a field an administrator
 * configured. Same argument as `asRiskLevel` throwing in the store.
 */
const adminCategorySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  riskLevel: categoryRiskLevelSchema,
  reportableActivity: categoryReportableActivitySchema,
  attributes: categoryAttributesSchema,
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
export const categoryDraftSchema = z
  .object({
    slug: categorySlugSchema,
    name: categoryNameSchema,
    riskLevel: categoryRiskLevelSchema,
    ...reportingConfiguration,
    attributes: categoryAttributesSchema,
  })
  .superRefine(requireReportingAcknowledgement);

/**
 * Readonly rather than the raw inference, so a caller holding a schema it has
 * already validated can pass it without copying. Zod infers a mutable array; a
 * mutable array is assignable to a readonly one, so `parseCategoryDraft` still
 * satisfies this exactly.
 */
export type CategoryDraftInput = Omit<
  z.infer<typeof categoryDraftSchema>,
  'attributes'
> & { readonly attributes: readonly CategoryAttribute[] };

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
 *
 * **`attributes` is required rather than optional, and omitting it clears the
 * schema.** That follows the replace semantics `PUT` already has, and it is the
 * lesson ADR 0025 paid for twice: an optional field is a silent default, and a
 * silent default on configuration every later booking is read under is the wrong
 * shape. A caller that forgets it gets a 400, not an empty schema.
 *
 * **`reportableActivity` is required here too, and the acknowledgement applies
 * to a change as much as to a creation.** §8.14.2 words the warning as being
 * "on category creation", but §17's risk register names the real danger as
 * *"reporting scope changing with a category switch"* — an existing category
 * flipped from `none` to `means_of_transport` is exactly the switch a
 * creation-only rule would let through unremarked.
 */
export const categoryConfigurationSchema = z
  .object({
    name: categoryNameSchema,
    riskLevel: categoryRiskLevelSchema,
    ...reportingConfiguration,
    attributes: categoryAttributesSchema,
  })
  .superRefine(requireReportingAcknowledgement);
export type CategoryConfigurationInput = Omit<
  z.infer<typeof categoryConfigurationSchema>,
  'attributes'
> & { readonly attributes: readonly CategoryAttribute[] };

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
