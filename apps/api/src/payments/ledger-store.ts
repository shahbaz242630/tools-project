import type { MoneyValue } from '@platform/core';
import type {
  LedgerAccountKind,
  LedgerAccountSpec,
  LedgerTransactionDraft,
  PostedLedgerTransaction,
} from './ledger.js';

/**
 * How the ledger is written and read (BRD §8.7, slice 5.1).
 *
 * **No update and no delete, and that is the whole shape of it** — the same
 * omission `AuditLog` makes and for a stronger reason: §8.7 says corrections are
 * made *"only by posting reversing entries, never by editing or deleting"*. A
 * port with an update method is an invitation to edit a financial record, and the
 * database refuses it anyway, so the only thing such a method could produce is a
 * runtime error at the bottom of a call somebody thought would work.
 *
 * **Nothing here mentions a payment provider.** A provider adapter will eventually
 * *cause* a posting, but it will do so by calling an application service, exactly
 * as the Clerk webhook does for identity — the ledger's own port stays ignorant of
 * who moved the money, which is what makes changing that party cheap.
 */

/** An account as it reads back. */
export interface LedgerAccountRecord {
  readonly id: string;
  readonly kind: LedgerAccountKind;
  readonly ownerId?: string;
  readonly currency: string;
  /** The derived natural key — see `accountIdentityOf`. */
  readonly identity: string;
}

export interface LedgerStore {
  /**
   * The account for this kind, person and currency, creating it if absent.
   *
   * **Get-or-create rather than create**, because a chart of accounts has no
   * lifecycle worth managing: an account exists because something needed to post
   * to it. Implementations must be safe against two callers racing for the same
   * account — the unique `identity` column is what makes that possible.
   */
  accountFor(spec: LedgerAccountSpec): Promise<LedgerAccountRecord>;

  /**
   * Write a balanced transaction and its entries in one database transaction.
   *
   * **Idempotent on `idempotencyKey`**: posting the same key twice returns the
   * transaction already written rather than writing a second one, which is
   * §11.2's *"duplicate and out-of-order provider webhooks produce exactly one
   * ledger effect"*. The caller is expected to have run `assertPostable` first;
   * the database asserts it again at COMMIT regardless.
   */
  post(draft: LedgerTransactionDraft): Promise<PostedLedgerTransaction>;

  findById(id: string): Promise<PostedLedgerTransaction | null>;

  findByIdempotencyKey(key: string): Promise<PostedLedgerTransaction | null>;

  /**
   * What an account holds, signed towards its normal side.
   *
   * Summed in the database rather than by reading every entry into memory: a
   * ledger only grows, so the read that walks it is the one that stops working
   * first.
   */
  balanceOf(accountId: string): Promise<MoneyValue>;
}
