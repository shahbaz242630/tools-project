import { Time } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import { LedgerError, accountIdentityOf, balanceOf } from '../ledger.js';
import type {
  LedgerAccountSpec,
  LedgerTransactionDraft,
  PostedLedgerTransaction,
} from '../ledger.js';
import type { LedgerAccountRecord, LedgerStore } from '../ledger-store.js';

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
