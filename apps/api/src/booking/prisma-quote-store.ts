import { Money } from '@platform/core';
import type { MoneyValue } from '@platform/core';
import type { QuoteLineItem } from '@platform/contracts';
import { parseQuoteLineItems } from '@platform/contracts';
import type { PrismaClient } from '@platform/database';
import { damageExcessColumns, toAppliedExcess } from './damage-excess-columns.js';
import type {
  ExportableQuote,
  NewQuote,
  QuoteRecord,
  QuoteStore,
} from './quote-store.js';

/**
 * Quotes in Postgres (slice 4.4b).
 *
 * **No raw SQL**, like `prisma-availability-store.ts` beside it: every query here
 * is a primary-key or a renter-scoped read, which Prisma expresses directly, and
 * `no-raw-sql-outside-search` confines hand-written SQL to `search-location/`.
 *
 * **The money columns are three integers and one currency, and this is the file
 * that has to keep them coherent.** ADR 0002 puts minor units and the currency on
 * the same record; Prisma gives back four separate scalars, so the reassembly
 * happens once, here, rather than at each caller.
 */

export class PrismaQuoteStore implements QuoteStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(quote: NewQuote): Promise<QuoteRecord> {
    const row = await this.prisma.quote.create({
      data: {
        listingId: quote.listingId,
        renterId: quote.renterId,
        startAt: quote.startAt,
        endAt: quote.endAt,
        timeZone: quote.timeZone,
        renterPostcode: quote.renterPostcode,
        itemChargeAmount: quote.itemCharge.amount,
        renterFeeAmount: quote.renterFee.amount,
        totalAmount: quote.total.amount,
        currency: quote.total.currency,
        minimumFeeApplied: quote.minimumFeeApplied,
        /*
         * **Spread into a plain array before it becomes JSON.** Prisma's `Json`
         * input rejects a `readonly` tuple type, and more importantly the value
         * stored has to be exactly what the contract describes — see
         * `toLineItems` below for the other half of that round trip.
         */
        lineItems: quote.lineItems.map((item) => ({ ...item })),
        // Two columns, no currency of its own -- `currency` above is the one
        // this row is denominated in (ADR 0002).
        ...damageExcessColumns(quote.appliedExcess),
        categoryVersionId: quote.categoryVersionId,
        expiresAt: quote.expiresAt,
      },
    });

    return toRecord(row);
  }

  async findForRenter(id: string, renterId: string): Promise<QuoteRecord | null> {
    /*
     * `findFirst` with the renter in the `where`, not `findUnique` then a
     * comparison. The scope belongs in the query for the reason every
     * owner-scoped read in this project puts it there: a comparison afterwards is
     * a line somebody can delete, and the row is already in memory by the time it
     * runs.
     */
    const row = await this.prisma.quote.findFirst({ where: { id, renterId } });

    return row === null ? null : toRecord(row);
  }

  async listUnbookedForRenter(
    renterId: string,
    limit: number,
  ): Promise<readonly ExportableQuote[]> {
    const rows = await this.prisma.quote.findMany({
      // **The eraser's predicate, verbatim.** See the port: the export is a
      // mirror of the erasure and drifts from it the moment this is rewritten.
      where: { renterId, bookings: { none: {} } },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        totalAmount: true,
        currency: true,
        renterPostcode: true,
        createdAt: true,
        expiresAt: true,
        listing: { select: { title: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id,
      startAt: row.startAt,
      endAt: row.endAt,
      itemTitle: row.listing.title,
      total: Money.money(row.totalAmount, row.currency as MoneyValue['currency']),
      renterPostcode: row.renterPostcode,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }));
  }

  async postcodesFor(
    quoteIds: readonly string[],
    renterId: string,
  ): Promise<ReadonlyMap<string, string>> {
    // An empty `IN ()` is a round trip to be told nothing, on the export path
    // for somebody who has never booked — which is most people.
    if (quoteIds.length === 0) return new Map();

    const rows = await this.prisma.quote.findMany({
      // Scoped by renter as well as by id, so the postcodes this can return are
      // only ever the caller's own.
      where: { id: { in: [...quoteIds] }, renterId },
      select: { id: true, renterPostcode: true },
    });

    return new Map(rows.map((row) => [row.id, row.renterPostcode]));
  }

  async deleteUnbookedForRenter(renterId: string): Promise<number> {
    /*
     * **`bookings: { none: {} }` is the whole of the 17 August erasure decision.**
     * A quote nobody acted on is a price we offered and nothing more; a quote a
     * booking was made from carries that booking's terms, which belong to the
     * counterparty too.
     *
     * **The condition is in the `where`, not in a filter afterwards.** A read-then-
     * delete would race a request being made in between, and the `RESTRICT` on
     * `bookings.quoteId` would then turn that race into a failed erasure — which
     * is the right failure and still a failure. Postgres evaluates this as one
     * statement.
     *
     * `deleteMany` is idempotent by construction — a second call deletes nothing
     * and reports zero, which is what `PersonalDataEraser` requires of a retry.
     */
    const { count } = await this.prisma.quote.deleteMany({
      where: { renterId, bookings: { none: {} } },
    });

    return count;
  }
}

/** The row shape this adapter reads back. Declared so `toRecord` needs no `any`. */
interface QuoteRow {
  readonly id: string;
  readonly listingId: string;
  readonly renterId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly timeZone: string;
  readonly renterPostcode: string;
  readonly itemChargeAmount: number;
  readonly renterFeeAmount: number;
  readonly totalAmount: number;
  readonly currency: string;
  readonly minimumFeeApplied: boolean;
  readonly lineItems: unknown;
  readonly damageExcessAmount: number | null;
  readonly damageExcessBoundBy: string | null;
  readonly categoryVersionId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

function toRecord(row: QuoteRow): QuoteRecord {
  return {
    id: row.id,
    listingId: row.listingId,
    renterId: row.renterId,
    startAt: row.startAt,
    endAt: row.endAt,
    timeZone: row.timeZone,
    renterPostcode: row.renterPostcode,
    itemCharge: toMoney(row.itemChargeAmount, row.currency),
    renterFee: toMoney(row.renterFeeAmount, row.currency),
    total: toMoney(row.totalAmount, row.currency),
    minimumFeeApplied: row.minimumFeeApplied,
    lineItems: toLineItems(row.lineItems, row.id),
    appliedExcess: toAppliedExcess(row, `Quote ${row.id}`),
    categoryVersionId: row.categoryVersionId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * A column pair as `Money`.
 *
 * **`Money.money` rather than an object literal**, which is the treatment
 * `prisma-listing-store.ts` gives the same problem: it refuses a non-integer and
 * an unsupported currency, so a row written before a validation existed — or by
 * hand — fails here rather than becoming a price.
 */
function toMoney(amount: number, currency: string): MoneyValue {
  return Money.money(amount, currency as MoneyValue['currency']);
}

/**
 * The stored line items, validated on the way out.
 *
 * **Parsed rather than cast**, for the reason every `Json` column in this schema
 * is: Postgres guarantees the value is JSON and nothing more. This is the only
 * column in the table whose shape the database cannot check beyond "a non-empty
 * array", and it is what the price is explained by — so a row that has drifted
 * fails loudly here instead of rendering a breakdown that does not add up.
 */
function toLineItems(raw: unknown, quoteId: string): readonly QuoteLineItem[] {
  return parseQuoteLineItems(raw, `the line items on quote ${quoteId}`);
}
