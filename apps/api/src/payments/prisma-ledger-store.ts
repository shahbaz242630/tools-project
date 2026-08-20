import { Money } from '@platform/core';
import type { CurrencyCode, MoneyValue } from '@platform/core';
import type { PrismaClient } from '@platform/database';
import { LedgerError, accountIdentityOf, normalSideOf } from './ledger.js';
import type {
  LedgerAccountKind,
  LedgerAccountSpec,
  LedgerDirection,
  LedgerTransactionDraft,
  PostedLedgerTransaction,
} from './ledger.js';
import type { LedgerAccountRecord, LedgerStore } from './ledger-store.js';

/**
 * The ledger in Postgres (slice 5.1).
 *
 * **No raw SQL**, like the booking stores beside it — `no-raw-sql-outside-search`
 * confines hand-written SQL to `search-location/`, and every query here is a
 * primary-key read, an upsert on a unique column, or a grouped sum that Prisma
 * expresses directly.
 *
 * **This adapter is deliberately thin, and the thinness is the point.** The rules
 * live in `ledger.ts` and in the migration's CHECKs and triggers; if this file
 * ever grows a decision, the decision is in the wrong place. Its one real job is
 * reassembling minor units and a currency code into a `Money` — ADR 0002 puts them
 * on the same record and Prisma hands back separate scalars.
 */

/** A transaction with its entries, as Prisma returns it. */
type TransactionRow = {
  id: string;
  idempotencyKey: string;
  kind: string;
  currency: string;
  bookingId: string | null;
  occurredAt: Date;
  recordedAt: Date;
  reversesId: string | null;
  entries: {
    accountId: string;
    direction: string;
    amountMinor: number;
    currency: string;
  }[];
};

export class PrismaLedgerStore implements LedgerStore {
  constructor(private readonly prisma: PrismaClient) {}

  async accountFor(spec: LedgerAccountSpec): Promise<LedgerAccountRecord> {
    const identity = accountIdentityOf(spec);

    // Upsert on the derived `identity` column, which is what that column exists
    // for — the composite (kind, ownerId, currency) form is not upsertable in
    // Prisma at all when part of it is null.
    //
    // **`upsert` alone is not enough, and believing it was is a defect this file
    // shipped with.** Prisma's upsert is a find followed by a create, not an
    // atomic `ON CONFLICT`, so two callers can both find nothing and both
    // insert — and one of them gets `P2002`. It passed locally and failed on CI
    // with four concurrent callers, which is the honest shape of a race: it
    // usually wins.
    //
    // The unique index is what makes the outcome *safe* — one row exists either
    // way. This catch is what makes it *succeed*: the loser reads the winner's
    // row instead of raising, which is what "get or create" has to mean.
    try {
      const row = await this.prisma.ledgerAccount.upsert({
        where: { identity },
        create: {
          identity,
          kind: spec.kind,
          currency: spec.currency,
          ...(spec.ownerId === undefined ? {} : { ownerId: spec.ownerId }),
        },
        update: {},
      });

      return toAccount(row);
    } catch (cause) {
      const raced = await this.prisma.ledgerAccount.findUnique({
        where: { identity },
      });
      if (raced !== null) return toAccount(raced);
      throw cause;
    }
  }

  async post(draft: LedgerTransactionDraft): Promise<PostedLedgerTransaction> {
    const existing = await this.findByIdempotencyKey(draft.idempotencyKey);
    if (existing !== null) return existing;

    try {
      const row = await this.prisma.ledgerTransaction.create({
        data: {
          idempotencyKey: draft.idempotencyKey,
          kind: draft.kind,
          currency: draft.currency,
          occurredAt: draft.occurredAt,
          ...(draft.bookingId === undefined ? {} : { bookingId: draft.bookingId }),
          ...(draft.reversesTransactionId === undefined
            ? {}
            : { reversesId: draft.reversesTransactionId }),
          entries: {
            // **No `currency` here, and its absence is the guarantee.** Because
            // the entry's foreign key to its transaction is composite on
            // `(id, currency)`, Prisma inherits the column from the parent rather
            // than accepting it — so an entry denominated differently from its
            // transaction is not merely refused, it cannot be expressed. The
            // account side is still checked, by the second composite key.
            create: draft.entries.map((entry) => ({
              accountId: entry.accountId,
              direction: entry.direction,
              amountMinor: entry.amount.amount,
            })),
          },
        },
        include: { entries: true },
      });

      return toTransaction(row);
    } catch (cause) {
      // **Prisma discards the database's own message here, so the error code
      // cannot be trusted to say what happened.** This create has a nested
      // `entries` write, which Prisma runs inside a transaction it manages —
      // and anything that fails at COMMIT there (our deferred balance trigger, or
      // a unique index lost to another connection) comes back as `P2028
      // "Transaction already closed: A rollback cannot be executed on a committed
      // transaction"`, with the trigger's sentence and the constraint's name both
      // gone. A create *without* nested writes reports `P0001` and the real
      // message, which is what makes this easy to disbelieve until you hit it.
      //
      // So we ask the database what is true now rather than asking the error what
      // happened. Both questions below are cheap and unambiguous.
      const raced = await this.findByIdempotencyKey(draft.idempotencyKey);
      if (raced !== null) {
        // Somebody else posted this exact key first. That is not a failure — it
        // is §11.2's "exactly one ledger effect" working.
        return raced;
      }

      if (draft.reversesTransactionId !== undefined) {
        const existing = await this.prisma.ledgerTransaction.findUnique({
          where: { reversesId: draft.reversesTransactionId },
        });
        if (existing !== null) {
          // A refusal, not a success: this correction did not happen and must
          // not be reported as though it had.
          throw new LedgerError(
            `ledger transaction ${draft.reversesTransactionId} has already been reversed`,
            { cause },
          );
        }
      }

      throw new LedgerError(
        'the database refused this posting. The commonest cause is a transaction ' +
          'that does not balance, whose message Prisma discards — run assertPostable ' +
          'on the draft to see which side is short',
        { cause },
      );
    }
  }

  async findById(id: string): Promise<PostedLedgerTransaction | null> {
    const row = await this.prisma.ledgerTransaction.findUnique({
      where: { id },
      include: { entries: true },
    });
    return row === null ? null : toTransaction(row);
  }

  async findByIdempotencyKey(key: string): Promise<PostedLedgerTransaction | null> {
    const row = await this.prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: key },
      include: { entries: true },
    });
    return row === null ? null : toTransaction(row);
  }

  async balanceOf(accountId: string): Promise<MoneyValue> {
    const account = await this.prisma.ledgerAccount.findUnique({
      where: { id: accountId },
    });
    if (account === null) {
      throw new LedgerError(`no such ledger account: ${accountId}`);
    }

    // Summed by the database. A ledger only grows, so the read that pulls every
    // entry into memory is the one that stops working first.
    const sides = await this.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      where: { accountId },
      _sum: { amountMinor: true },
    });

    const normal = normalSideOf(account.kind as LedgerAccountKind);
    const totalOn = (direction: LedgerDirection): number =>
      sides.find((side) => side.direction === direction)?._sum.amountMinor ?? 0;

    return Money.money(
      totalOn(normal) - totalOn(normal === 'debit' ? 'credit' : 'debit'),
      account.currency as CurrencyCode,
    );
  }
}

function toAccount(row: {
  id: string;
  kind: string;
  ownerId: string | null;
  currency: string;
  identity: string;
}): LedgerAccountRecord {
  return {
    id: row.id,
    kind: row.kind as LedgerAccountKind,
    ...(row.ownerId === null ? {} : { ownerId: row.ownerId }),
    currency: row.currency,
    identity: row.identity,
  };
}

function toTransaction(row: TransactionRow): PostedLedgerTransaction {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    kind: row.kind as PostedLedgerTransaction['kind'],
    currency: row.currency as CurrencyCode,
    ...(row.bookingId === null ? {} : { bookingId: row.bookingId }),
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    ...(row.reversesId === null ? {} : { reversesTransactionId: row.reversesId }),
    entries: row.entries.map((entry) => ({
      accountId: entry.accountId,
      direction: entry.direction as LedgerDirection,
      amount: Money.money(entry.amountMinor, entry.currency as CurrencyCode),
    })),
  };
}
