import { Time } from '@platform/core';
import type { CategoryFeePolicySource } from './category-fee-policy-source.js';
import { hireCaptureEntries, settleHire } from './hire-settlement.js';
import type { HireCharge, HireSettlement } from './hire-settlement.js';
import { LedgerError } from './ledger.js';
import type { LedgerService } from './ledger.service.js';
import {
  PaymentIntentError,
  assertSameAttempt,
  dispositionOf,
  hireCaptureKey,
  isTerminal,
} from './payment-intent.js';
import type { NewPaymentIntent, PaymentIntentRecord } from './payment-intent.js';
import type { PaymentIntentStore } from './payment-intent-store.js';
import type {
  PayerAction,
  PaymentAttempt,
  PaymentProvider,
} from './payment-provider.js';

/**
 * Taking money for a hire, and writing it down (BRD §8.7, §6.2, slice 5.2b).
 *
 * **This is the slice that joins the two halves Phase 5 already had.** 5.1 built
 * books nothing posts to; 5.2a built a port nothing calls and settlement maths
 * nothing settles. This calls the port, records the attempt, and posts the
 * capture to the books when the money actually moves.
 *
 * ## The order of operations, which is the only interesting thing here
 *
 * Four steps, and each is before the next for a reason that cost something to
 * work out:
 *
 * 1. **Read the pinned fee policy, before anything else.** §8.2 binds a booking
 *    to the terms it was made under, and if we cannot find those terms we cannot
 *    settle honestly. Refusing *before* the provider is called means we never
 *    take money we would not know how to divide.
 *
 * 2. **Settle on paper, still before the provider.** `settleHire` refuses a
 *    charge whose total is not its parts, which would otherwise put an error
 *    into the ledger where §8.7 makes it permanent. Doing the arithmetic first
 *    turns a reconciliation mystery into a refusal nobody paid for.
 *
 * 3. **Write the attempt, then call the provider — never the other way.** A
 *    crash between the two leaves a row saying we may have asked for money,
 *    which reconciliation can chase. The other order leaves a charge with no
 *    record of it at all, and nothing to chase it with. This is the classic
 *    dual-write problem and the cheap half of it is choosing which side to lose.
 *
 * 4. **Post to the ledger, then update the attempt.** Same argument one step
 *    later, and the same direction: the ledger is the accounting record (ADR
 *    0051), so a crash that leaves the books right and the mirror stale is
 *    recoverable — {@link refresh} fixes it. A crash the other way round leaves
 *    a payment marked succeeded with no entry against it, and nothing to notice.
 *    Both writes are idempotent, so the repair is a retry rather than a repair.
 *
 * ## The attempt row is self-sufficient, and that is not decoration
 *
 * An outcome usually arrives **out of band**: a 3-D Secure challenge finishes
 * minutes after the request that opened it, and the confirmation is a webhook
 * carrying a provider reference and nothing else. Whatever handles that has no
 * booking in hand, and Payments may not read `bookings` (BRD §5.1). So the
 * attempt carries what it takes to divide itself — the payee, the pinned
 * category version and the charge's two parts — copied on when it opens, the way
 * §8.2 already has a booking copy its terms from the quote. **Without it the
 * ordinary SCA journey could not be completed at all**, which is how it was
 * found: by testing the common case rather than an edge.
 *
 * ## What is not here, deliberately
 *
 * **No controller, no route and no Nest token.** 5.2c gives this a caller and
 * decides who may reach it; a token now would be dead wiring, which is the call
 * 5.1 made and 4.1 before it. **No damage security** — §8.7.2 authorises at the
 * collection window, which is Phase 7, and the intent record already carries the
 * `capture_before` column it will need. **No refund and no payout**, which are
 * their own flows with their own ledger vocabulary; the rule 5.1 set is that a
 * transaction kind arrives with the flow that posts it.
 */
export class PaymentsService {
  constructor(
    private readonly intents: PaymentIntentStore,
    private readonly provider: PaymentProvider,
    private readonly ledger: LedgerService,
    /** The pinned fee policy, answered by Catalogue (§8.2). */
    private readonly feePolicies: CategoryFeePolicySource,
    /** Injected so an occurrence time is provable without waiting (ADR 0003). */
    private readonly now: () => Date = Time.nowUtc,
  ) {}

  /**
   * Take the hire charge for a booking, or say what the payer must do next.
   *
   * **Returns rather than resolves the payment**, because Strong Customer
   * Authentication means it usually cannot resolve here: a UK card payment
   * frequently needs a 3-D Secure challenge, so the ordinary answer is *"the
   * payer must confirm in their browser"* and the outcome arrives later. §7's
   * state table already knew — `ACCEPTED → AWAITING_PAYMENT → RESERVED |
   * PAYMENT_FAILED`.
   *
   * **Re-presenting an attempt key makes no second charge.** The row is found
   * rather than created and the provider is not called again — which is what
   * makes a double-pressed pay button safe, and why the caller must mint one key
   * per attempt rather than one per press.
   *
   * Throws {@link PaymentIntentError} when the hire cannot be attempted at all.
   */
  async payForHire(instruction: HirePaymentInstruction): Promise<HirePaymentOutcome> {
    // Refused here, before anything is written and long before the provider is
    // called. Money we cannot divide is money we should never have taken.
    await this.settle(instruction);

    const proposed: NewPaymentIntent = {
      bookingId: instruction.bookingId,
      purpose: 'hire_charge',
      attemptKey: instruction.attemptKey,
      ownerId: instruction.ownerId,
      categoryVersionId: instruction.categoryVersionId,
      itemCharge: instruction.charge.itemCharge,
      renterFee: instruction.charge.renterFee,
      amount: instruction.charge.total,
      provider: this.provider.name,
    };

    /*
     * **`begin` is get-or-create, so what comes back may be somebody else's
     * row.** Usually that is the same press of the same button, which is the
     * point. Occasionally it is a key reused for different money — a booking id
     * where an attempt id was meant — and returning that quietly would tell a
     * caller it charged an amount it did not. The rule is checked here rather
     * than in the adapter so there is one of it rather than one per store; the
     * ledger makes the same call in `LedgerService.post`.
     */
    const intent = assertSameAttempt(proposed, await this.intents.begin(proposed));

    /*
     * **An attempt that has already reached the provider is not sent again.**
     * This is the double-press guard, and it is here rather than in the store
     * because the store's job is to return the row either way — deciding that a
     * row in `pending_payer_action` means *"do not charge them a second time"*
     * is a rule about money.
     *
     * `initiated` is the exception and the reason the status exists: the row was
     * written and the call never happened, or happened and we never heard. The
     * provider is called with the same idempotency key, which is what makes
     * repeating it safe on their side too.
     */
    if (intent.status !== 'initiated') {
      return { intent };
    }

    const attempt = await this.provider.begin({
      idempotencyKey: instruction.attemptKey,
      amount: instruction.charge.total,
      /*
       * **The item's name and nothing else** (§8.4.1). This reaches a card
       * statement, so it must carry no address, no postcode and nobody's name —
       * the port says so where the field is declared.
       */
      description: instruction.itemTitle,
    });

    const recorded = await this.applyOutcome(intent, attempt);

    return attempt.payerAction === undefined
      ? { intent: recorded }
      : { intent: recorded, payerAction: attempt.payerAction };
  }

  /**
   * Ask the provider where an attempt got to, and record it.
   *
   * **This is the reconciling read, and it is why the port has two methods.**
   * §8.7 requires daily reconciliation against the provider and BRD §4 forbids
   * treating a webhook alone as the accounting record — so there has to be a way
   * to ask rather than wait. It is also what completes the ordinary SCA journey:
   * a renter who finishes a 3-D Secure challenge leaves an attempt in
   * `pending_payer_action`, and something has to go and look.
   *
   * **Safe to call repeatedly, and that is the requirement rather than a
   * nicety.** §11.2's gate is that duplicate and out-of-order provider events
   * produce exactly one ledger effect. Calling this ten times against a
   * succeeded attempt posts once.
   *
   * Resolves to null when there is no such attempt.
   */
  async refresh(intentId: string): Promise<PaymentIntentRecord | null> {
    const intent = await this.intents.findById(intentId);
    if (intent === null) return null;

    /*
     * **A settled attempt is not re-read**, which saves a provider call on every
     * duplicate webhook — the case §11.2 is actually about. It is a
     * short-circuit rather than the guarantee: `dispositionOf` would ignore the
     * repeat anyway, and the ledger's per-booking key would refuse to post twice
     * even if it did not.
     */
    if (isTerminal(intent.status)) return intent;

    if (intent.providerReference === undefined) {
      /*
       * Written but never sent, or sent and never answered. There is nothing to
       * read — the provider has no reference to look up — and inventing one
       * would be a lie. The caller retries the attempt with the same key, which
       * is what `initiated` is for.
       */
      return intent;
    }

    const attempt = await this.provider.read(intent.providerReference);
    return this.applyOutcome(intent, attempt);
  }

  /** Every attempt against a booking, newest first. */
  async attemptsFor(bookingId: string): Promise<readonly PaymentIntentRecord[]> {
    return this.intents.findForBooking(bookingId);
  }

  /**
   * Write an outcome down, posting the capture first if the money moved.
   *
   * **The division is recomputed from the attempt row rather than passed in**,
   * so there is exactly one path from an outcome to a ledger posting whether the
   * outcome arrived inline or by webhook an hour later. The row carries
   * everything that computation needs — see `HireSettlementTerms`, which exists
   * for exactly this.
   */
  private async applyOutcome(
    intent: PaymentIntentRecord,
    attempt: PaymentAttempt,
  ): Promise<PaymentIntentRecord> {
    const disposition = dispositionOf(intent.status, attempt.status);
    if (disposition.kind === 'ignore') return intent;

    if (attempt.status === 'succeeded') {
      await this.postCapture(intent, attempt);
    }

    return this.intents.recordOutcome(intent.id, {
      status: attempt.status,
      /*
       * A succeeded attempt must carry a reference — the database says so, and
       * it is what daily reconciliation matches against. Anything earlier may
       * legitimately have none yet.
       */
      providerReference: attempt.providerReference,
      ...(attempt.failure === undefined ? {} : { failure: attempt.failure }),
    });
  }

  /**
   * Post the hire capture to the books.
   *
   * **Keyed by booking, not by attempt.** A hire is captured once however many
   * times somebody tried, so a second posting under the same key returns the
   * first rather than doubling it — and a posting under the same key for
   * *different* money throws, which is the alarm we would want if a booking were
   * somehow charged twice.
   */
  private async postCapture(
    intent: PaymentIntentRecord,
    attempt: PaymentAttempt,
  ): Promise<void> {
    const settlement = await this.settle({
      bookingId: intent.bookingId,
      categoryVersionId: intent.categoryVersionId,
      charge: {
        itemCharge: intent.itemCharge,
        renterFee: intent.renterFee,
        total: intent.amount,
      },
    });

    const currency = settlement.renterPays.currency;

    const clearing = await this.ledger.accountFor({
      kind: 'provider_clearing',
      currency,
    });
    const payable = await this.ledger.accountFor({
      kind: 'owner_payable',
      currency,
      ownerId: intent.ownerId,
    });
    const revenue = await this.ledger.accountFor({
      kind: 'platform_revenue',
      currency,
    });

    await this.ledger.post({
      idempotencyKey: hireCaptureKey(intent.bookingId),
      kind: 'hire_charge_captured',
      currency,
      bookingId: intent.bookingId,
      /*
       * **The provider's clock where it gave us one** (§8.7). Reconciliation is
       * daily and their clock decides which day a movement belongs to; ours is
       * the fallback and is wrong by at most a round trip.
       */
      occurredAt: attempt.occurredAt ?? this.now(),
      entries: hireCaptureEntries({
        settlement,
        providerClearingAccountId: clearing.id,
        ownerPayableAccountId: payable.id,
        platformRevenueAccountId: revenue.id,
      }),
    });
  }

  /**
   * Divide a hire's money, refusing rather than guessing.
   *
   * Called twice on the paying path — once before the provider, to refuse a hire
   * we could not settle, and once when the money has moved, from the attempt's
   * own stored terms. **That is not redundancy**: the first is a gate on
   * something a person is about to be charged for, and the second is the only
   * one an out-of-band confirmation can reach. `settleHire` is pure, so the
   * second is a primary-key read and some arithmetic.
   */
  private async settle(input: {
    readonly bookingId: string;
    readonly categoryVersionId: string;
    readonly charge: HireCharge;
  }): Promise<HireSettlement> {
    const policy = await this.feePolicies.findFeePolicy(input.categoryVersionId);

    if (policy === null) {
      /*
       * **Never a fallback to the current version.** §8.2 binds a booking to the
       * terms it was made under, and today's rates would pay an owner a number
       * nobody agreed to — silently, and with every test still green. The port's
       * docblock argues this at length because it is the exact mistake this
       * slice exists to make impossible.
       */
      throw new PaymentIntentError(
        `booking ${input.bookingId} pins category version ` +
          `${input.categoryVersionId}, which cannot be found: refusing to settle ` +
          'against terms nobody agreed to',
      );
    }

    try {
      return settleHire(input.charge, policy);
    } catch (error) {
      /*
       * `settleHire` throws `LedgerError` when the charge disagrees with itself.
       * Translated rather than propagated, because the caller is about to take
       * money and the sentence should say whose booking; `preserve-caught-error`
       * keeps the original, which names the two numbers.
       */
      if (error instanceof LedgerError) {
        throw new PaymentIntentError(
          `booking ${input.bookingId} cannot be settled: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

/** What Payments needs in order to take money for a hire. */
export interface HirePaymentInstruction {
  readonly bookingId: string;
  /**
   * Who is owed the proceeds — the listing's owner.
   *
   * **Passed in rather than looked up, and that is the module boundary.** BRD
   * §5.1 gives Booking the hire and Payments the money; a port here asking
   * *"whose booking is this"* would make Payments a reader of Booking's tables
   * by proxy. The caller knows, because it is the module that accepted the
   * booking. 5.2c is where that call is made.
   */
  readonly ownerId: string;
  /**
   * What makes one press of pay one charge.
   *
   * **Per attempt.** A retry after a decline mints a new one; a second press of
   * the same button presents the same one.
   */
  readonly attemptKey: string;
  /**
   * The booking's **stored** money, copied onto its row at the moment it was
   * made (§8.2) — never re-derived from the listing, which may have been
   * repriced since.
   */
  readonly charge: HireCharge;
  /** The category version the booking pinned, whose fee policy settles it. */
  readonly categoryVersionId: string;
  /**
   * What was hired, for the payer's statement.
   *
   * **The item's title and nothing else** — never an address (§8.4.1).
   */
  readonly itemTitle: string;
}

/** Where an attempt got to, and what the payer must do about it. */
export interface HirePaymentOutcome {
  readonly intent: PaymentIntentRecord;
  /**
   * What the payer must do, while there is something.
   *
   * **Returned and never stored.** The token is a short-lived bearer value the
   * provider's own browser library consumes; the port forbids anything reading,
   * branching on or persisting it, and a column holding one would be a
   * provider's format back in our database.
   */
  readonly payerAction?: PayerAction;
}
