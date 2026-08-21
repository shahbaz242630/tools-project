/**
 * What a booking actually costs us to serve (BRD §3.4.1, slice 5.3a).
 *
 * **§3.4 exists because the platform can be fully compliant, well engineered and
 * still lose money on every small booking.** This file is the input to finding
 * that out: §3.4.1 lists the cost components every quote must be evaluated
 * against, and §3.4.3 requires a documented worked example before Phase 5 exits.
 *
 * ## Why this is code rather than versioned configuration
 *
 * CLAUDE.md's rule is *if it might change without a deploy, it is configuration*
 * — and fee percentages, minimum booking totals and deposit bands are all on
 * `category_versions` for exactly that reason. **These numbers are deliberately
 * on the other side of that line**, and the distinction is worth stating because
 * it looks inconsistent.
 *
 * A category's fees are **ours to set and change**: an administrator adjusts them
 * through a form and the platform must honour whatever they chose. **A provider's
 * rates are facts about the world.** Changing this file does not change what
 * Stripe charges — it changes what we *believe* Stripe charges, which is an
 * assumption behind a financial model. An assumption that can be edited through
 * an admin form at 2am with no reviewer is precisely what §3.4 exists to prevent:
 * the whole section is about validating fee percentages against **real
 * per-transaction cost** before any public commitment.
 *
 * So these live in git, where a change is a diff somebody reviews, and **every
 * number carries its source and the date it was read**. A number without one is a
 * number somebody made up.
 *
 * ## The assumptions, which are not facts
 *
 * Several components in §3.4.1 have no published rate because they depend on our
 * own behaviour rather than a provider's price list — dispute frequency, support
 * cost, how many messages a booking sends. **Those are marked `assumption` and
 * they are the product owner's to set.** They are stated explicitly rather than
 * buried at a default of zero, because a cost silently modelled as zero is how a
 * model comes to say something reassuring and false.
 */

import { Money } from '@platform/core';
import type { CurrencyCode, MoneyValue } from '@platform/core';

/**
 * A rate charged as a percentage plus a fixed amount, which is how card
 * processing and payouts are both priced.
 *
 * **Both parts matter and the fixed part is why §3.4.2 exists.** A percentage
 * alone would scale down forever; 20p does not, so it is the fixed component that
 * makes a small booking unprofitable rather than merely less profitable.
 */
export interface BlendedRate {
  /** 1.5 for 1.5%, matching `Money.percentageOf`. */
  readonly percent: number;
  readonly fixed: MoneyValue;
}

/** Where a number came from, so nobody has to guess whether it was researched. */
export type Provenance =
  | {
      readonly kind: 'published';
      /** The page it was read from. */
      readonly source: string;
      /** ISO date it was read. Rates move; a number with no date is stale silently. */
      readonly readOn: string;
    }
  | {
      readonly kind: 'assumption';
      /** Why this value, and what would change it. */
      readonly basis: string;
      /** Who owns the number. Always the product owner for a commercial assumption. */
      readonly owner: 'product-owner';
    };

export interface CostComponent<T> {
  readonly value: T;
  readonly provenance: Provenance;
}

const gbp = (pence: number): MoneyValue => Money.money(pence, 'GBP');

const stripePricing = (readOn: string): Provenance => ({
  kind: 'published',
  source: 'https://stripe.com/gb/pricing',
  readOn,
});

const connectPricing = (readOn: string): Provenance => ({
  kind: 'published',
  source: 'https://stripe.com/gb/connect/pricing',
  readOn,
});

/**
 * Everything §3.4.1 requires a booking to be evaluated against.
 *
 * **Named one field per §3.4.1 clause**, in the order that section lists them, so
 * a reviewer can check the model covers the specification by reading down rather
 * than by trusting a summary.
 */
export interface CostModel {
  readonly currency: CurrencyCode;

  /** "card processing on the rental charge" */
  readonly cardProcessing: CostComponent<BlendedRate>;

  /**
   * "card processing on any captured damage security"
   *
   * **The same rate, and it is a separate field anyway.** A hold that is captured
   * is a second charge and is priced as one; folding it into the line above would
   * make the model silently assume damage security is free to collect.
   */
  readonly damageSecurityProcessing: CostComponent<BlendedRate>;

  /** "payment-provider connected-account and payout fees" — the per-payout half. */
  readonly payout: CostComponent<BlendedRate>;

  /**
   * "payment-provider connected-account ... fees" — the per-account half.
   *
   * **Charged per active connected account per month, not per booking**, which is
   * the single most consequential number in this file: it is amortised across
   * however many bookings that owner completes in the month, so the same £2 is
   * 200p on one booking and 25p on eight.
   */
  readonly connectedAccountMonthly: CostComponent<MoneyValue>;

  /** "extended-authorisation fees where used" */
  readonly extendedAuthorisation: CostComponent<MoneyValue>;

  /** "identity-verification cost amortised per active user" */
  readonly identityVerification: CostComponent<MoneyValue>;

  /** "SMS cost for critical events" */
  readonly smsPerMessage: CostComponent<MoneyValue>;
  readonly criticalMessagesPerBooking: CostComponent<number>;

  /**
   * "refund and chargeback cost including the fee retained on refunded
   * transactions"
   *
   * Two numbers because they are two different events at very different
   * frequencies: a refund costs us the processing fee we already paid, and a
   * chargeback costs that plus the provider's dispute fee.
   */
  readonly disputeFee: CostComponent<MoneyValue>;
  readonly refundRate: CostComponent<number>;
  readonly chargebackRate: CostComponent<number>;

  /** "expected support and dispute handling cost per booking" */
  readonly supportPerBooking: CostComponent<MoneyValue>;
}

/**
 * The model as it stands on 21 August 2026, for Stripe Connect in the UK.
 *
 * **Read from Stripe's published pages on the date recorded on each component.**
 * The rates that are *not* published — Stripe Identity's UK per-verification
 * price is not on any public page — are marked as assumptions rather than guessed
 * at a plausible-looking number.
 */
export const UK_STRIPE_COST_MODEL: CostModel = {
  currency: 'GBP',

  cardProcessing: {
    /*
     * **Standard UK domestic cards.** Deliberately the *cheapest* published rate,
     * which makes this model optimistic on purpose: premium UK cards are 2.8% +
     * 20p and EEA cards 2.5% + 20p, so a real mix costs more than this says. A
     * margin that is negative under the friendliest assumption is negative.
     */
    value: { percent: 1.5, fixed: gbp(20) },
    provenance: stripePricing('2026-08-21'),
  },

  damageSecurityProcessing: {
    value: { percent: 1.5, fixed: gbp(20) },
    provenance: stripePricing('2026-08-21'),
  },

  payout: {
    value: { percent: 0.25, fixed: gbp(10) },
    provenance: connectPricing('2026-08-21'),
  },

  connectedAccountMonthly: {
    value: gbp(200),
    provenance: connectPricing('2026-08-21'),
  },

  extendedAuthorisation: {
    /*
     * **Zero, because we do not use them** — and this is a live decision rather
     * than an omission. BRD Appendix A records that Extended Authorizations reach
     * ~30 days but **exclude our merchant category from the free tier**, carrying
     * a per-transaction fee and remaining subject to issuer approval. §8.7.2's
     * damage hold is therefore built on ordinary authorisations at the collection
     * window. If that ever changes, this stops being zero.
     */
    value: gbp(0),
    provenance: {
      kind: 'assumption',
      basis:
        'We use ordinary authorisations at the collection window (§8.7.2). Extended ' +
        'authorisations exclude our merchant category from the free tier and are not used.',
      owner: 'product-owner',
    },
  },

  identityVerification: {
    /*
     * **Zero today, and the zero is defensible rather than convenient.** Owner
     * KYC happens inside Connect onboarding, which Stripe's Connect pricing page
     * lists as included. We run no identity check on renters. **Stripe Identity's
     * UK per-verification price is not published**, so if a renter check is ever
     * added this becomes a real number that has to be obtained rather than
     * estimated.
     */
    value: gbp(0),
    provenance: {
      kind: 'assumption',
      basis:
        'Owner KYC is included in Connect onboarding (published). No renter identity ' +
        'check exists. Stripe Identity UK per-verification pricing is not published.',
      owner: 'product-owner',
    },
  },

  smsPerMessage: {
    /*
     * **An assumption, not a rate**, because no SMS provider exists yet — Twilio
     * is a Phase 6 account that has not been opened. 4p is a deliberately
     * pessimistic placeholder for UK outbound SMS.
     */
    value: gbp(4),
    provenance: {
      kind: 'assumption',
      basis:
        'No SMS provider account exists (Twilio is Phase 6). 4p is a pessimistic ' +
        'placeholder for UK outbound SMS and must be replaced with a real rate.',
      owner: 'product-owner',
    },
  },

  criticalMessagesPerBooking: {
    /*
     * §4.1 makes push supplementary and requires every critical event to be
     * deliverable by email or SMS. Not every critical event needs an SMS — email
     * is free at our volume — so this counts only the ones that plausibly do.
     */
    value: 2,
    provenance: {
      kind: 'assumption',
      basis:
        'Two SMS-worthy critical events per booking (§4.1). Most notifications go by ' +
        'email, which is free at this volume.',
      owner: 'product-owner',
    },
  },

  disputeFee: {
    value: gbp(2000),
    provenance: stripePricing('2026-08-21'),
  },

  refundRate: {
    value: 0.03,
    provenance: {
      kind: 'assumption',
      basis:
        'Three bookings in a hundred refunded. No trading history exists to measure ' +
        'against; this is the number to replace first once real bookings exist.',
      owner: 'product-owner',
    },
  },

  chargebackRate: {
    value: 0.005,
    provenance: {
      kind: 'assumption',
      basis:
        'Five disputes per thousand bookings. Peer-to-peer hire with a damage protocol ' +
        'is dispute-prone; this is deliberately not optimistic.',
      owner: 'product-owner',
    },
  },

  supportPerBooking: {
    value: gbp(15),
    provenance: {
      kind: 'assumption',
      basis:
        'There is no support desk and never will be (product owner). 15p per booking ' +
        'covers the product owner’s own time on the minority of bookings that need it.',
      owner: 'product-owner',
    },
  },
};

/** Apply a blended rate to an amount. */
export function applyRate(rate: BlendedRate, to: MoneyValue): MoneyValue {
  return Money.add(Money.percentageOf(to, rate.percent), rate.fixed);
}

/** Every assumption in a model, for the worked example to print in full. */
export function assumptionsIn(
  model: CostModel,
): readonly { readonly field: string; readonly basis: string }[] {
  const found: { field: string; basis: string }[] = [];

  for (const [field, component] of Object.entries(model)) {
    if (typeof component !== 'object' || component === null) continue;
    if (!('provenance' in component)) continue;

    const { provenance } = component as CostComponent<unknown>;
    if (provenance.kind === 'assumption') {
      found.push({ field, basis: provenance.basis });
    }
  }

  return found;
}
