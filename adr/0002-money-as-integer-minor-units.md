# 0002. Money as integer minor units, with explicit allocation for splits

- **Status:** Accepted
- **Date:** 2026-07-26
- **Relates to:** BRD §6.1, §8.7

## Context

The platform splits every transaction between at least three parties: the owner's proceeds, the platform fee, and the renter's service fee. Damage security, refunds, late fees and partial dispute settlements add more. Every one of those movements must reconcile against an immutable ledger (BRD §8.7), and against the payment provider daily.

Two failure modes threaten that.

Floating-point representation is the well-known one. `0.1 + 0.2 !== 0.3`, and a ledger that accumulates such errors stops balancing in a way that is very hard to unpick after the fact.

The second is subtler and bit us in testing. Splitting an amount by rounding each share independently does not conserve the total. £10.05 split 50/50 rounds to £5.03 twice — £10.06. A penny created from nothing. At volume this is not a rounding curiosity; it is a ledger that does not balance and a reconciliation job that fails every day for no discoverable reason.

## Decision

Money is an integer count of minor units (pence) carried alongside an ISO 4217 currency code on the same value. Floating point is never used to represent an amount anywhere — database, API contract, or business logic.

Splitting uses `Money.allocate(total, ratios)`, which distributes the remainder a single minor unit at a time and guarantees the shares sum exactly to the input. `multiply` is available for scaling a single amount but must never be used to compute the parts of a split.

Rounding is half-away-from-zero, so a refund of £X behaves symmetrically with a charge of £X. `Math.round` alone rounds `-0.5` towards positive infinity, which would make the two differ.

## Consequences

Every amount needs converting for display, and every external payload needs mapping at the boundary. That is deliberate friction at exactly the point where a mistake would otherwise be silent.

Currency mismatches throw rather than coercing. Adding GBP to EUR is a bug, not a conversion.

`allocate` is slightly surprising on first read — the remainder goes to the largest share, so a 15/85 split of an odd amount favours the owner rather than the platform. That is intentional and worth keeping if the ordering is ever revisited.

## Alternatives considered

**A decimal library such as decimal.js or big.js.** Correct, but heavier than needed. Every amount we handle is a whole number of pence; arbitrary precision solves a problem we do not have, and it invites storing a decimal in the database where an integer is exact.

**Floats with rounding at the boundaries.** The standard shortcut and the standard source of ledger drift. Rejected outright.

**Rounding each share independently.** Simpler to write and wrong, per the £10.05 example above. There is a conservation test across 601 amounts and 5 split shapes specifically to stop this being reintroduced.

## What would change this

Supporting a currency with a different minor-unit scale (or none, such as JPY) needs the scale table extending — the structure already anticipates this. Genuine multi-currency settlement, where amounts are converted rather than merely denominated, would justify revisiting the whole model.
