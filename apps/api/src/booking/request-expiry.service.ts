import { Time } from '@platform/core';
import type { Logger } from '@platform/observability';
import { assertTransition } from './booking-state-machine.js';
import type { BookingStore, ExpirySweepResult } from './booking-store.js';

/**
 * Expiring unanswered requests (BRD §8.6, §14's *request expiry worker* — slice
 * 4.7a).
 *
 * ## What this makes true, and what was already true
 *
 * **The rule existed before this service did, which is why the slice is small.**
 * 4.5a stamped `requestExpiresAt` onto every booking from its category's
 * configured deadline. 4.6a already refuses to accept a request past it and
 * `findPendingRequests` already hides one from the owner. So a lapsed request was
 * *already* unacceptable and *already* invisible — it simply still **said
 * `REQUESTED`**, which is a row claiming to be waiting for an answer that nothing
 * would accept.
 *
 * This is therefore not a new rule. It is the state catching up with the rule, and
 * that distinction is worth keeping: if this sweep never ran, nobody would be
 * bound to a hire they thought was dead. What they would get is a renter's
 * dashboard (4.8) listing a request as pending forever.
 *
 * ## It is a separate service, not a method on `BookingsService`
 *
 * Every method there takes an actor — a renter making a request, an owner
 * answering one — and refuses in that person's words. **A sweep has no actor and
 * nobody to refuse.** It is the platform acting on its own clock, its events carry
 * `actorId: null`, and it is reached by a machine rather than by a session. Folding
 * it in would put the one unauthenticated path in the module beside the ones whose
 * whole job is scoping to a caller, which is how a scope check comes to be
 * forgotten. `identity/` made the same split for the same reason (H4).
 *
 * ## No notification is sent, and that is deliberate rather than pending
 *
 * §7.1 requires an auto-declined renter to be told; the same is true of one whose
 * request lapsed. **There is no channel** — no verified domain, no templates, no
 * notifications module until Phase 6 — and the product owner's instruction of
 * 16 August is that 4.7 emits and Phase 6 delivers.
 *
 * **What "emits" means here is the `booking_events` row, and there is no event bus
 * to add.** §6.2 calls that table the booking's immutable state history; it is
 * append-only, enforced by a trigger, and it is precisely the record Phase 6 will
 * read to decide who is owed a message. Building a bus now would be a mechanism
 * with no subscriber — the reason `booking_events` itself was deferred from 4.2 to
 * 4.5a, because a table with no writer is a dead control, and the same argument
 * applies to a bus with no reader.
 *
 * So nothing here pretends to notify anybody, and nothing logs as though it had.
 */
export class RequestExpiryService {
  /**
   * How many requests one sweep may expire.
   *
   * **Engineering judgement, not BRD text**, and stated here rather than passed in
   * so there is one number to find. The sweep is the only operation in this module
   * that can meet an arbitrarily large backlog — a worker stopped for a week comes
   * back to everything that lapsed meanwhile — and an unbounded `UPDATE` over that
   * would hold row locks for as long as it took while the API queued behind it.
   *
   * Five hundred is far above any plausible real batch (the platform has six
   * bookings) and far below the size at which one transaction becomes a problem. A
   * sweep that fills it says so in `reachedLimit`, and the caller asks again — so
   * the bound delays a backlog rather than losing any of it.
   */
  private static readonly BATCH_LIMIT = 500;

  constructor(
    private readonly bookings: BookingStore,
    private readonly logger: Logger,
    /** Injected so a sweep is provable without waiting two days (ADR 0003). */
    private readonly now: () => Date = Time.nowUtc,
  ) {}

  /**
   * Expire every request whose deadline has passed, up to the batch bound.
   *
   * **Safe to call as often as you like, and safe to call twice at once.** The
   * store puts the state predicate inside the `UPDATE`, so the work is idempotent:
   * a second sweep finds nothing, and a sweep racing an owner's acceptance loses
   * that row rather than overwriting it. This is what makes a re-delivered job
   * harmless, which matters because a re-delivered job is the one thing
   * `apps/worker`'s shutdown sequence is built around.
   *
   * Returns what it expired **and whether the batch filled**, so the caller can
   * decide to come back sooner rather than waiting for the next tick. Nothing here
   * retries: a failed sweep is a failed job, and the queue is what owns retrying.
   */
  async sweep(): Promise<ExpirySweepResult> {
    /*
     * **Asserted even though no branch depends on it**, exactly as
     * `BookingsService` asserts its own three. §7 opens by requiring transitions
     * to be validated centrally, and a background job is the single easiest place
     * for a state change to be invented — there is no page to look at and no
     * person to notice. If `REQUESTED → EXPIRED` ever left §7's table, this throws
     * on the next sweep rather than quietly writing a state the machine forbids.
     */
    assertTransition('REQUESTED', 'EXPIRED');

    const result = await this.bookings.expireRequests(
      this.now(),
      RequestExpiryService.BATCH_LIMIT,
    );
    const { expired, reachedLimit } = result;

    if (expired.length === 0) {
      /*
       * Debug rather than info: this is the answer almost every sweep gives, and
       * an hourly line saying "nothing happened" is how a log stops being read.
       * The job's own completion is recorded by the worker either way (4.7b).
       */
      this.logger.debug('no requests to expire');
      return result;
    }

    /*
     * **Counts and ids, never a renter or an item.** A log line is not a
     * projection: §10.1's retention reaches Loki (14 days today) and application
     * logs are the one place personal data leaks without anybody choosing to put
     * it there. Booking ids are ours and meaningless alone.
     */
    this.logger.info('expired unanswered requests', {
      count: expired.length,
      bookingIds: expired.map((request) => request.id),
      reachedLimit,
    });

    if (reachedLimit) {
      /*
       * Warn rather than info, because it is the one outcome that means *ask
       * again sooner*. Its normal cause is a backlog after an outage; its abnormal
       * cause is a sweep that is failing to keep up, and those look identical for
       * one tick and completely different for ten.
       */
      this.logger.warn('expiry sweep filled its batch, more may be waiting', {
        limit: RequestExpiryService.BATCH_LIMIT,
      });
    }

    return result;
  }
}
