import type { OwnerStatus } from '@platform/contracts';

/**
 * What Catalogue needs to know about the person behind a listing (slice 2.13).
 *
 * **Stated by the consumer, answered by Profiles** — the same shape as
 * `ListingLocator` and, before it, `AccountLookup`. Catalogue does not own
 * anything about a person (BRD §5.1 gives that to Profiles and Identity) and it
 * does not import that module: the composition root wires the two together, so
 * neither knows the other's internals. This is the **sixth** port crossing a
 * module boundary to say something about a person.
 *
 * **Catalogue needs it for two things and they are not the same thing.**
 * Publication refuses a listing whose owner has not declared, which is a rule
 * about whether the listing may go live at all; and the public page states the
 * answer, which is the consumer-law disclosure §8.3 actually asks for. One port
 * serves both because it is one fact — and if the two ever read different
 * sources, a listing could be published as a private owner's and displayed as a
 * trader's.
 */
export interface OwnerStatusSource {
  /**
   * How these people list — **many at a time, and never one**.
   *
   * **The plural is the port** (audit remediation, August 2026). It used to be
   * `findOwnerStatus(userId)`, which reads perfectly at the two write paths
   * that ask about one listing and turns into a query per owner on the search
   * results page — an N+1 across a module boundary, on the one public route
   * that returns a *collection* and has no rate limit in front of it. Adding a
   * batch method beside the single one would have left the slow shape available
   * and idiomatic; there is one method so that the cheap thing is the only
   * thing that can be written, and so Profiles has exactly one query to make
   * fast. The single-listing callers ask about a list of one.
   *
   * **An absent key means "has not declared"**, and that is deliberately the
   * only way this can answer anything but a declaration. Null is the ordinary
   * state of a new account and is not an error: BRD §8.1's pattern is that a
   * profile is permissive and completeness is enforced at the point it matters.
   * Somebody who only ever rents is never asked, because the question is about
   * being a supplier.
   *
   * **An account with no profile at all is also simply absent**, and the caller
   * must not tell the two apart — both mean "has not declared", both refuse
   * publication, and distinguishing them would only invite a branch that treats
   * one of them as consent. A map with no entry cannot express the difference,
   * which is the point of returning one rather than a list of pairs.
   *
   * The implementation may be asked about an id twice, or about none at all,
   * and must answer both without complaint.
   */
  findOwnerStatuses(
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, OwnerStatus>>;
}
