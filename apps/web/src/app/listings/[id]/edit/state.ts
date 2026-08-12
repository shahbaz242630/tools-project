import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';

/**
 * The edit form's state, and it lives here for the reason the create form's does:
 * a `'use server'` file may export only async functions, and an exported object
 * beside an action makes the route's generated loader throw *"A 'use server' file
 * can only export async functions, found object"* — **when the action is
 * invoked**, not when the page renders. So the form looks fine until somebody
 * presses the button.
 *
 * **Its own type rather than the create form's** (slice 2.9b-i). One field on
 * `ListingActionState` cannot occur here — the category, which is fixed at
 * creation — and sharing one shape would mean carrying a value the edit form
 * never collects, echoed back into an input that does not exist.
 *
 * The four address fields arrived in 2.9b-ii and are the same four the create
 * form has.
 */
export interface ListingEditState {
  readonly status: 'idle' | 'error';
  readonly message: string | null;
  /**
   * Kept as typed so a refusal does not empty what somebody just wrote.
   *
   * These are `defaultValue` inputs and React 19 resets the form once an action
   * settles — a reset restores each input from its *attribute*, so a field not
   * echoed back here silently empties on a refusal about something else. That is
   * the defect 2.7a found on the fee fields and 2.4c-i on checkboxes, and the fix
   * is the same: round-trip what was typed.
   */
  readonly title: string;
  readonly description: string;
  readonly replacementValue: string;
  readonly dailyRate: string;
  readonly weekendRate: string;
  readonly weeklyRate: string;
  /**
   * The collection address, kept as typed for the reason above and one more that
   * is specific to it (slice 2.9b-ii).
   *
   * An address is the longest thing on this form and the most annoying to retype,
   * and — unlike a title — the reader cannot reconstruct it by glancing at the
   * page they came from. On the create form this was already the field the
   * round-trip rule was written for.
   */
  readonly line1: string;
  readonly line2: string;
  readonly town: string;
  readonly postcode: string;
  /**
   * The category-specific answers are **not** here, matching the create form.
   * They live in the component's own state, which survives an action round trip
   * because the component is re-rendered rather than remounted; a second copy
   * here could disagree with the inputs somebody is looking at.
   */
}

/**
 * The form as it opens: the listing as it stands.
 *
 * **Built from the listing rather than from blanks**, which is the whole
 * difference from the create form's constant initial state. An edit form that
 * opened empty would not be an edit form — it would be a way to delete a
 * description by pressing Save.
 */
export function editStateFrom(listing: {
  readonly title: string;
  readonly description: string;
  readonly replacementValue: MoneyValue;
  readonly rates: {
    readonly daily: MoneyValue | null;
    readonly weekend: MoneyValue | null;
    readonly weekly: MoneyValue | null;
  };
  /**
   * Null for a listing that has never said where it is, which is a legitimate
   * draft (§8.3) and opens the four fields blank.
   */
  readonly collectionLocation: {
    readonly line1: string;
    readonly line2: string | null;
    readonly town: string;
    readonly postcode: string;
  } | null;
}): ListingEditState {
  const location = listing.collectionLocation;

  return {
    status: 'idle',
    message: null,
    title: listing.title,
    description: listing.description,
    replacementValue: Money.toMajorString(listing.replacementValue),
    dailyRate: rateOrBlank(listing.rates.daily),
    weekendRate: rateOrBlank(listing.rates.weekend),
    weeklyRate: rateOrBlank(listing.rates.weekly),
    line1: location?.line1 ?? '',
    // Empty string rather than the stored null, because that is what an input
    // holds and what it will post back. `readCollectionLocation` turns it into a
    // null again on the way in, which is the inverse this has to be — the same
    // rule `toStoredAnswers` follows for the attribute values.
    line2: location?.line2 ?? '',
    town: location?.town ?? '',
    postcode: location?.postcode ?? '',
  };
}

/**
 * Blank for an unset rate, because blank is what "not priced" submits as.
 *
 * **`Money.toMajorString`, and nothing hand-rolled.** This file first divided by
 * a hundred and formatted the result itself, with a comment rationalising it as
 * keeping the money primitive out of an action's bundle — and the invariant
 * checker refused the commit, correctly. That is exactly the reasoning ADR 0002
 * exists to catch: the division produces a float, and a float is how a wrong
 * figure reaches something somebody is charged against. The bundle argument was
 * speculative; the invariant is not.
 *
 * The rule matches on the *name* of the banned call, so naming it even in prose
 * trips it. That is the right way round — a rule that reads comments is one
 * nobody can talk their way past — so this paragraph describes it instead.
 */
function rateOrBlank(rate: MoneyValue | null): string {
  return rate === null ? '' : Money.toMajorString(rate);
}
