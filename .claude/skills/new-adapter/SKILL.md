---
name: new-adapter
description: Add an external provider behind an interface with a production adapter, test fake and timeout strategy, per BRD §5. Use when integrating any third-party service.
---

# New provider adapter

BRD §5 requires every external provider to have an interface, a production adapter, a test fake, and an explicit timeout and error strategy.

## First: should this exist yet?

**ADR 0008 — do not write a vendor adapter before it can be exercised.** If there is no account, no sandbox and no credentials, build the interface, a no-op or in-memory production adapter, and the test fake. Stop there.

An adapter written against documentation but never run looks finished and is not. A future session assumes it works and finds out during an incident.

Record the deferral in `docs/HANDOFF.md` with the credential that unblocks it.

## Structure

```
<module>/
  ports/<provider>.port.ts        interface + domain types
  adapters/<vendor>.adapter.ts    production implementation
  adapters/<vendor>.fake.ts       deterministic test double
```

Nothing outside `adapters/` imports the vendor SDK. If a vendor type leaks into a domain signature, the boundary has already failed.

## The interface

Model the domain operation, not the vendor's API. `authorisePayment(booking)` — not `createPaymentIntent(params)`. If the vendor is replaced, the interface should survive.

Return domain errors, not vendor exceptions. Callers must not need to know which provider raised what.

## Mandatory failure strategy

Every adapter method states, in code:

- **Timeout** — an explicit value. No unbounded network call, ever.
- **Retry** — which errors are retryable, with backoff. Never retry a non-idempotent operation without an idempotency key.
- **Circuit breaking** — behaviour when the provider is down. Fail fast rather than queueing indefinitely.
- **Idempotency** — required for anything touching money (BRD §8.7).

An adapter with no timeout is a future outage, not a future bug.

## Tests

- Contract tests against both the real adapter (sandbox) and the fake, asserting identical behaviour. Divergence here is how test suites pass while production fails.
- Timeout, retry exhaustion, and malformed provider response.
- Idempotency: the same operation twice produces one effect.

## Secrets

Credentials come from `@platform/config`, never `process.env` directly (ADR 0006). Log through `@platform/observability` so redaction applies — provider payloads routinely carry tokens and card data.
