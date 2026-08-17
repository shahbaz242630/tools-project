import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import type {
  CategoryFeePolicy,
  ListingRateCard,
  QuoteLineItem,
  RentalUnit,
} from '@platform/contracts';
import { RENTAL_UNIT_DAYS, WEEKEND_START_WEEKDAY } from '@platform/contracts';
import { renterFeeOn } from './renter-fee.js';

/**
 * What a period costs (BRD §8.5.2, slice 4.4b).
 *
 * **The rule, in the sentence a renter can be told:** *we work your dates out
 * the cheapest way from the owner's own prices.* Whole weeks at the weekly rate,
 * the remainder daily, a weekend at the weekend rate — whichever combination
 * comes to least, and never more than the next whole week.
 *
 * **The platform sets no discount curve** (product owner, 16 August 2026). The
 * discount is the owner's, expressed in the rates they chose. Both incumbents
 * work this way — Hygglo has owners set tiered prices at 1, 3 and 7 days, and
 * Fat Llama's own example is *"£10 a day but £50 a week"* — and a curve we
 * imposed would be a number we then had to defend to every owner whose earnings
 * it changed. See ADR 0047.
 *
 * ## Why this is written as coverage rather than as decomposition
 *
 * The obvious implementation is *"divide by seven, charge the weeks, charge the
 * remainder daily"*. It is wrong in a way that produces a support enquiry nobody
 * can answer: with a £10 day and a £50 week, six days comes to £60 and seven
 * days to £50, so a renter pays more for less time. Extending a hire makes it
 * cheaper, and every honest explanation of that sentence sounds like a defect.
 *
 * So this asks a different question: **what is the cheapest set of the owner's
 * rate units that covers *at least* this hire?** A six-day hire may buy a week,
 * because a week covers six days and costs less. That single change makes the
 * two properties the decision named **structural rather than tested-and-hoped**:
 *
 * 1. **Never dearer than the naive daily total.** Buying `days` days is always
 *    one of the candidates, so the minimum is bounded by it.
 * 2. **Monotonic in days.** Anything covering `n + 1` days also covers `n`, so
 *    the feasible set only shrinks as a hire lengthens and the minimum can only
 *    rise. **No arrangement of rates can break it**, which a decomposition rule
 *    cannot say however many examples are tested.
 *
 * There are tests for both anyway. They are there to catch this file being
 * rewritten into the decomposition, which is exactly the "simplification"
 * somebody will reach for.
 */

/** The unit vocabulary, largest first — see `chooseCheapestUnits` for why. */
const UNITS_LARGEST_FIRST = [
  'week',
  'weekend',
  'day',
] as const satisfies readonly RentalUnit[];

/** A combination of units, and what it comes to. */
interface Combination {
  readonly counts: Readonly<Record<RentalUnit, number>>;
  readonly cost: MoneyValue;
}

/** The owner's rates as `Money`, with the ones they did not set left out. */
interface AvailableRates {
  readonly day: MoneyValue;
  readonly weekend: MoneyValue | null;
  readonly week: MoneyValue | null;
}

/** The units a hire is made up of, and what the owner charges for them. */
export interface RentalUnits {
  readonly lineItems: readonly QuoteLineItem[];
  /**
   * What the owner charges for the hire.
   *
   * **The cost the search minimised, carried out rather than re-summed from the
   * line items.** Two expressions of one number is how a total comes to differ
   * from its own breakdown by a penny.
   */
  readonly itemCharge: MoneyValue;
}

/**
 * The cheapest combination of the owner's rates covering a hire of `days`,
 * starting on `startsOnWeekday` (1 is Monday, as `Time.weekdayOf` has it).
 *
 * Returns null for a listing that cannot be quoted at all. **Null means "cannot
 * be quoted", never "free"** — the convention `inclusiveDailyPrice` uses. Two
 * things produce it:
 *
 * - **No daily rate**, which is every draft nobody has priced.
 *   `listingRateCardSchema` refuses a weekend or weekly rate without a daily one
 *   beside it, so a listing with no daily rate has no rates at all.
 * - **A hire of less than a day**, which is not a hire. `refusePeriod` has
 *   already refused an inverted period by the time anything reaches here, so
 *   this is the second wall rather than the first — and it is a wall rather than
 *   a throw because a zero-day hire priced at zero would be the worse failure.
 */
export function chooseCheapestUnits(
  days: number,
  startsOnWeekday: number,
  rates: ListingRateCard,
): RentalUnits | null {
  if (rates.daily === null) return null;
  if (!Number.isInteger(days) || days < 1) return null;

  const available = toAvailableRates(rates, startsOnWeekday);
  const best = cheapestCombination(days, available);

  return { lineItems: toLineItems(best, available), itemCharge: best.cost };
}

/**
 * Which rates may be used, and the one that is conditional.
 *
 * **The weekend rate is a candidate only for a hire that starts on a Friday**,
 * which is the narrower of the two readings the phase handoff put forward and
 * the one it recommended. `ListingRateCard.weekend` is documented as *"Friday to
 * Sunday as one charge"*, so that is what an owner setting it believes they are
 * pricing — a Tuesday-to-Thursday hire at the weekend rate would be charging
 * weekend economics for working days nobody agreed to discount. The alternative
 * reading, treating it as a generic three-day price point, is a decision
 * somebody can take later by deleting one condition; inventing it here would
 * quietly reprice every listing that has one.
 */
function toAvailableRates(
  rates: ListingRateCard,
  startsOnWeekday: number,
): AvailableRates {
  const daily = rates.daily;
  /* c8 ignore next -- `chooseCheapestUnits` returns before this is reached. */
  if (daily === null)
    throw new Error('a rate card with no daily rate cannot be priced');

  return {
    day: Money.money(daily.amount, daily.currency),
    weekend:
      rates.weekend !== null && startsOnWeekday === WEEKEND_START_WEEKDAY
        ? Money.money(rates.weekend.amount, rates.weekend.currency)
        : null,
    week:
      rates.weekly === null
        ? null
        : Money.money(rates.weekly.amount, rates.weekly.currency),
  };
}

/**
 * Every combination worth considering, and the cheapest of them.
 *
 * The search is deliberately tiny and exhaustive rather than clever. A hire is at
 * most 88 days (§8.5.3), so there are at most thirteen week counts and two
 * weekend counts to try — twenty-six candidates, each a multiplication and an
 * addition. An arithmetic short cut here would be a second expression of the
 * pricing rule, and the first one to get out of step with the sentence a renter
 * is told.
 *
 * **A weekend may be used at most once.** Two weekends in one hire is not what a
 * rate called "weekend" prices — a fortnight contains two of them, and charging
 * both while the intervening week goes unpriced describes nothing an owner
 * chose. The bound also keeps the search independent of `days`, which is what
 * property 2 above needs: the feasible set must shrink with a longer hire and
 * never gain a candidate.
 */
function cheapestCombination(days: number, rates: AvailableRates): Combination {
  let best: Combination | null = null;

  const weekendLimit = rates.weekend === null ? 0 : 1;

  /*
   * **Descending, so a tie is broken towards the larger unit.** Seven days at £10
   * and a week at £70 come to the same money, and *"1 week"* is the line item an
   * owner meant and a renter understands. Ascending would produce *"7 days"* for
   * the identical price, which reads as though the weekly rate were ignored.
   */
  for (let weekends = weekendLimit; weekends >= 0; weekends -= 1) {
    const afterWeekends = Math.max(0, days - weekends * RENTAL_UNIT_DAYS.weekend);
    const weekLimit =
      rates.week === null ? 0 : Math.ceil(afterWeekends / RENTAL_UNIT_DAYS.week);

    for (let weeks = weekLimit; weeks >= 0; weeks -= 1) {
      // Whatever the larger units do not cover is bought by the day. This is
      // what makes plain daily always feasible, which is property 1.
      const remainder = Math.max(0, afterWeekends - weeks * RENTAL_UNIT_DAYS.week);
      const counts = { day: remainder, weekend: weekends, week: weeks };
      const cost = costOf(counts, rates);

      if (best === null || Money.lessThan(cost, best.cost)) {
        best = { counts, cost };
      }
    }
  }

  /* c8 ignore next -- the loops always run at least once, with weekends = 0. */
  if (best === null) throw new Error('no combination of rates was considered');

  return best;
}

function costOf(
  counts: Readonly<Record<RentalUnit, number>>,
  rates: AvailableRates,
): MoneyValue {
  const parts = UNITS_LARGEST_FIRST.filter((unit) => counts[unit] > 0).map((unit) =>
    Money.multiply(rateFor(unit, rates), counts[unit]),
  );

  return Money.sum(parts, rates.day.currency);
}

/**
 * The rate for a unit that a combination actually used.
 *
 * A combination never counts a unit whose rate is absent — `cheapestCombination`
 * bounds those counts at zero — so this is only ever asked about a rate that
 * exists.
 */
function rateFor(unit: RentalUnit, rates: AvailableRates): MoneyValue {
  if (unit === 'day') return rates.day;

  const rate = unit === 'week' ? rates.week : rates.weekend;
  /* c8 ignore next -- unreachable: a count is only non-zero when its rate is set. */
  if (rate === null) throw new Error(`no ${unit} rate was set`);
  return rate;
}

/**
 * The combination as the rows a renter reads, largest unit first.
 *
 * Ordering is not cosmetic: the line items are what the quote is explained by,
 * and *"1 week, then 2 days"* is how somebody describes nine days out loud.
 * Units the combination did not use are absent rather than zero — a `0 × week`
 * row invites the question of why it is there.
 */
function toLineItems(
  best: Combination,
  rates: AvailableRates,
): readonly QuoteLineItem[] {
  return UNITS_LARGEST_FIRST.filter((unit) => best.counts[unit] > 0).map((unit) => {
    const unitPrice = rateFor(unit, rates);
    const count = best.counts[unit];

    return {
      unit,
      count,
      unitPrice,
      subtotal: Money.multiply(unitPrice, count),
    };
  });
}

/** What a period costs, before anything §8.5.2 does not let us price yet. */
export interface PricedRental {
  readonly lineItems: readonly QuoteLineItem[];
  /** What the owner charges. The sum of the line items. */
  readonly itemCharge: MoneyValue;
  /** The renter's mandatory fee (§3.4.4), floor applied. */
  readonly renterFee: MoneyValue;
  readonly minimumFeeApplied: boolean;
  /** `itemCharge + renterFee`. The headline (§3.4.4). */
  readonly total: MoneyValue;
}

/**
 * The whole price of a hire: the owner's charge plus the platform's fee.
 *
 * Null when the listing cannot be priced at all — see `chooseCheapestUnits`.
 *
 * **The fee is taken on the item charge for the whole period, not per day.** A
 * per-day fee would multiply the category's minimum platform fee by the length
 * of the hire, turning a £1 floor into £14 on a fortnight, which is not what
 * §3.4.2 describes — it puts a floor under *the platform fee on a booking*.
 */
export function priceRental(
  days: number,
  startsOnWeekday: number,
  rates: ListingRateCard,
  policy: CategoryFeePolicy,
): PricedRental | null {
  const units = chooseCheapestUnits(days, startsOnWeekday, rates);
  if (units === null) return null;

  const { lineItems, itemCharge } = units;
  const { fee: renterFee, minimumFeeApplied } = renterFeeOn(itemCharge, policy);

  return {
    lineItems,
    itemCharge,
    renterFee,
    minimumFeeApplied,
    total: Money.add(itemCharge, renterFee),
  };
}

/**
 * Why this total is too small to book — or null, meaning it is not.
 *
 * **§3.4.2's minimum booking total, enforced here for the first time.**
 * `pricing.ts` has said since slice 2.7a that the floor is *"configuration here,
 * enforcement in Phase 4 — this is a rule about a booking, and there is no
 * booking in Phase 2 to refuse"*. This is that enforcement: on a small enough
 * booking the fixed per-transaction costs in §3.4.1 exceed the percentage
 * revenue entirely, so the platform loses money by arranging it.
 *
 * **It is compared against the total, not the item charge.** The total is what
 * the renter pays and what the payment provider's fixed cost is levied on, which
 * is the cost the floor exists to cover.
 *
 * A reason rather than a boolean, matching `PeriodRefusal` in `rental-period.ts`:
 * the caller has to *say* something, and it has to name the number.
 */
export interface BelowMinimumBooking {
  readonly total: MoneyValue;
  readonly minimum: MoneyValue;
}

export function refuseBelowMinimumBooking(
  total: MoneyValue,
  policy: CategoryFeePolicy,
): BelowMinimumBooking | null {
  const minimum = Money.money(
    policy.minimumBookingTotal.amount,
    policy.minimumBookingTotal.currency,
  );

  if (!Money.lessThan(total, minimum)) return null;

  return { total, minimum };
}

/**
 * The refusal as the sentence a renter reads.
 *
 * **Here rather than in a controller**, the treatment `describePeriodRefusal`
 * gets and for its reason: the two surfaces that will render this — 4.4b's quote
 * and 4.5's request — must not come to describe the same rule differently.
 *
 * It says what to do about it. A renter whose two-day hire falls under the
 * minimum can book three days, and being told the number is what lets them work
 * that out; "too small" on its own is a dead end.
 */
export function describeBelowMinimumBooking(refusal: BelowMinimumBooking): string {
  return (
    `That comes to ${Money.format(refusal.total)}, and the smallest booking we can ` +
    `take for this kind of item is ${Money.format(refusal.minimum)}. Hiring for ` +
    'longer will get you there.'
  );
}
