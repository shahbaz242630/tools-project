import { Money } from '@platform/core';
import type { AppliedExcess } from '@platform/contracts';

/**
 * What is held against a card at collection, said once (§8.7.2).
 *
 * **Its own component from slice 5.5b-ii, because three surfaces say it**: the
 * listing a renter decides from, the booking they read afterwards, and the
 * request an owner accepts. It was written inline on the listing page in 5.5b-i,
 * when there was one; a second copy is how the disclosure on the page you book
 * from comes to differ from the one on the page you pay from, and §3.4.4 is a
 * legal exposure rather than a style guide.
 *
 * **A hold, never a deposit, whoever is reading.** No customer money is ever
 * ours: the hold sits on the renter's *own* card and is released when the item
 * comes home. `landing.tsx` says it in those words under three tests and
 * `DESIGN.md` D3 records why — §8.15 is explicit that substance beats labels, and
 * "deposit" is a claim about where somebody's money sits.
 *
 * **The audience changes whose card it is and nothing else.** A renter is told
 * about their own; an owner is told what stands behind the item they are about to
 * hand over, which §8.7.2 entitles them to know before they accept. The amount
 * and the reason for it are identical, and are rendered from one place so they
 * cannot drift.
 */
export function DamageHold({
  excess,
  audience,
  className,
  explainSize,
}: {
  readonly excess: AppliedExcess | null;
  readonly audience: 'renter' | 'owner';
  /**
   * The host page's own style for this block.
   *
   * **Required rather than optional**, which is not only `exactOptionalPropertyTypes`
   * being strict about a CSS module's `string | undefined`: §3.4.4 wants the hold
   * shown *separately* from the price, and every page that has adopted it has done
   * that with a bordered aside. A default of "no styling" would let the next
   * caller silently render it as another muted line in the money.
   */
  readonly className: string | undefined;
  /**
   * Whether to say *why* the hold is this size.
   *
   * **It exists because a page may legitimately show this twice**, and the
   * owner's listing page does: once on the request they are deciding about, and
   * once in the item's own detail list. The two are not redundant — a request
   * carries the figure it was *made* under, which can differ from the item's
   * current one if the band has changed since — but rendering the identical
   * paragraph twice reads as carelessness rather than as emphasis, which is the
   * defect slice 5.5a already found once and `request-panel.tsx` records.
   *
   * So the per-booking one states the amount and the per-item one explains it.
   * **Required rather than defaulted**, because a caller that had not thought
   * about it is exactly the one that would produce the duplicate.
   */
  readonly explainSize: boolean;
}) {
  /*
   * **Null gets a sentence rather than an empty region.** §8.7.2 permits a
   * category configured to require no security (ADR 0052), and the guess a
   * person makes about an unmentioned hold is that there is one. Silence would
   * be the least honest of the three renderings.
   */
  if (excess === null) {
    return (
      <p className={className}>
        <strong>No hold for this item.</strong>{' '}
        {audience === 'renter'
          ? 'Nothing is held against your card for this hire.'
          : 'Nothing is held against the renter’s card for this hire.'}
      </p>
    );
  }

  return (
    <p className={className}>
      <strong>{Money.format(excess.amount)} held at collection.</strong>{' '}
      {audience === 'renter'
        ? 'It sits on your own card and is released when the item comes home — it is not a fee and is never part of the price above.'
        : 'It sits on the renter’s own card and is released when the item comes home. It is not money we hold and it is not part of what you are paid.'}
      {explainSize ? <> {EXCESS_EXPLANATIONS[excess.boundBy]}</> : null}
    </p>
  );
}

/**
 * Why the hold is the size it is, one sentence per bound.
 *
 * **A closed record rather than a chain of conditionals**, so a fourth bound
 * added to `EXCESS_BOUNDS` is a compile error here instead of a page that
 * silently explains nothing — the reason the metric label vocabularies are
 * closed unions too.
 *
 * **Each says something true without naming the replacement value it came
 * from.** The floor is a property of the category, the ceiling is a promise
 * about the most that will ever be held, and the percentage is acknowledged as
 * value-based without disclosing the value — which is not published (§8.4.1
 * already puts the location half a kilometre from the truth).
 */
const EXCESS_EXPLANATIONS: Readonly<Record<AppliedExcess['boundBy'], string>> = {
  floor: 'That is our minimum for this kind of item.',
  percentage: 'It is based on what this item would cost to replace.',
  ceiling: 'That is the most we will ever hold for this kind of item.',
};
