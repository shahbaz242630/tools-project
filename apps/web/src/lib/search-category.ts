import type { PublicCategory } from '@platform/contracts';

/**
 * Whether a search names a category we do not have (slice 3.2b).
 *
 * **A module rather than a few lines in the page, because it is a rule with a
 * condition that is easy to get wrong and pages here have no tests.** Everything
 * else Browse decides is rendered by a component for exactly that reason; this
 * is decided before rendering, so it moves out instead.
 *
 * **The failure it prevents.** The API refuses an unknown category with a 400,
 * which is correct and is the control. But the web app maps every 400 from a
 * public read to `unreachable`, so the page rendered *"Search is unavailable at
 * the moment"* for a URL whose only problem was a category that does not exist —
 * search being entirely available at the time. That is slice 3.1d's defect one
 * field along: the refusal was right and the words were wrong, which is why no
 * test caught it and reading the page did.
 *
 * **The `known.length === 0` condition is the whole care here, and it is not an
 * optimisation.** An empty list does not mean "there are no categories"; it also
 * means "the category read failed", because `/browse` collapses every failure of
 * that read to an empty list so a searcher can still search. Refusing every
 * filtered search on the strength of a lookup that failed would turn a cosmetic
 * outage into a broken feature — so when we cannot know, we say nothing and let
 * the API decide, exactly as it did before this existed.
 */
export function namesAnUnknownCategory(
  category: string | null,
  known: readonly PublicCategory[],
): boolean {
  if (category === null) return false;
  if (known.length === 0) return false;

  return !known.some((candidate) => candidate.slug === category);
}
