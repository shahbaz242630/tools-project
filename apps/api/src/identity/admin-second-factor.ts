/**
 * What proves an administrator verified a second factor, and how recently.
 *
 * ADR 0021 requires administrative access to rest on a second factor verified
 * within {@link MAX_SECOND_FACTOR_AGE_MINUTES}, and its load-bearing property is
 * that an **unprovable** factor fails closed: "we cannot tell" reads as "not
 * verified", never as "not required". That is what stops a missing piece of
 * provider configuration becoming an open admin surface on a correctly-signed
 * token.
 *
 * Until slice H8a there was exactly one thing that could prove it — Clerk's
 * `fva` claim — so the rule lived inline in `AuthGuard`, with a development
 * escape hatch branching around it (ADR 0030). This port exists because a
 * second thing can now prove it: an assertion from Cloudflare Access, which is
 * signed, verifiable and *not* Clerk's. The rule does not loosen. It gains
 * another way to be satisfied and still refuses when none of them is.
 *
 * **The escape hatch is now an adapter rather than a branch.** `AuthGuard` has
 * no bypass in it at all: it asks this port and refuses when the answer is null.
 * That is stricter than what it replaced — the dangerous thing moved out of the
 * authentication check and into a swappable part that production cannot select
 * (see `DevelopmentSecondFactor`, and ADR 0053 which supersedes 0030).
 */

import type { VerifiedSession } from './session-verifier.js';

/**
 * How recently an administrator's second factor must have been verified.
 *
 * An engineering bound on how long a privileged session stays privileged, not a
 * business rule — BRD §8.13 asks for step-up authentication on high-risk
 * actions without naming a number. Twelve hours keeps a support shift working
 * without leaving a forgotten browser tab administratively capable overnight.
 *
 * **It lives here rather than in `AuthGuard` from H8a**, because the chain is
 * what applies it: a prover that answers with a stale age must not stop a later
 * prover from answering with a fresh one, so the freshness rule has to be known
 * where the provers are asked. See {@link SecondFactorChain}.
 */
export const MAX_SECOND_FACTOR_AGE_MINUTES = 12 * 60;

/**
 * Everything a prover may look at.
 *
 * Both fields are supplied for every request even though no single prover uses
 * both: Clerk's reads the session, Cloudflare Access's reads a header, and the
 * development one reads neither. Handing each prover the same evidence keeps
 * the port's shape independent of which provers happen to be installed.
 *
 * **Headers are supplied by the caller, and a prover must never treat the
 * presence of one as proof of anything.** An assertion arriving in a header is
 * evidence only once it has been cryptographically verified — signature, issuer
 * and audience — because anything a request can carry, a request can forge. The
 * header is where the proof is *found*; it is not itself the proof.
 *
 * They are also the raw Fastify shape — a repeated header arrives as one
 * comma-separated *string*, not an array, which is a trap `clientIpFrom`
 * already documents. A prover reading a header must handle that itself.
 */
export interface SecondFactorEvidence {
  readonly session: VerifiedSession;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * What one prover answered, and which one answered it.
 *
 * **Named an answer rather than a proof deliberately.** The chain records every
 * prover that responded with an age, including ones it went on to *reject* as
 * stale, so a type called `SecondFactorProof` sitting in a list called
 * `attempts` invites `if (attempts.length > 0)` — which would read a refusal as
 * an admission. Only `SecondFactorDecision.proof` means admitted.
 *
 * `provenBy` exists for the log line, never for a caller — nothing downstream
 * may branch on which provider was used. It is here because a refusal that
 * cannot say which provers were asked is difficult to diagnose, and because an
 * admission by the development adapter must be identifiable in a log search
 * rather than only visible on a page banner (ADR 0030).
 */
export interface SecondFactorAnswer {
  readonly ageMinutes: number;
  readonly provenBy: string;
}

/**
 * One way of proving a second factor.
 *
 * **Null means not proven.** An adapter that cannot tell — an absent claim, an
 * absent header, a malformed value, a provider that did not answer — returns
 * null and must never throw its way into meaning "satisfied". Adapters are
 * responsible for their own failure handling; anything they leave to the caller
 * is a decision made in the wrong place.
 */
export interface AdminSecondFactor {
  /** Names this prover in a log line. Never returned to a caller. */
  readonly name: string;

  /**
   * Whether this prover admits an administrator with no real second factor.
   *
   * Answers `/me`, and therefore the banner ADR 0030 requires on every admin
   * page — taken from the provers themselves rather than from a second reading
   * of the environment that could disagree with what is enforced.
   *
   * **Required, not optional, and the first draft of this port had it the
   * wrong way round.** Optional reads as the tidier choice — why make a safe
   * adapter declare `false`? — but it puts the burden of remembering on the
   * *dangerous* adapter. An author adding a relaxing prover who forgets this
   * gets a guard that admits without a real factor while `/me` reports
   * `false`, so **no banner renders on any admin page** and nothing fails: no
   * test, no invariant, no type error. Required inverts that: forgetting is a
   * compile error, and a safe adapter writing `false` costs one line.
   */
  readonly bypassesSecondFactor: boolean;

  /**
   * Minutes since this prover last saw a second factor verified, or null.
   *
   * Async because one adapter verifies a token against a rotating key set;
   * the other two answer immediately. Uniform so the port does not change
   * shape when the set of installed provers does.
   */
  ageMinutes(evidence: SecondFactorEvidence): Promise<number | null>;
}
