/**
 * The owner's calendar (BRD §8.5, slice 4.3a).
 *
 * §8.5 asks for three things — *"available, unavailable and booked periods"* —
 * and this port owns one and a half of them. **Unavailable** is what an owner
 * declares here. **Booked** is `bookings`. **Available is neither**, and is
 * computed rather than stored, because a stored "available" is a third fact
 * that can disagree with the other two.
 *
 * **Why availability is answered here rather than in Catalogue.** An owner
 * reaches their calendar from their listing, so filing it with listings is the
 * instinct. But the question this answers — *may this period be booked* — is a
 * booking question, it needs the `tstzrange` machinery the overlap constraint
 * already needs, and keeping ranges in one module means one place in this system
 * understands them. Catalogue asks through a port when it needs to, exactly as
 * it does for proximity and for booking references.
 */

/** A period the owner has declared unavailable. */
export interface AvailabilityBlockRecord {
  readonly id: string;
  readonly listingId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  /**
   * The owner's own note, or null.
   *
   * **Never leaves the owner's own surface.** A renter is told a period is
   * unavailable and never why: "away", "lent to my brother" and "servicing" are
   * all somebody's private business. It exists so a calendar of grey blocks is
   * still manageable a month later.
   */
  readonly reason: string | null;
}

export interface NewAvailabilityBlock {
  readonly listingId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly reason: string | null;
}

/**
 * Why a period cannot be booked — **or `null`, meaning it can**.
 *
 * **A reason rather than a boolean**, because the two cases are answered
 * differently on screen and by different people. A renter who lands on somebody
 * else's booking is told the dates are taken and offered others; an owner
 * looking at their own calendar needs to see which of the two it was, because
 * only one of them is theirs to change. A boolean would force every caller to
 * ask a second question to find out what to say.
 *
 * **`blocked` wins when both are true**, and the order is deliberate rather
 * than arbitrary: it is the answer the owner can act on. A period that is both
 * booked and blocked is one where telling them "somebody has booked it" invites
 * them to go looking for a booking they cannot remove, when the thing they
 * actually control is sitting right there.
 */
export type UnavailableReason = 'blocked' | 'booked';

export interface AvailabilityStore {
  /**
   * Declare a period unavailable.
   *
   * **It does not refuse a period something is already booked for.** Blocking
   * dates that are taken is redundant rather than harmful — the answer to "is
   * this available" is no either way — and refusing it would mean an owner
   * tidying their calendar gets an error about a booking they already know
   * about. What the *request* path must not do is book over a block, and that is
   * checked there.
   */
  block(block: NewAvailabilityBlock): Promise<AvailabilityBlockRecord>;

  /**
   * Remove a block, by id and owner's listing.
   *
   * **Scoped by listing rather than taking a bare id**, which is the shape every
   * ownership-checked read in this project uses: an id alone is a value that
   * arrives from a URL, and a delete that trusts one is a delete anybody can
   * aim. Returns whether anything was removed, so the caller can answer 404
   * rather than reporting success for a row that was never there.
   */
  unblock(id: string, listingId: string): Promise<boolean>;

  /** This listing's blocks that touch the window, in date order. */
  listBlocks(
    listingId: string,
    from: Date,
    to: Date,
  ): Promise<readonly AvailabilityBlockRecord[]>;

  /**
   * Why this period cannot be booked, or null if it can.
   *
   * **One question, both tables, one round trip** — rather than two reads the
   * caller combines. The combination *is* the rule §8.5 states, and a caller
   * that assembled it would be a second place for "available" to be defined,
   * which is how the calendar and the request path come to disagree about the
   * same week.
   *
   * **Only calendar-occupying bookings count** (§8.5.1's nine, via
   * `booking-state-machine.ts`). A `REQUESTED` booking does not make dates
   * unavailable — §7.1 — and a cancelled one certainly does not.
   */
  reasonUnavailable(
    listingId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<UnavailableReason | null>;
}
