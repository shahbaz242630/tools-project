/**
 * Bounded reads: how many rows a query may return, and how a caller learns
 * there were more.
 *
 * **Every list query in this system is bounded, and the bound is chosen by what
 * the collection is** (ADR 0035). A read over rows users create — listings,
 * audit entries, sign-ins — is bounded because it grows without our permission.
 * A read over rows an administrator creates is bounded too, but the bound is a
 * guardrail against a bug rather than a page size.
 *
 * Two things live here, and they exist because both were already written twice
 * before this file did:
 *
 * - **the clamp**, which was `bound` in `audit.service.ts` and
 *   `boundedSignInLimit` in `identity.service.ts` — the same four operations,
 *   except that one of them guarded against `NaN` and the other did not; and
 * - **the overflow probe**, which was open-coded in the data export as
 *   `EXPORTED_SIGN_IN_LIMIT + 1` and a `.slice()` beside it.
 *
 * The project's own rule from slice 2.7b is that the third occurrence of a fix
 * means the rule is missing rather than the patch. This is that rule.
 *
 * **Not money and not a domain concept.** It sits in `@platform/core` beside
 * `Scaled` because it is pure arithmetic over values that arrive from a request,
 * with no Node imports, and because a service in any module may need it.
 */

/** How large a page may be, and what to serve when the caller says nothing usable. */
export interface LimitBounds {
  /** Served when the request carries no usable number. */
  readonly fallback: number;
  /** The largest page anyone may ask for — an engineering bound on one query. */
  readonly max: number;
}

/**
 * Clamp a caller-supplied page size into range.
 *
 * **A non-finite request yields the fallback rather than the maximum**, and that
 * is the deliberate half of this function. `NaN` is what `Number(qs)` produces
 * for a query string somebody typed by hand, and it is not a request for
 * everything — reading it as `max` would let a malformed parameter pull the
 * largest page the system permits, which is the opposite of what a bound is for.
 * `Infinity` is treated the same way for the same reason.
 *
 * Without the guard, `Math.trunc(NaN)` is `NaN`, `Math.max(NaN, 1)` is `NaN`,
 * and the value reaches Prisma as `take: NaN`. That was live in
 * `audit.service.ts` and unreachable only because both of its callers used the
 * default — which is a property of today's routes rather than of the code.
 *
 * Fractions are truncated rather than rounded, so `10.9` is ten: a page size is
 * a count of rows, and rounding up would let a caller exceed a bound by asking
 * for a fraction of a row.
 */
export function boundedLimit(requested: number, bounds: LimitBounds): number {
  if (!Number.isFinite(requested)) return bounds.fallback;
  return Math.min(Math.max(Math.trunc(requested), 1), bounds.max);
}

/**
 * How many rows to actually ask the database for, to serve `limit` of them.
 *
 * One more than will be served, so that "there were more" is **measured rather
 * than inferred**. A result whose length equals the limit exactly is otherwise
 * indistinguishable from a complete list that happens to be that long, and a
 * caller guessing between the two will guess wrong for precisely the person with
 * the most data.
 *
 * A function rather than `LIMIT + 1` at each call site because the pairing with
 * {@link fitTo} is the part that gets broken: the two numbers have to agree, and
 * they only agree by accident when each is written by hand.
 */
export function probe(limit: number): number {
  return limit + 1;
}

/** A page of rows, and whether the query had more to give. */
export interface Page<T> {
  readonly items: readonly T[];
  /**
   * Whether rows were left behind.
   *
   * Serve it to whoever reads the page. A truncated list that does not say so is
   * one somebody reads as the whole record — the export document states it for
   * exactly this reason (§10.1), and an operator needs it to know a guardrail
   * fired.
   */
  readonly truncated: boolean;
}

/**
 * Cut rows fetched with {@link probe} down to the page that was asked for.
 *
 * Pass the same `limit` that was given to `probe`. Rows beyond it are dropped
 * and their existence is reported instead.
 */
export function fitTo<T>(rows: readonly T[], limit: number): Page<T> {
  return {
    items: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}
