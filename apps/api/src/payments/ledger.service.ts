import type { MoneyValue } from '@platform/core';
import {
  LedgerError,
  accountIdentityOf,
  assertPostable,
  reversalOf,
} from './ledger.js';
import type {
  LedgerAccountSpec,
  LedgerEntryDraft,
  LedgerTransactionDraft,
  PostedLedgerTransaction,
} from './ledger.js';
import type { LedgerAccountRecord, LedgerStore } from './ledger-store.js';

/**
 * Posting to the platform's books (BRD §8.7, slice 5.1).
 *
 * **Three methods, and the interesting one is `post`.** Everything the ledger
 * guarantees is either in `ledger.ts` (the rules) or in the migration (the
 * enforcement); this service is where the two meet a caller, and its one original
 * responsibility is deciding what "I have already posted this" means.
 *
 * **Nothing here knows a payment provider exists**, and a later slice's Stripe
 * adapter will reach the ledger by calling this rather than by writing rows —
 * which is what keeps a provider change confined to an adapter.
 */
export class LedgerService {
  constructor(private readonly store: LedgerStore) {}

  /**
   * The account for a kind, person and currency, creating it if absent.
   *
   * Exposed because a caller assembling a transaction needs account ids before it
   * can name them in entries, and inventing an account inline is how a second
   * `owner_payable` for the same person gets created.
   */
  async accountFor(spec: LedgerAccountSpec): Promise<LedgerAccountRecord> {
    // Derived here as well as in the store so a meaningless spec — a per-person
    // account with nobody attached — is refused before it reaches the database.
    accountIdentityOf(spec);
    return this.store.accountFor(spec);
  }

  /**
   * Post a balanced transaction, exactly once.
   *
   * **Re-presenting an idempotency key returns what was written the first time.**
   * That is §11.2's requirement and it is the whole reason the key exists: a
   * provider that retries a webhook must not produce a second ledger effect.
   *
   * **Re-presenting a key with different content throws instead**, and this is
   * the part worth arguing for. Silently returning the earlier transaction would
   * be "idempotent" in the letter and wrong in substance — the caller believes it
   * posted the amounts it passed, and it did not. A key that was reused by
   * accident is a defect, and the only moment it is cheap to find is now.
   */
  async post(draft: LedgerTransactionDraft): Promise<PostedLedgerTransaction> {
    assertPostable(draft);

    const posted = await this.store.post(draft);
    assertSameTransaction(draft, posted);
    return posted;
  }

  /**
   * Undo a transaction by posting its reverse (§8.7).
   *
   * Nothing is edited and nothing is deleted: afterwards the ledger holds both
   * the mistake and its correction, which is what makes it evidence rather than
   * an assertion.
   *
   * **A transaction can be reversed at most once** — the database's unique
   * `reversesId` decides that, not a check here, because a check here loses the
   * race between two clicks.
   */
  async reverse(
    transactionId: string,
    correction: { readonly idempotencyKey: string; readonly occurredAt: Date },
  ): Promise<PostedLedgerTransaction> {
    const original = await this.store.findById(transactionId);
    if (original === null) {
      throw new LedgerError(
        `cannot reverse ${transactionId}: no such ledger transaction`,
      );
    }

    return this.post(reversalOf(original, correction));
  }

  /** What an account holds, signed towards its normal side. */
  async balance(spec: LedgerAccountSpec): Promise<MoneyValue> {
    const account = await this.accountFor(spec);
    return this.store.balanceOf(account.id);
  }
}

/**
 * Refuse an idempotency key that has been reused for different money.
 *
 * Compared as a **multiset** of entries rather than a list, because the order
 * entries were written in carries no meaning — two callers assembling the same
 * transaction with the owner's share first or second have posted the same thing.
 */
function assertSameTransaction(
  draft: LedgerTransactionDraft,
  posted: PostedLedgerTransaction,
): void {
  const differs =
    draft.kind !== posted.kind ||
    draft.currency !== posted.currency ||
    draft.bookingId !== posted.bookingId ||
    draft.reversesTransactionId !== posted.reversesTransactionId ||
    fingerprintOf(draft.entries) !== fingerprintOf(posted.entries);

  if (differs) {
    throw new LedgerError(
      `idempotency key ${draft.idempotencyKey} has already been used for a different transaction`,
    );
  }
}

function fingerprintOf(entries: readonly LedgerEntryDraft[]): string {
  return entries
    .map(
      (entry) =>
        `${entry.accountId}|${entry.direction}|${entry.amount.amount}|${entry.amount.currency}`,
    )
    .sort()
    .join(',');
}
