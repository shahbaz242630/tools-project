# 0008. Do not write a provider adapter before it can be exercised

- **Status:** Accepted
- **Date:** 2026-07-26
- **Relates to:** BRD §5, §15

## Context

BRD §5 requires every external provider to sit behind an interface with a production adapter, a test fake and an explicit timeout and error strategy. Error tracking is the first provider we reached, with Sentry the intended vendor.

There is no Sentry account and no DSN. An adapter could still be written against the SDK — the API is well documented — but it could not be run against anything real. It would compile, be covered by tests against a mocked SDK, and be entirely unverified.

That is a worse position than having nothing, because it _looks_ finished. A future session sees a Sentry adapter, assumes error reporting works, and does not check. The first evidence otherwise arrives when an incident produces no alerts.

The same reasoning will apply repeatedly: Stripe, Clerk, Resend, Twilio, the address provider and the insurance partner all need accounts we do not yet hold.

## Decision

Build the interface, a genuine no-op production adapter, and a recording test fake. Do not write the vendor adapter until credentials exist to exercise it against a sandbox.

The no-op is a real production adapter, not a stub: it is what runs when tracking is deliberately disabled, and it still writes the error to the log, because losing the diagnostic entirely is worse than having no aggregator.

Every deferred adapter is recorded in the handoff with the credential that unblocks it.

## Consequences

Call sites are written against the interface from the start, so adding the vendor adapter changes one factory function and nothing else.

There is a visible gap between "the seam exists" and "the provider works", and it must stay visible. The mitigation is the handoff list plus explicit statements in pull requests — never a silent absence.

Anyone reading the code sees no Sentry integration and knows that is deliberate, because this ADR says so.

## Alternatives considered

**Write the adapter now against the SDK, untested.** Produces the false-completeness failure above. This is the option this ADR exists to reject.

**Wait for accounts before building anything.** Blocks work for weeks on a signup, and the interface design does not depend on the vendor.

**Use a mock server to exercise a real adapter.** Reasonable for a complex provider, and likely worth it for Stripe, where the sandbox is genuinely usable and the failure modes are the interesting part. Disproportionate for error tracking.

## What would change this

Per provider: the moment credentials exist. For Stripe specifically the bar is higher — BRD §11.2 already requires sandbox tests for webhook idempotency and capture behaviour, so the adapter and its verification arrive together.
