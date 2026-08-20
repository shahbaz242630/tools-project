import type {
  CategoryAttribute,
  CategoryFeePolicy,
  CategoryReportableActivity,
  CategoryRiskLevel,
  CategoryTransportOption,
} from '@platform/contracts';

/**
 * Categories and their configuration, as the rest of the application sees them.
 *
 * **There is no method that edits a version, and that absence is the design** —
 * the same argument `audit-log.ts` makes about its own missing update. §8.2
 * requires that "existing bookings retain the configuration version under which
 * they were created", which is only true if a version, once written, is a fact.
 * A port offering an edit is a port somebody eventually edits from, and the
 * booking that pinned that version would silently change meaning.
 *
 * The database says the same thing independently: a trigger refuses `UPDATE` on
 * `category_versions`. Two guarantees rather than one, because this one has to
 * survive somebody adding a method here in good faith.
 *
 * The Catalogue module reaches these rows only through this interface, the same
 * boundary rule that keeps Profiles out of `users` (BRD §5.1).
 */

/** A category and the configuration currently in force for it. */
export interface CategoryRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly riskLevel: CategoryRiskLevel;
  readonly reportableActivity: CategoryReportableActivity;
  readonly attributes: readonly CategoryAttribute[];
  /** Which transport requirements this category offers (§8.3, ADR 0031). */
  readonly transportOptions: readonly CategoryTransportOption[];
  /** What the platform charges on a booking in this category (§8.2, §3.4). */
  readonly feePolicy: CategoryFeePolicy;
  /** The longest hire this category permits, in local calendar days (§8.5.3). */
  readonly maximumRentalDays: number;
  /** How long an owner has to answer a request, in hours (§8.6, slice 4.5a). */
  readonly requestExpiryHours: number;
  readonly versionNumber: number;
  readonly versionCreatedAt: Date;
  readonly createdAt: Date;
}

/**
 * The configurable half — everything a new version can change.
 *
 * `attributes` is required, not optional. An optional field would let a caller
 * that forgot it silently clear a category's whole schema, which is the failure
 * ADR 0025 describes: an optional parameter is a silent default, and the silent
 * default here would rewrite the terms every later listing is filled in under.
 */
export interface CategoryConfiguration {
  readonly name: string;
  readonly riskLevel: CategoryRiskLevel;
  /**
   * Which statutory reporting head applies (§8.14.2), or `none`.
   *
   * **The acknowledgement that lets a non-`none` value be saved is not here**,
   * and its absence is deliberate. It is an assertion about a request, not a
   * property of a category — every stored version carrying a reportable head was
   * necessarily acknowledged, so a field here would record a constant. The
   * contract enforces it at the edge; the audit entry records who made the
   * change and why.
   */
  readonly reportableActivity: CategoryReportableActivity;
  readonly attributes: readonly CategoryAttribute[];
  /**
   * Which of the platform's transport requirements this category offers, and
   * the weight each is suggested up to (§8.3, ADR 0031).
   *
   * Required for `attributes`' reason, and the consequence of forgetting it is
   * the same shape: a category that offers none asks nothing about how an item
   * is collected, and §8.3 exists because that question going unasked is what
   * produces a failed handover.
   */
  readonly transportOptions: readonly CategoryTransportOption[];
  /**
   * What the platform charges on a booking in this category (§8.2, §3.4).
   *
   * Required for the same reason the two above are, and the consequence of
   * forgetting it is the most expensive of the three: a caller that omitted it
   * would mint a version charging nothing, and every booking made under that
   * version would earn the platform nothing — with no error, and nothing on
   * screen distinguishing it from a category deliberately priced at zero.
   */
  readonly feePolicy: CategoryFeePolicy;
  /**
   * The longest hire this category permits, in local calendar days (§8.5.3,
   * slice 4.4a).
   *
   * Required, for the same reason as the three above and with a different kind
   * of consequence: the others cost money if forgotten, and this one is a legal
   * bound. A silent default would have to be the *most permissive* value
   * available, so a caller that forgot it would get the longest hire the law
   * allows rather than the shortest — which is the wrong direction for a rule
   * about not arranging regulated credit.
   */
  readonly maximumRentalDays: number;
  /** How long an owner has to answer a request, in hours (§8.6, slice 4.5a). */
  readonly requestExpiryHours: number;
}

/**
 * Raised when a slug is already taken.
 *
 * Its own error rather than letting the unique violation surface, because the
 * caller has to tell these apart: a duplicate slug is something the
 * administrator can fix by typing a different one, and everything else is not.
 */
export class CategorySlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`A category with the slug "${slug}" already exists`);
    this.name = 'CategorySlugTakenError';
  }
}

export interface CategoryStore {
  /**
   * Create a category and its first version, in one transaction.
   *
   * Both or neither: a category with no version has no configuration, and every
   * read would have to handle a state that should not exist.
   *
   * Throws `CategorySlugTakenError` if the slug is taken.
   */
  create(
    input: CategoryConfiguration & { readonly slug: string },
    authorId: string,
  ): Promise<CategoryRecord>;

  /**
   * Write a new version of an existing category's configuration.
   *
   * Called `addVersion` rather than `update` on purpose. Nothing is updated —
   * a row is appended and the previous one stays exactly as it was, which is
   * what a booking created under it depends on.
   *
   * Resolves to null if no category has that slug.
   */
  addVersion(
    slug: string,
    configuration: CategoryConfiguration,
    authorId: string,
  ): Promise<CategoryRecord | null>;

  /**
   * Categories with their current configuration, oldest first — at most `limit`.
   *
   * **Bounded even though this table is small** (slice H2, ADR 0035), for the
   * reason `CategoryOptionSource.listOptions` records: the guardrail is against
   * a bug, not against users, because only an audited administrative action
   * creates a row here. What it must not do is truncate silently — an
   * administrator looking at a short list has no way to tell it from the whole
   * catalogue — so the caller probes for one extra row and reports the cut.
   */
  list(limit: number): Promise<readonly CategoryRecord[]>;

  /** One category with its current configuration, or null. */
  findBySlug(slug: string): Promise<CategoryRecord | null>;

  /**
   * The fee policy on one exact version, or null if there is no such version
   * (slice 5.2b).
   *
   * **The only read here that is not about "now", and that is why it exists.**
   * Everything else on this port answers how a category is configured today,
   * which is the right answer for pricing a new hire (ADR 0042). §8.2 makes
   * *settling* a hire the opposite question — a booking keeps the terms it was
   * made under — and re-reading today's commission would pay an owner a rate
   * nobody agreed to.
   *
   * It answers Payments' `CategoryFeePolicySource`, wired at the composition
   * root. Catalogue owns `category_versions`, so the read lives here and BRD
   * §5.1 keeps Payments out of the table.
   */
  findFeePolicyByVersionId(
    categoryVersionId: string,
  ): Promise<CategoryFeePolicy | null>;
}
