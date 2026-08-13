import type { DistanceBucket } from '@platform/contracts';

/**
 * How far away a listing is, in words (slice 3.1b, BRD §8.4.1).
 *
 * **This is the half of ADR 0032 that lives in the UI**, and it is a privacy
 * control wearing a copywriter's clothes. §8.4.1 requires displayed distances to
 * be coarse buckets rather than exact values, and the API already guarantees it
 * — `DistanceBucket` has no field that could hold a decimal. What this function
 * adds is that the *rendering* cannot reintroduce one either: there is no number
 * here that was not already whole.
 *
 * **In `lib/` with a test rather than inline in the component**, for the reason
 * `rate-card.ts` is: a server page has no test, and this is the sentence a
 * stranger reads about somebody's home. It should not be verified by looking at
 * it.
 *
 * The two forms are not stylistic. *"About 0 miles away"* is absurd and rounding
 * a near listing up to one overstates the distance on exactly the listings a
 * hyperlocal marketplace exists to surface, so anything under a mile is simply
 * near.
 */
export function distanceLabel(distance: DistanceBucket): string {
  if (distance.kind === 'under_a_mile') return 'Less than a mile away';

  return `About ${String(distance.miles)} ${distance.miles === 1 ? 'mile' : 'miles'} away`;
}
