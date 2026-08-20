import { Time } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import { LedgerError, accountIdentityOf, balanceOf } from '../ledger.js';
import type {
  LedgerAccountSpec,
  LedgerTransactionDraft,
  PostedLedgerTransaction,
} from '../ledger.js';
import type { LedgerAccountRecord, LedgerStore } from '../ledger-store.js';
import { PaymentIntentError } from '../payment-intent.js';
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
