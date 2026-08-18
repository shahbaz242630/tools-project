import type { PrismaClient } from '@platform/database';
import { CALENDAR_OCCUPYING_STATES } from './booking-state-machine.js';
import type {
  AvailabilityBlockRecord,
  AvailabilityStore,
  NewAvailabilityBlock,
  UnavailableReason,
} from './availability-store.js';

/**
 * The owner's calendar in Postgres (slice 4.3a).
 *
 * **No raw SQL here, and that was a decision rather than a default.** The
 * obvious way to ask these questions is `period && tstzrange(…)`, which uses the
 * GiST index and states the `[)` bound once — but `no-raw-sql-outside-search`
 * confines hand-written SQL to `search-location/`, and widening an invariant is
 * a heavier act than the query is worth. Half-open overlap is expressible as two
 * comparisons, so it is expressed as two comparisons.
 *
 * **What that costs, stated plainly.** The `[)` rule now lives in two places —
 * the trigger that builds `period` and `overlaps` below — and a test pins them
 * to the same answer. The GiST index goes unused by this file.
 *
 * **The index is not therefore pointless.** Every query here is about *one*
 * listing and is served by `(listingId, startAt)`. What needs the range index is
 * the date filter in slice 4.9, which asks the opposite question — *which of
 * these thousands of listings is free between two dates* — and that one will
 * want raw SQL and the ADR to go with it. Creating it now is the reasoning
 * `listing_locations`' GiST index already used in 2.5b: an index added later
 * against a populated table is a lock nobody wants.
 */

/**
 * Half-open overlap, `[)`, as Prisma comparisons.
 *
 * Two ranges overlap when each starts before the other ends. The exclusive end
 * is what makes `<` and `>` correct rather than `<=` and `>=`: a block ending at
 * 09:00 and a hire starting at 09:00 do not touch, because the item changes
 * hands. Same bound the trigger writes into `period`.
 *
 * **Exported from slice 4.6, for the booking store next door.** §7.1's
 * auto-decline has to find every `REQUESTED` booking overlapping the accepted
 * period, which is this predicate again — and the phase already carries *"the
 * `[)` bound is stated twice"* as tech debt. A third statement of it would be the
 * one that eventually disagrees; sharing keeps the count at two — this function
 * and the trigger that builds `period` — with a db test pinning them to the same
 * answer.
 */
export function overlaps(startAt: Date, endAt: Date) {
  return { startAt: { lt: endAt }, endAt: { gt: startAt } };
}

export class PrismaAvailabilityStore implements AvailabilityStore {
  constructor(private readonly prisma: PrismaClient) {}

  async block(block: NewAvailabilityBlock): Promise<AvailabilityBlockRecord> {
    const row = await this.prisma.availabilityBlock.create({
      data: {
        listingId: block.listingId,
        startAt: block.startAt,
        endAt: block.endAt,
        reason: block.reason,
      },
    });

    return toRecord(row);
  }

  async unblock(id: string, listingId: string): Promise<boolean> {
    /*
     * `deleteMany` rather than `delete`, and the listing in the `where`.
     * `delete` throws when it matches nothing, which would make "already gone"
     * and "not yours" the same error — and the second must not be answerable
     * from the first. A count lets the caller say 404 to both without ever
     * learning which it was.
     */
    const { count } = await this.prisma.availabilityBlock.deleteMany({
      where: { id, listingId },
    });

    return count > 0;
  }

  async listBlocks(
    listingId: string,
    from: Date,
    to: Date,
  ): Promise<readonly AvailabilityBlockRecord[]> {
    /*
     * **Blocks that *touch* the window, not blocks contained by it.** A
     * fortnight's block seen through a one-week calendar view has neither end
     * inside the window, and the obvious query — `startAt >= from AND endAt <=
     * to` — would draw that week as free. Overlap is the right question.
     */
    const rows = await this.prisma.availabilityBlock.findMany({
      where: { listingId, ...overlaps(from, to) },
      // `id` after `startAt` for the reason every ordered read here carries a
      // tiebreak: two blocks starting at the same instant compare equal, and a
      // calendar that reorders between two loads looks broken.
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toRecord);
  }

  async reasonUnavailable(
    listingId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<UnavailableReason | null> {
    /*
     * **Blocked is asked first, and the order is the answer** — see
     * `UnavailableReason`. When a period is both, the owner is told the thing
     * they can actually change; telling them "somebody has booked it" sends
     * them looking for a booking they cannot remove while the block sits there.
     */
    const blocked = await this.prisma.availabilityBlock.findFirst({
      where: { listingId, ...overlaps(startAt, endAt) },
      select: { id: true },
    });
    if (blocked !== null) return 'blocked';

    /*
     * **Only §8.5.1's nine count**, read from `booking-state-machine.ts` rather
     * than restated. A `REQUESTED` booking does not make dates unavailable —
     * that is §7.1's whole design — and a cancelled one certainly does not.
     */
    const booked = await this.prisma.booking.findFirst({
      where: {
        listingId,
        state: { in: [...CALENDAR_OCCUPYING_STATES] },
        ...overlaps(startAt, endAt),
      },
      select: { id: true },
    });

    return booked === null ? null : 'booked';
  }
}

interface BlockRow {
  readonly id: string;
  readonly listingId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly reason: string | null;
}

function toRecord(row: BlockRow): AvailabilityBlockRecord {
  return {
    id: row.id,
    listingId: row.listingId,
    startAt: row.startAt,
    endAt: row.endAt,
    reason: row.reason,
  };
}
