import { LISTING_MEDIA_REFUSALS } from '@platform/contracts';
import type { ListingMediaRefusal } from '@platform/contracts';
import type { MediaRefusalReason } from '@platform/observability';
import { describe, expect, expectTypeOf, it } from 'vitest';

/**
 * The refusal vocabulary, in the two places it is written (slice 2.6c).
 *
 * `@platform/contracts` owns it — it reaches a sentence an owner reads.
 * `@platform/observability` restates it, because that package deliberately does
 * not depend on the contracts package: it sits *underneath* the API and its wire
 * types, and a dependency the other way would make a metric definition a reason
 * to rebuild the contract.
 *
 * **Two statements of one closed union is exactly the drift this project has
 * been bitten by**, so it is held by a test in the one place that can see both.
 * The failure it prevents is quiet: a reason added to the contract but not to
 * the metric would be a `reason` label `prom-client` accepts and nobody
 * notices, and a reason removed would leave a series that can never increment
 * again — both invisible until somebody reads a dashboard and believes it.
 */
describe('the media refusal vocabulary', () => {
  it('is the same set on both sides', () => {
    const counted: readonly MediaRefusalReason[] = [
      'too-many-bytes',
      'too-many-pixels',
      'unsupported-format',
      'not-an-image',
      'too-many-photographs',
      'storage-unavailable',
    ];

    expect([...LISTING_MEDIA_REFUSALS].sort()).toEqual([...counted].sort());
  });

  it('is the same *type* on both sides, not merely the same values', () => {
    /*
     * The assertion above compares the arrays this file wrote down. This one
     * compares the types, so a member added to either union fails here without
     * anybody remembering to update the list above — which is the half of a
     * drift guard that usually gets forgotten.
     */
    expectTypeOf<ListingMediaRefusal>().toEqualTypeOf<MediaRefusalReason>();
  });

  it('is small enough to be a label', () => {
    // A label mints one series per value. Six is fine; the rule this guards is
    // that nothing unbounded ever becomes one.
    expect(LISTING_MEDIA_REFUSALS.length).toBeLessThanOrEqual(12);
  });
});
