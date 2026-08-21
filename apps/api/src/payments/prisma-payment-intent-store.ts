import { Money } from '@platform/core';
import type { CurrencyCode } from '@platform/core';
import type { PrismaClient } from '@platform/database';
import { PaymentIntentError, TERMINAL_STATUSES } from './payment-intent.js';
import type {
  NewPaymentIntent,
  PaymentIntentOutcome,
  PaymentIntentPurpose,
  PaymentIntentRecord,
  PaymentIntentStatus,
} from './payment-intent.js';
import type { PaymentIntentStore } from './payment-intent-store.js';
import type { PaymentFailure } from './payment-provider.js';

/**
 * Payment attempts in Postgres (slice 5.2b).
 *
 * **Thin, like `PrismaLedgerStore` beside it and for the same reason**: the rules
 * live in `payment-intent.ts` and in the migration's CHECKs and partial unique
 * index. Its real work is reassembling minor units and a currency code into a
 * `Money` (ADR 0002 puts them on one record; Prisma hands back two scalars) and
 * turning two nullable columns back into a `PaymentFailure`.
 *
 * **No raw SQL** — `no-raw-sql-outside-search` confines that to
 * `search-location/`, and everything here is a primary-key read or a write on a
 * unique column.
 */

/** A row as Prisma returns it. */
type IntentRow = {
  id: string;
  bookingId: string;
  ownerId: string;
  categoryVersionId: string;
  purpose: string;
  attemptKey: string;
  status: string;
  provider: string;
  providerReference: string | null;
  itemChargeMinor: number;
  renterFeeMinor: number;
  amountMinor: number;
  currency: string;
  authorisationExpiresAt: Date | null;
  failureReason: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export class PrismaPaymentIntentStore implements PaymentIntentStore {
  constructor(private readonly prisma: PrismaClient) {}

  async begin(intent: NewPaymentIntent): Promise<PaymentIntentRecord> {
    /*
     * **Read first, then create, then read again on failure** — the shape
     * `PrismaLedgerStore.accountFor` arrived at the hard way. Prisma's `upsert`
     * is a find followed by a create rather than an atomic `ON CONFLICT`, so two
     * callers racing on the same attempt key can both find nothing and both
     * insert; one gets a unique violation. **The index makes the outcome safe —
     * one attempt exists either way — and this catch makes the loser succeed**,
     * which is what a double-pressed pay button needs to mean.
     *
     * That race is not hypothetical here. It is exactly the double press: two
     * requests, the same key, milliseconds apart. `accountFor` learned that a
     * green local run proves nothing about it — thirty concurrent callers
     * produce no rejection on the development machine and four did on CI.
     */
    const existing = await this.prisma.paymentIntent.findUnique({
      where: { attemptKey: intent.attemptKey },
    });
    if (existing !== null) return toRecord(existing);

    try {
      const row = await this.prisma.paymentIntent.create({
        data: {
          bookingId: intent.bookingId,
          ownerId: intent.ownerId,
          categoryVersionId: intent.categoryVersionId,
          purpose: intent.purpose,
          attemptKey: intent.attemptKey,
          status: 'initiated' satisfies PaymentIntentStatus,
          provider: intent.provider,
          itemChargeMinor: intent.itemCharge.amount,
          renterFeeMinor: intent.renterFee.amount,
          amountMinor: intent.amount.amount,
          currency: intent.amount.currency,
        },
      });
      return toRecord(row);
    } catch (cause) {
      const raced = await this.prisma.paymentIntent.findUnique({
        where: { attemptKey: intent.attemptKey },
      });
      if (raced !== null) return toRecord(raced);

      throw new PaymentIntentError(
        `the database refused a payment attempt against booking ${intent.bookingId}`,
        { cause },
      );
    }
  }

  async recordOutcome(
    intentId: string,
    outcome: PaymentIntentOutcome,
  ): Promise<PaymentIntentRecord> {
    try {
      const row = await this.prisma.paymentIntent.update({
        where: { id: intentId },
        data: {
          status: outcome.status,
          providerReference: outcome.providerReference,
          ...(outcome.authorisationExpiresAt === undefined
            ? {}
            : { authorisationExpiresAt: outcome.authorisationExpiresAt }),
          /*
           * **Written as a pair or not at all.** A `failed` row must carry a
           * reason — a CHECK says so — and a message with no reason would be a
           * sentence for a payer that reconciliation cannot categorise.
           */
          ...(outcome.failure === undefined
            ? {}
            : {
                failureReason: outcome.failure.reason,
                failureMessage: outcome.failure.message,
              }),
        },
      });
      return toRecord(row);
    } catch (cause) {
      /*
       * **The partial unique index is what usually lands here**, and translating
       * it is the point: `one_succeeded_intent_per_booking_and_purpose` fires
       * when a second attempt succeeds against a booking already captured, which
       * is a double charge at the provider. §8.7.1 permits one capture per
       * authorisation, so this is not a race to swallow — it is the alarm.
       */
      throw new PaymentIntentError(
        `the database refused the outcome for payment attempt ${intentId}. The ` +
          'commonest cause is a second successful attempt against a booking that ' +
          'has already been captured, which §8.7.1 does not permit',
        { cause },
      );
    }
  }

  async findById(id: string): Promise<PaymentIntentRecord | null> {
    const row = await this.prisma.paymentIntent.findUnique({ where: { id } });
    return row === null ? null : toRecord(row);
  }

  async findForBooking(bookingId: string): Promise<readonly PaymentIntentRecord[]> {
    const rows = await this.prisma.paymentIntent.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toRecord);
  }

  /**
   * Stale, unsettled attempts, oldest first (slice 5.4a).
   *
   * **`notIn` the terminal statuses rather than `in` the live ones.** The two are
   * equivalent today and stop being so the moment §8.7's expired-authorisation or
   * chargeback statuses arrive — `payment_intents.status` is deliberately not a
   * closed CHECK, precisely because it grows. Listing the live statuses here would
   * make a new one invisible to the sweep, which is the silent half of a mistake
   * whose loud half is a booking nobody reconciles.
   *
   * **`@@index([status])` carries this and no migration was added.** Non-terminal
   * rows are a small minority of the table — every settled payment ever taken is
   * excluded — so the index is selective and the `updatedAt` comparison falls on
   * few rows. Worth re-measuring if the table ever grows large; the composite
   * would be `(status, updatedAt)`, and 4.9a is the reminder to measure rather
   * than assume which index is wanted.
   */
  async findUnsettled(
    notUpdatedSince: Date,
    limit: number,
  ): Promise<readonly PaymentIntentRecord[]> {
    const rows = await this.prisma.paymentIntent.findMany({
      where: {
        status: { notIn: [...TERMINAL_STATUSES] },
        updatedAt: { lt: notUpdatedSince },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    return rows.map(toRecord);
  }
}

function toRecord(row: IntentRow): PaymentIntentRecord {
  const failure = toFailure(row);

  const currency = row.currency as CurrencyCode;

  return {
    id: row.id,
    bookingId: row.bookingId,
    ownerId: row.ownerId,
    categoryVersionId: row.categoryVersionId,
    purpose: row.purpose as PaymentIntentPurpose,
    attemptKey: row.attemptKey,
    status: row.status as PaymentIntentStatus,
    provider: row.provider,
    ...(row.providerReference === null
      ? {}
      : { providerReference: row.providerReference }),
    /*
     * `Money.money` refuses a non-integer and an unsupported currency. This
     * number is what somebody was charged, so reading it loosely is the wrong
     * kind of forgiving — the listing store makes the same argument.
     */
    itemCharge: Money.money(row.itemChargeMinor, currency),
    renterFee: Money.money(row.renterFeeMinor, currency),
    amount: Money.money(row.amountMinor, currency),
    ...(row.authorisationExpiresAt === null
      ? {}
      : { authorisationExpiresAt: row.authorisationExpiresAt }),
    ...(failure === undefined ? {} : { failure }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Two nullable columns back into one value.
 *
 * **A reason with no message is still a failure**, and the fallback sentence is
 * deliberately bland: it reaches a page, and §8.7 requires clear failure and
 * retry states rather than a provider's own words leaking through.
 */
function toFailure(row: IntentRow): PaymentFailure | undefined {
  if (row.failureReason === null) return undefined;

  return {
    reason: row.failureReason as PaymentFailure['reason'],
    message:
      row.failureMessage ?? 'That payment could not be completed. Please try again.',
  };
}
