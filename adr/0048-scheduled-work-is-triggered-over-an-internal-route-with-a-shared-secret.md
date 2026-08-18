# 0048. Hold the schedule in the worker, do the work in the API, and cross between them over an internal route with a shared secret

- **Status:** Accepted
- **Date:** 2026-08-18
- **Relates to:** BRD §8.6, §7, §5.1, §10.1, §10.2, §14 Phase 4 and Phases 5–8; ADR 0011, ADR 0015, ADR 0021, ADR 0037, ADR 0038
- **Decided by:** engineering, during slice 4.7a. The product owner approved the shape before it was built, having been told the cost: this is the project's first machine-to-machine credential.

## Context

BRD §14 gives Phase 4 a _"request expiry worker"_: an unanswered `REQUESTED`
booking past its §8.6 deadline must move to `EXPIRED`. Slice 4.5a had already put
the deadline on the row and 4.6a already refused to accept past it, so the rule
existed — what was missing was anything that made the **state** honest.

Building it ran into a constraint that is not obvious from either side.

**The work must happen inside the API process.** The sweep writes `bookings` and
`booking_events`, and both belong to the Booking module — BRD §5.1 and CLAUDE.md
forbid a direct cross-module database write, and §7 requires transitions to be
validated centrally by the state machine that lives there. Duplicating any of that
elsewhere would put §7's vocabulary in two places.

**The schedule belongs in the worker.** `apps/worker` exists for exactly this, it
holds BullMQ, and §14 says "worker".

**And the worker cannot call into the API's code at all.** Three reasons, each
sufficient on its own:

- `apps/api` is **CommonJS** and `apps/worker` is **ESM** (ADR 0011). The worker
  cannot import the API's Nest services.
- The worker has **no database client**. `check-invariants.mjs` records that as a
  property, not an accident: _"the worker has no database client at all"_.
- Applications do not import applications. There is no shared package that could
  hold the sweep without moving §7's transition table out of the module that owns
  it — and slice 4.1 deliberately kept that table out of `@platform/contracts`
  precisely so no other process could compute a transition from it.

Nothing in the project scheduled anything before this. The API is **not** a BullMQ
producer, and `identity.service.ts` already carried the note _"queueing it needs a
scheduler we do not have."_ So this slice had to establish the mechanism, not only
the rule.

## Decision

**The worker holds the schedule. The API does the work. The worker sets it off with
an HTTP `POST` to a route under `/internal/`, carrying a shared secret in an
`x-internal-trigger` header.**

Four parts, each deliberate:

1. **A separate guard, `InternalTriggerGuard`, not an exemption inside
   `AuthGuard`.** An exemption would be a branch in the one place that must never
   have a way to say "no credential needed".
2. **A distinct header, not `Authorization: Bearer`.** That field means "a Clerk
   session token" everywhere else in this API. Two meanings for one header means
   the first question when debugging a 401 is which kind of credential was
   expected — and the tempting fix is a guard that tries both.
3. **`INTERNAL_TRIGGER_SECRET` is required in the shared environment schema**, so
   an absent secret **stops both processes** rather than opening the route. An
   optional secret has to be handled at the guard, and the tempting handling is
   "none configured, so skip the check" — an unauthenticated mutating endpoint
   reached by forgetting a line in an env file. Same choice ADR 0038 made for
   `POSTGRES_SSLMODE`: a default is invisible, and this one would be invisible and
   open.
4. **`timingSafeEqual`, with lengths compared separately first.** A `===` returns
   as soon as two bytes differ, which measures how much of the prefix was right —
   recoverable a byte at a time by something that can call an internal endpoint in
   a loop. Lengths go first because `timingSafeEqual` _throws_ on a mismatch, and
   the length of a secret is not worth protecting.

**The guard authenticates a machine and carries no identity.** Nothing downstream
may infer a user, a role or a permission from it. The events the sweep writes have
`actorId: null`, which is what the schema already required for a platform action.

## What was rejected

**A timer inside the API process.** Cheapest by far: no credential, no route, no
env var, no new failure mode. Rejected because §14 says "worker", because a
scheduler inside the request-serving process is a second scheduler nobody
registered — it keeps running after the worker's is turned off — and because
Phases 5, 7 and 8 each need scheduled work (payout release after the return window,
damage-hold expiry, review reminders). Building the mechanism once now is the
difference between one place and four. This remains the fallback if the credential
ever proves more trouble than it is worth; nothing about the sweep itself would
change.

**Network position as the control.** The API joins no edge network and CI asserts
it is unreachable from the internet, so in practice only `web` and `worker` can
dial it. Trusting that would mean an unauthenticated mutating route whose only
protection is topology, and one compromised container then reaches it. It is the
same reasoning §10.2 applies to an edge allowlist: proving where traffic came from
is not proving it was sent for us.

**The API consuming a BullMQ queue the worker produces to.** It avoids the
credential — Redis auth already exists — at the cost of running a job consumer
inside the request-serving process, which is the timer objection with more moving
parts.

**Moving the booking rules into a shared package.** Would let the worker do the
work directly, and would move §7's transition table out of the module that owns it
— undoing slice 4.1's deliberate decision to keep it unreachable from anything that
could compute a transition off it.

**Idempotency keys on the trigger.** CLAUDE.md requires them for payment
operations. Not here: the sweep's work is idempotent because the state predicate is
inside the `UPDATE`, so a re-delivered job expires nothing twice. A key would be
ceremony protecting an operation that needs no protecting.

## Consequences

**This is the project's first machine-to-machine credential, and it arrives while
§10.2 is unmet.** There is no WAF, no rate limiting anywhere, and no alert rules.
The exposure is bounded — the API has no public path and CI asserts it — but the
honest accounting is that the attack surface grew, and it is recorded in
`docs/SECURITY.md` rather than booked as free. The route is a natural first
candidate for an edge rule that refuses `/internal/*` outright once an edge exists.

**Rotation means restarting both services together.** There is deliberately no
support for two valid secrets at once: they are deployed from one file, and a
rotation window is a second code path nobody would exercise.

**`/internal/` is now a reserved prefix**, and it is the audience rather than a
version. Every later scheduled job goes under it, which is what makes the set
countable in a route table, in a log line, and in that eventual edge rule.

**A refusal logs `absent`, `malformed` or `mismatch` and never the presented
value.** A near-miss is the most interesting thing an attacker could ask us to
write down for them, and application logs reach Loki with none of §10.1's
guarantees.

**One thing this does not buy, stated so nobody assumes otherwise.** The trigger is
authenticated, not authorised, and it is not a general-purpose admin channel. A
route that did something a human should decide does not belong behind it — ADR 0021
governs those, and it requires a second factor precisely because a shared secret is
not a person.
