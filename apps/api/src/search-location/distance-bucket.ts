import type { DistanceBucket } from '@platform/contracts';

/**
 * Turning a measured distance into something we are willing to say (§8.4.1).
 *
 * **Here rather than in the controller, and that is the point of ADR 0044's
 * second decision.** §8.4.1 requires displayed distances to be coarse, and the
 * only way to guarantee it is for the exact figure never to leave this module:
 * `ListingProximity` returns buckets, so no layer above can render a decimal,
 * log one, or put one in a cache key.
 *
 * **Read `fuzz.ts` for what actually protects the address.** The rounding here
 * is honesty about precision we do not have; the privacy control is that every
 * distance handed to this function was measured from a point 500–1000 m from the
 * truth in a direction nobody can recover.
 */

/** International mile. Exact by definition, so this is not an approximation. */
const METRES_PER_MILE = 1_609.344;

export function milesToMetres(miles: number): number {
  return miles * METRES_PER_MILE;
}

/**
 * A measured distance, as a searcher is told it.
 *
 * **Under a mile is "near" rather than "about 1 mile", and that asymmetry is
 * deliberate.** Rounding 0.2 miles to "about 0 miles away" is absurd, and
 * rounding it up to 1 overstates the distance on exactly the listings a
 * hyperlocal marketplace exists to surface. Everything from a mile up is a whole
 * number with "about" attached.
 *
 * Rounds to nearest rather than down: "about 3 miles" for 3.4 is closer to true
 * than "about 3" for 3.9 would be, and a floor would make the top of a radius
 * read as one mile inside it.
 */
export function bucketDistance(metres: number): DistanceBucket {
  const miles = metres / METRES_PER_MILE;

  if (miles < 1) return { kind: 'under_a_mile' };

  return { kind: 'approximate', miles: Math.round(miles) };
}
