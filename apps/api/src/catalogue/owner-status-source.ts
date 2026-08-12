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
   * How this person lists, or **null if they have not said**.
   *
   * Null is the ordinary state of a new account and is not an error: BRD §8.1's
   * pattern is that a profile is permissive and completeness is enforced at the
   * point it matters. Somebody who only ever rents is never asked, because the
   * question is about being a supplier.
   *
   * **Null is also the answer for an account with no profile at all**, and the
   * caller must not tell the two apart — both mean "has not declared", both
   * refuse publication, and distinguishing them would only invite a branch that
   * treats one of them as consent.
   */
  findOwnerStatus(userId: string): Promise<OwnerStatus | null>;
}
