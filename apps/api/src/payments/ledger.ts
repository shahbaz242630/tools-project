import { Money } from '@platform/core';
import type { CurrencyCode, MoneyValue } from '@platform/core';

/**
 * The double-entry primitives (BRD §8.7, slice 5.1).
 *
 * **Pure logic with no store, no provider and no Nest**, for the reason
 * `booking-state-machine.ts` gives about §7: the rules that decide whether a set
 * of movements is a legal financial record are the part that must be right
 * before anything can write one, and a function with no dependencies is the only
 * kind that can be exhaustively tested.
 *
 * §8.7 is short and binding: *"Maintain double-entry or equivalently auditable
 * ledger entries. Ledger entries are immutable; corrections are made only by
 * posting reversing entries, never by editing or deleting."* Everything here
 * exists to make the second half structurally true rather than merely intended.
 *
 * **Why this is the first slice of the phase, and why it has no provider in it.**
 * BRD §4 says the platform *"must never treat a payment-provider webhook alone as
 * the accounting record"*. If our ledger is the record and the provider is only
 * the channel that executed it, then changing provider does not rewrite the
 * books — which is the whole of the portability strategy researched on 20 August
 * (`docs/phase-05-payments-and-ledger/reference-payment-provider-portability.md`).
 * Nothing in this file knows a provider exists, and that is the point.
 */

/**
 * Which side of the account an entry falls on.
 *
 * **Two values, and it will never grow**, which is why this one is a `CHECK` in
 * the database as well — unlike `bookings.state`, whose vocabulary §7 can and did
 * gain rows. `authentication_events.event_is_known` is the same call.
 */
export const LEDGER_DIRECTIONS = ['debit', 'credit'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

/**
 * The chart of accounts.
 *
 * **Three kinds, and each is traceable to a line of the BRD rather than to an
 * accounting textbook.** A chart of accounts invented ahead of the flows that
 * post to it is a vocabulary nobody can test, so the rule for this list is the
 * one §7's state table follows: a later slice that needs a fourth kind adds it
 * *with the flow that posts to it*, and with a test.
 *
 * - `provider_clearing` — funds held at the payment provider. §8.7 requires
 *   *"separate charges and transfers (not destination charges) so owner funds can
 *   be held on the platform balance until return confirmation"*, and this is that
 *   balance as we account for it.
 * - `owner_payable` — what we owe one owner. §8.7: *"Owner payout is delayed until
 *   return confirmation or dispute deadline"*, so between capture and payout the
 *   money is held by us and owed to them. That is a liability, and saying so is
 *   what stops it being mistaken for revenue.
 * - `platform_revenue` — fees the platform has earned (§3.4).
 */
export const LEDGER_ACCOUNT_KINDS = [
  'provider_clearing',
  'owner_payable',
  'platform_revenue',
] as const;
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];

/**
 * The side that *increases* each kind of account.
 *
 * Assets increase by debit; liabilities and revenue increase by credit. This is
 * ordinary double-entry and is written down only because the alternative is every
 * later reader deriving it, and one of them deriving it wrong.
 */
const NORMAL_SIDE: Record<LedgerAccountKind, LedgerDirection> = {
  provider_clearing: 'debit',
  owner_payable: 'credit',
  platform_revenue: 'credit',
};

/**
 * Whether a kind of account is held by the platform or by one person.
 *
 * **This is not cosmetic — it is what `ledger_accounts` uniqueness depends on.**
 * A per-owner kind must have an owner and a platform kind must not, or "the
 * balance owed to Dale" silently becomes two accounts that each hold half of it.
 */
const ACCOUNT_HOLDER: Record<LedgerAccountKind, 'platform' | 'user'> = {
  provider_clearing: 'platform',
  owner_payable: 'user',
  platform_revenue: 'platform',
};

/**
 * What a transaction records.
 *
 * **Two kinds, both named by §8.7, and a reversal is not among them.** A
 * correction keeps the kind of the thing it corrects and is identified by
 * `reversesTransactionId` being set — so "the payout was wrong" stays a fact
 * about a payout instead of becoming a third kind of event that reconciliation
 * has to learn about.
 */
export const LEDGER_TRANSACTION_KINDS = [
  'hire_charge_captured',
  'owner_payout',
] as const;
export type LedgerTransactionKind = (typeof LEDGER_TRANSACTION_KINDS)[number];

/** Raised when a set of movements is not a legal financial record. */
export class LedgerError extends Error {
  /**
   * Takes `ErrorOptions` so an adapter translating a database failure can keep
   * the original on `cause` — `preserve-caught-error` refuses dropping it, and
   * the Prisma error is what carries the constraint name somebody will need.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LedgerError';
  }
}

/** One side of one movement, as a caller proposes it. */
export interface LedgerEntryDraft {
  readonly accountId: string;
  readonly direction: LedgerDirection;
  /**
   * **Strictly positive.** ADR 0002 permits a negative `Money` because refunds
   * and reversals need one, but in a double-entry record the direction already
   * carries the sign: a negative debit and a positive credit are the same
   * movement written two ways, and a ledger that admits both cannot be summed
   * without first deciding which convention each row used. So the sign lives in
   * exactly one place and `assertPostable` refuses the other.
   */
  readonly amount: MoneyValue;
}

/** A complete transaction, as a caller proposes it. */
export interface LedgerTransactionDraft {
  /**
   * What makes posting this twice a no-op rather than a duplicate.
   *
   * §11.2's gate is *"duplicate and out-of-order provider webhooks produce
   * exactly one ledger effect"*, and §8.7 requires idempotency keys on create,
   * capture, refund and payout. The key is `@unique` in the database, so the
   * guarantee is the database's rather than a check-then-write the way
   * `webhook_events` already does it for deliveries.
   */
  readonly idempotencyKey: string;
  readonly kind: LedgerTransactionKind;
  readonly currency: CurrencyCode;
  /** The hire this concerns, where there is one. §6.2 lists `booking` on the entry. */
  readonly bookingId?: string;
  /**
   * When the money actually moved, which is **not** when we wrote it down.
   *
   * Reconciliation compares our record against the provider's day (§8.7:
   * *"reconcile provider transactions against internal records daily"*), and the
   * provider's clock is the one that decides which day a movement belongs to. A
   * single timestamp would put a capture at 23:59 on our side of midnight and
   * their other side, and produce a reconciliation break every night that is
   * nobody's error.
   */
  readonly occurredAt: Date;
  readonly entries: readonly LedgerEntryDraft[];
  /**
   * Set only on a correction, naming the transaction being reversed.
   *
   * `@unique` in the database, so a transaction can be reversed **at most once**.
   * Reversing a reversal is legal and is how you undo a mistaken correction — it
   * points at the correction, not at the original.
   */
  readonly reversesTransactionId?: string;
}

/** A transaction that has been written, as it reads back. */
export interface PostedLedgerTransaction extends LedgerTransactionDraft {
  readonly id: string;
  /** When we wrote it. See `occurredAt` for why both exist. */
  readonly recordedAt: Date;
}

/** The two sides of a draft, summed. */
export interface LedgerTotals {
  readonly debits: MoneyValue;
  readonly credits: MoneyValue;
}

/** Sum each side of a draft. Does not judge it — `assertPostable` does that. */
export function totalsOf(draft: LedgerTransactionDraft): LedgerTotals {
  const on = (direction: LedgerDirection): MoneyValue =>
    Money.sum(
      draft.entries
        .filter((entry) => entry.direction === direction)
        .map((entry) => entry.amount),
      draft.currency,
    );

  return { debits: on('debit'), credits: on('credit') };
}

/**
 * Refuse anything that is not a legal financial record.
 *
 * **Every rule here is also enforced by the database**, and that duplication is
 * deliberate rather than redundant: this one produces a sentence naming what is
 * wrong, and the database one produces the guarantee. The five rules are the
 * ones that cannot be recovered from after the fact — an unbalanced transaction
 * is not detectable later, because there is nothing to compare it against.
 */
export function assertPostable(draft: LedgerTransactionDraft): void {
  if (draft.entries.length < 2) {
    throw new LedgerError(
      'a ledger transaction needs at least two entries: one entry can never balance',
    );
  }

  if (draft.idempotencyKey.trim() === '') {
    throw new LedgerError('a ledger transaction needs an idempotency key');
  }

  for (const entry of draft.entries) {
    if (entry.amount.currency !== draft.currency) {
      throw new LedgerError(
        `entry currency ${entry.amount.currency} does not match transaction currency ${draft.currency}`,
      );
    }
    if (!Number.isInteger(entry.amount.amount)) {
      throw new LedgerError('a ledger entry amount must be whole minor units');
    }
    if (entry.amount.amount <= 0) {
      throw new LedgerError(
        'a ledger entry amount must be positive: the direction carries the sign, not the amount',
      );
    }
  }

  const { debits, credits } = totalsOf(draft);
  if (debits.amount !== credits.amount) {
    throw new LedgerError(
      `a ledger transaction must balance: debits ${debits.amount} != credits ${credits.amount}`,
    );
  }
}

/**
 * Build the transaction that undoes one, per §8.7's *"corrections are made only
 * by posting reversing entries"*.
 *
 * Every entry keeps its account and its amount and swaps its side, so the pair
 * sums to nothing on every account it touched. **Nothing is edited and nothing is
 * deleted** — after a reversal the ledger holds both the mistake and its
 * correction, which is what makes it evidence.
 *
 * The caller supplies the new idempotency key and `occurredAt` because those are
 * facts about the correction rather than about the thing corrected — a
 * correction posted a week later occurred a week later.
 */
export function reversalOf(
  posted: PostedLedgerTransaction,
  correction: { readonly idempotencyKey: string; readonly occurredAt: Date },
): LedgerTransactionDraft {
  return {
    idempotencyKey: correction.idempotencyKey,
    kind: posted.kind,
    currency: posted.currency,
    ...(posted.bookingId === undefined ? {} : { bookingId: posted.bookingId }),
    occurredAt: correction.occurredAt,
    reversesTransactionId: posted.id,
    entries: posted.entries.map((entry) => ({
      accountId: entry.accountId,
      direction: oppositeOf(entry.direction),
      amount: entry.amount,
    })),
  };
}

/** The other side. */
export function oppositeOf(direction: LedgerDirection): LedgerDirection {
  return direction === 'debit' ? 'credit' : 'debit';
}

/** The side that increases an account of this kind. */
export function normalSideOf(kind: LedgerAccountKind): LedgerDirection {
  return NORMAL_SIDE[kind];
}

/** What identifies an account, before it has been written. */
export interface LedgerAccountSpec {
  readonly kind: LedgerAccountKind;
  readonly currency: CurrencyCode;
  /** Required for a per-person kind, and refused for a platform one. */
  readonly ownerId?: string;
}

/**
 * The account's natural identity, and the column the database makes unique.
 *
 * **This is what stops one balance being split across two rows.** Postgres treats
 * NULLs as distinct in a unique index, so a composite unique on
 * `(kind, ownerId, currency)` would happily hold two platform `provider_clearing`
 * accounts in GBP and net neither of them correctly. Deriving one string makes
 * the guarantee expressible in Prisma *and* makes "the account for this, creating
 * it if absent" a single race-safe upsert.
 *
 * It also refuses the two shapes that would be meaningless: a per-person account
 * with nobody attached, and a platform account attributed to somebody.
 */
export function accountIdentityOf(spec: LedgerAccountSpec): string {
  const holder = holderOf(spec.kind);

  if (holder === 'user') {
    if (spec.ownerId === undefined || spec.ownerId.trim() === '') {
      throw new LedgerError(`${spec.kind} is held by one person and needs an owner`);
    }
    return `${spec.kind}:${spec.ownerId}:${spec.currency}`;
  }

  if (spec.ownerId !== undefined) {
    throw new LedgerError(
      `${spec.kind} is the platform's own and cannot be attributed to a person`,
    );
  }
  return `${spec.kind}:${spec.currency}`;
}

/** Whether accounts of this kind belong to one person or to the platform. */
export function holderOf(kind: LedgerAccountKind): 'platform' | 'user' {
  return ACCOUNT_HOLDER[kind];
}

/**
 * What an account holds, given every entry against it.
 *
 * Signed **towards the account's normal side**, so a positive `owner_payable`
 * means we owe them money rather than meaning anything about debits. A negative
 * balance is legal and is worth surfacing rather than clamping: §8.7 names
 * *"negative balances"* among the things that must be handled, and a balance
 * that cannot go negative is one that hides a chargeback.
 */
export function balanceOf(
  kind: LedgerAccountKind,
  currency: CurrencyCode,
  entries: readonly Pick<LedgerEntryDraft, 'direction' | 'amount'>[],
): MoneyValue {
  const normal = normalSideOf(kind);

  const increases = Money.sum(
    entries.filter((e) => e.direction === normal).map((e) => e.amount),
    currency,
  );
  const decreases = Money.sum(
    entries.filter((e) => e.direction !== normal).map((e) => e.amount),
    currency,
  );

  return Money.subtract(increases, decreases);
}

/**
 * A convenience for the commonest shape: money arriving somewhere and being
 * apportioned across several places.
 *
 * It exists so a caller cannot forget the balancing side — the one mistake
 * `assertPostable` catches most often, and the one that is most tedious to write
 * out by hand for a three-way marketplace split.
 *
 * **It does not decide the amounts.** ADR 0002 requires splits to use
 * `allocate`, and doing that here would put pricing in the ledger; the caller
 * arrives with shares that already sum correctly and this refuses them if they
 * do not.
 */
export function apportion(input: {
  readonly from: { readonly accountId: string; readonly amount: MoneyValue };
  readonly to: readonly {
    readonly accountId: string;
    readonly amount: MoneyValue;
  }[];
  readonly currency: CurrencyCode;
}): LedgerEntryDraft[] {
  const shares = Money.sum(
    input.to.map((share) => share.amount),
    input.currency,
  );

  if (shares.amount !== input.from.amount.amount) {
    throw new LedgerError(
      `apportioned shares ${shares.amount} do not sum to the amount moved ${input.from.amount.amount}`,
    );
  }

  return [
    {
      accountId: input.from.accountId,
      direction: 'debit',
      amount: input.from.amount,
    },
    ...input.to.map((share) => ({
      accountId: share.accountId,
      direction: 'credit' as const,
      amount: share.amount,
    })),
  ];
}

/** Zero in this currency, for callers summing an empty set of entries. */
export function noBalance(currency: CurrencyCode): MoneyValue {
  return Money.zero(currency);
}

/** Minor units as `Money`, for the tests and stores that read integers back. */
export function minorUnits(amount: number, currency: CurrencyCode): MoneyValue {
  return Money.money(amount, currency);
}
