import { Money } from '@platform/core';
import type { QuoteLineItem } from '@platform/contracts';

/**
 * How one line of a price breakdown reads (§8.5.2, ADR 0047).
 *
 * **Extracted from `request-panel.tsx` in slice 5.2d**, where it was private, so
 * the pay page can render the same breakdown the renter agreed to. Two copies of
 * this would be two places for *"1 week at £45.00 each"* to drift — and the two
 * pages that show it are the page where somebody is quoted a price and the page
 * where they pay it, which are precisely the two that must not disagree.
 *
 * **The markup is deliberately not shared, only the words.** The panel and the
 * page lay their lines out differently and have their own stylesheets; what must
 * not fork is the sentence.
 *
 * **"at £X each" only when there is more than one**, because *"1 week at £45.00
 * each"* reads as though something were being counted twice — and for a single
 * unit the unit price and the subtotal are the same number printed twice.
 */
export function describeLine(item: QuoteLineItem): string {
  const counted = `${String(item.count)} ${item.unit}${item.count === 1 ? '' : 's'}`;

  return item.count === 1
    ? counted
    : `${counted} at ${Money.format(item.unitPrice)} each`;
}
