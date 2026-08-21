import { Time } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import { createRecordingLogger } from '@platform/observability/testing';
import { LedgerService } from '../ledger.service.js';
import { PaymentsService } from '../payments.service.js';
import { ReconciliationService } from '../reconciliation.service.js';
import { LedgerError, accountIdentityOf, balanceOf } from '../ledger.js';
import type {
  LedgerAccountSpec,
  LedgerTransactionDraft,
  PostedLedgerTransaction,
} from '../ledger.js';
import type { LedgerAccountRecord, LedgerStore } from '../ledger-store.js';
import { PaymentIntentError, TERMINAL_STATUSES } from '../payment-intent.js';
import type {
  NewPaymentIntent,
  PaymentIntentOutcome,
  PaymentIntentRecord,
} from '../payment-intent.js';
import type { PaymentIntentStore } from '../payment-intent-store.js';
import type {
  PaymentAttempt,
  PaymentProvider,
  PaymentRequest,
} from '../payment-provider.js';

/**
 * An in-memory ledger (slice 5.1).
 *
 * **It models the database's guarantees rather than only its happy path**, which
 * is the difference between a fake and a stub: the unique idempotency key, the
 * at-most-one-reversal rule and get-or-create are all here, because a service
 * test that passes against a fake with none of them proves nothing about the
 * behaviour the database will actually produce.
 *
 * What it deliberately does **not** model is the balance rule and immutability.
 * Those are asserted by `assertPostable` before the store is reached and by the
 * migration's triggers after it, and `prisma-ledger-store.db.test.ts` is what
 * proves the triggers fire. A fake that re-implemented them would be a second
 * place for the rule to live and the easier of the two to get wrong.
 */
export class FakeLedgerStore implements LedgerStore {
  private readonly accounts = new Map<string, LedgerAccountRecord>();
  private readonly transactions: PostedLedgerTransaction[] = [];
  private sequence = 0;

  accountFor(spec: LedgerAccountSpec): Promise<LedgerAccountRecord> {
    const identity = accountIdentityOf(spec);

    const existing = this.accounts.get(identity);
    if (existing !== undefined) return Promise.resolve(existing);

    this.sequence += 1;
    const account: LedgerAccountRecord = {
      id: `fake-account-${this.sequence}`,
      kind: spec.kind,
      ...(spec.ownerId === undefined ? {} : { ownerId: spec.ownerId }),
      currency: spec.currency,
      identity,
    };
    this.accounts.set(identity, account);
    return Promise.resolve(account);
  }

  post(draft: LedgerTransactionDraft): Promise<PostedLedgerTransaction> {
    const existing = this.transactions.find(
      (t) => t.idempotencyKey === draft.idempotencyKey,
    );
    if (existing !== undefined) return Promise.resolve(existing);

    if (draft.reversesTransactionId !== undefined) {
      const alreadyReversed = this.transactions.some(
        (t) => t.reversesTransactionId === draft.reversesTransactionId,
      );
      if (alreadyReversed) {
        // The database says this with a unique violation on `reversesId`. The
        // sentence differs; the refusal is the part under test.
        throw new LedgerError(
          `ledger transaction ${draft.reversesTransactionId} has already been reversed`,
        );
      }
    }

    this.sequence += 1;
    const posted: PostedLedgerTransaction = {
      ...draft,
      id: `fake-txn-${this.sequence}`,
      // Fixed, so a test can assert on it. `Time.fromIsoUtc` rather than a bare
      // `new Date` because this file is not a test and the lint rule that keeps
      // timezone handling explicit applies to it.
      recordedAt: Time.fromIsoUtc('2026-08-20T12:00:00.000Z'),
    };
    this.transactions.push(posted);
    return Promise.resolve(posted);
  }

  findById(id: string): Promise<PostedLedgerTransaction | null> {
    return Promise.resolve(this.transactions.find((t) => t.id === id) ?? null);
  }

  findByIdempotencyKey(key: string): Promise<PostedLedgerTransaction | null> {
    return Promise.resolve(
      this.transactions.find((t) => t.idempotencyKey === key) ?? null,
    );
  }

  balanceOf(accountId: string): Promise<MoneyValue> {
    const account = [...this.accounts.values()].find((a) => a.id === accountId);
    if (account === undefined) {
      throw new LedgerError(`no such ledger account: ${accountId}`);
    }

    const entries = this.transactions
      .flatMap((t) => t.entries)
      .filter((entry) => entry.accountId === accountId);

    const currency = account.currency as MoneyValue['currency'];
    return Promise.resolve(balanceOf(account.kind, currency, entries));
  }

  /** Everything posted, for assertions. Not part of the port. */
  get posted(): readonly PostedLedgerTransaction[] {
    return this.transactions;
  }
}

/**
 * An in-memory record of payment attempts (slice 5.2b).
 *
 * **It models the two guarantees the database actually provides**, for the
 * reason `FakeLedgerStore` gives above: a service test that passes against a
 * fake with neither proves nothing. Those two are the unique `attemptKey` — the
 * double-press guard — and the partial unique index permitting at most one
 * *succeeded* attempt per booking and purpose, which is §8.7.1's single-capture
 * rule.
 *
 * What it deliberately does not model is the CHECKs. Those refuse malformed rows
 * rather than wrong outcomes, and `prisma-payment-intent-store.db.test.ts` is
 * what proves they fire.
 */
export class FakePaymentIntentStore implements PaymentIntentStore {
  private readonly rows: PaymentIntentRecord[] = [];
  private sequence = 0;

  /**
   * Put a row in as it already is (slice 5.4a).
   *
   * **The sweep's tests need attempts that are already stale and already in a
   * particular status**, which `begin` cannot produce — it stamps `updatedAt` to
   * now and always starts at `initiated`. The pattern `InMemoryBookingStore`
   * already uses for `givenOwner`: a seam for arranging a world, not a second way
   * for production code to write.
   */
  given(record: PaymentIntentRecord): this {
    this.rows.push(record);
    return this;
  }

  begin(intent: NewPaymentIntent): Promise<PaymentIntentRecord> {
    const existing = this.rows.find((row) => row.attemptKey === intent.attemptKey);
    if (existing !== undefined) return Promise.resolve(existing);

    this.sequence += 1;
    const now = Time.nowUtc();
    const record: PaymentIntentRecord = {
      id: `fake-intent-${this.sequence}`,
      bookingId: intent.bookingId,
      ownerId: intent.ownerId,
      categoryVersionId: intent.categoryVersionId,
      purpose: intent.purpose,
      attemptKey: intent.attemptKey,
      status: 'initiated',
      provider: intent.provider,
      itemCharge: intent.itemCharge,
      renterFee: intent.renterFee,
      amount: intent.amount,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(record);
    return Promise.resolve(record);
  }

  recordOutcome(
    intentId: string,
    outcome: PaymentIntentOutcome,
  ): Promise<PaymentIntentRecord> {
    const index = this.rows.findIndex((row) => row.id === intentId);
    if (index === -1) {
      return Promise.reject(
        new PaymentIntentError(`no such payment attempt: ${intentId}`),
      );
    }

    const current = this.rows[index] as PaymentIntentRecord;

    // The partial unique index, modelled. A second capture against one booking
    // is a double charge, and §8.7.1 permits only one.
    if (outcome.status === 'succeeded') {
      const alreadyCaptured = this.rows.some(
        (row) =>
          row.id !== intentId &&
          row.bookingId === current.bookingId &&
          row.purpose === current.purpose &&
          row.status === 'succeeded',
      );
      if (alreadyCaptured) {
        return Promise.reject(
          new PaymentIntentError(
            `booking ${current.bookingId} has already been captured for ${current.purpose}`,
          ),
        );
      }
    }

    const updated: PaymentIntentRecord = {
      ...current,
      status: outcome.status,
      providerReference: outcome.providerReference,
      ...(outcome.authorisationExpiresAt === undefined
        ? {}
        : { authorisationExpiresAt: outcome.authorisationExpiresAt }),
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      updatedAt: Time.nowUtc(),
    };
    this.rows[index] = updated;
    return Promise.resolve(updated);
  }

  findById(id: string): Promise<PaymentIntentRecord | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  findForBooking(bookingId: string): Promise<readonly PaymentIntentRecord[]> {
    return Promise.resolve(
      [...this.rows].reverse().filter((row) => row.bookingId === bookingId),
    );
  }

  /**
   * Stale, unsettled attempts, oldest first (slice 5.4a).
   *
   * **`notIn` the terminal statuses, matching the Prisma adapter clause for
   * clause.** A fake that filtered by the *live* statuses would keep passing after
   * §8.7 adds a status the real query would newly return — and the service tests
   * that believe this fake are the ones asserting the sweep looks at everything it
   * should.
   */
  findUnsettled(
    notUpdatedSince: Date,
    limit: number,
  ): Promise<readonly PaymentIntentRecord[]> {
    const stale = this.rows
      .filter((row) => !TERMINAL_STATUSES.includes(row.status))
      .filter((row) => row.updatedAt.getTime() < notUpdatedSince.getTime())
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit);

    return Promise.resolve(stale);
  }
}

/**
 * A payment provider that does what the test tells it to (slice 5.2b).
 *
 * **The test fake BRD §5 and CLAUDE.md require of every provider**, delivered
 * here rather than in 5.2a because 5.2a had nothing to exercise it. The
 * production adapter is 5.2e and is the one piece of this phase blocked on an
 * external account.
 *
 * **It records what it was asked**, because several of the rules in this slice
 * are about *not* calling a provider — a second press of pay, a settled attempt
 * being refreshed — and the only way to assert that is to count.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly requests: PaymentRequest[] = [];
  readonly reads: string[] = [];

  private nextReference = 0;

  constructor(
    /** What `begin` should report. Defaults to taking the money at once. */
    private outcome: Omit<PaymentAttempt, 'providerReference'> = {
      status: 'succeeded',
    },
  ) {}

  /** Change what the next call reports — a decline, a challenge, a wait. */
  willReport(outcome: Omit<PaymentAttempt, 'providerReference'>): void {
    this.outcome = outcome;
  }

  begin(request: PaymentRequest): Promise<PaymentAttempt> {
    this.requests.push(request);
    this.nextReference += 1;
    return Promise.resolve({
      ...this.outcome,
      providerReference: `fake-ref-${this.nextReference}`,
    });
  }

  read(providerReference: string): Promise<PaymentAttempt> {
    this.reads.push(providerReference);
    return Promise.resolve({ ...this.outcome, providerReference });
  }
}

/**
 * The Payments module's slice of `AppModuleOptions` (slice 5.4a).
 *
 * **The counterpart to `bookingModuleFakes`, and it exists for the same reason**:
 * `AppModuleOptions` makes every dependency required — deliberately, because an
 * optional one is what ten boot sites forget — so a service added here must not
 * mean editing every integration test that has no interest in payments.
 *
 * **Real services over in-memory storage**, so the routing, the internal-trigger
 * guard and the sweep's own logic all still run. The store starts empty, which is
 * also production's state today: nothing can open an attempt while
 * `booking.payment` is off, so the sweep correctly finds nothing.
 */
export function paymentsModuleFakes(): {
  readonly reconciliation: ReconciliationService;
} {
  const intents = new FakePaymentIntentStore();

  const payments = new PaymentsService(
    intents,
    new FakePaymentProvider(),
    new LedgerService(new FakeLedgerStore()),
    { findFeePolicy: () => Promise.resolve(null) },
  );

  return {
    reconciliation: new ReconciliationService(
      intents,
      payments,
      createRecordingLogger().logger,
    ),
  };
}
