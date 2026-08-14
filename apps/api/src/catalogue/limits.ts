import { SEARCH_PAGE_SIZE } from '@platform/contracts';

/**
 * How many rows each of Catalogue's list reads may return (slice H2, ADR 0035).
 *
 * **Two kinds of bound live here and they are not the same thing**, which is the
 * distinction ADR 0035 exists to keep:
 *
 * - `EXPORTED_LISTING_LIMIT` bounds a collection **users create**. Nothing stops
 *   an owner writing listings all day, so the bound is the only thing standing
 *   between the export and a query whose cost grows without our permission.
 * - `CATEGORY_LIST_LIMIT` bounds a collection **an administrator creates**. Rows
 *   arrive only through an audited form, so the count is a decision somebody
 *   made. The bound is a guardrail against a bug, a bad migration or a runaway
 *   script — not a page size, and not a feature anybody should ever meet.
 *
 * Both are deliberately far above any plausible real value. A bound that is
 * reached in normal use is a pagination feature wearing the wrong name, and
 * these are not that — which is why reaching either one is worth a warning in
 * the log rather than a page control on screen.
 */

/**
 * How many listings a data export carries.
 *
 * Twice the sign-in limit, because the two are cut for different reasons. A
 * sign-in history grows with time and nothing prunes it, so five hundred is a
 * genuine slice of a long record; a listing count grows with how much somebody
 * chooses to rent out, and a thousand is beyond any private owner and beyond
 * most businesses we would expect at launch.
 *
 * **The cut is declared in the document** (`listingsTruncated`), because §10.1
 * requires a subject-access response to be complete and the honest way to bound
 * one is to say where it stopped. Silence here would be the more expensive bug:
 * a partial answer nobody can tell from a whole one.
 */
export const EXPORTED_LISTING_LIMIT = 1000;

/**
 * How many listings an owner's own list returns (slice 2.9a).
 *
 * **A guardrail, not a page size, and choosing which of the two it is was the
 * decision this slice had to make.** ADR 0035 draws the line by what the
 * collection is: this one grows with how much somebody chooses to rent out,
 * which is a collection users create, so a bound is not optional. But `limits.ts`
 * also says a bound reached in normal use is *"a pagination feature wearing the
 * wrong name"* — and a page size of twenty would be exactly that, shipping half
 * a paginator with no way to reach row twenty-one.
 *
 * Two hundred is above any private owner and above any business we expect at
 * launch, so in practice it is never met; and if it ever is, the page says so
 * rather than quietly stopping. **When somebody real is cut by this, the answer
 * is pagination rather than a larger number** — and from slice 3.1d there is a
 * worked example to copy rather than a prediction: search pages by number, not
 * by cursor (ADR 0045). This read would want the same shape, and for a stronger
 * reason: it is ordered by `createdAt`, which is not sensitive at all.
 *
 * Deliberately its own constant rather than sharing `EXPORTED_LISTING_LIMIT`.
 * They bound the same query for different readers: an export is a legal
 * obligation answered once and read by a machine, and this is a page a person
 * scrolls. Sharing the number would mean changing one surface silently changed
 * the other.
 */
export const OWNED_LISTING_LIMIT = 200;

/**
 * How many listings one page of search results carries (slice 3.1a, paginated
 * in 3.1d).
 *
 * **The first constant in this file that is honestly a page size**, and it is
 * worth saying so because the two above go out of their way not to be. The
 * distinction ADR 0035 draws is between a bound nobody should ever meet and a
 * bound that is part of the product — a radius search over a working catalogue
 * is *expected* to have more results than fit, so this one is met constantly and
 * that is not a defect.
 *
 * **The number itself moved to `@platform/contracts` in slice 3.1d**, because
 * the page now renders *"Tools 25–48 near you"* and has to skip by the same
 * amount the server does. The decision to bound this read stays here, where
 * ADR 0035's argument is; only the value is shared.
 *
 * ~~**The cursor is slice 3.1b's**, and `ListingStore.listOwnedBy` has recorded
 * since slice H2 that the port should take one once a third caller wants a
 * third answer.~~ **Struck out in 3.1d, and the correction is the useful part.**
 * The cursor is not arriving: measured performance made offset pagination the
 * better trade (ADR 0045), because a keyset cursor over a distance-ordered
 * search puts an exact distance in a URL. Two smaller things were also wrong —
 * pagination was 3.1d rather than 3.1b, and `listOwnedBy`'s own docblock never
 * mentioned a cursor at all. It says the bound must be explicit, which it is.
 */
export const SEARCH_RESULT_LIMIT = SEARCH_PAGE_SIZE;

/**
 * How many categories any read of the catalogue returns.
 *
 * The launch catalogue is one category. `reference-category-taxonomy.md` found
 * that HSS Hire runs thousands of products across a few dozen groupings, so a
 * mature version of this platform is tens — five hundred is two orders of
 * magnitude of headroom.
 *
 * Shared by the admin list and the owner's picker deliberately. They read the
 * same table and would otherwise be two numbers that drift, and the failure that
 * produces is the worst one available here: a category an administrator can see
 * and configure but no owner can list in.
 */
export const CATEGORY_LIST_LIMIT = 500;
