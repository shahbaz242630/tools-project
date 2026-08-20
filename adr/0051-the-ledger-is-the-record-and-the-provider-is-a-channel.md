# 51. The ledger is the accounting record and the payment provider is only a channel

Date: 2026-08-20

## Status

Accepted. Binds every Phase 5 slice. Applies
[ADR 0002](0002-money-as-integer-minor-units.md) to the ledger, and is the
accounting half of what [ADR 0050](0050-a-machine-calling-the-api-proves-what-it-can-and-that-differs-by-route.md)
settles for authentication.

## Context

The product owner's instruction opening Phase 5, on 20 August 2026: build
payments so that if the provider becomes a problem later we can move **swiftly**,
rather than rebuilding everything.

That is a reasonable thing to want and an easy thing to get wrong, because
"switch the provider" is not one act. Research before the slice
(`docs/phase-05-payments-and-ledger/reference-payment-provider-portability.md`)
found it is three, and their costs differ by orders of magnitude:

| What moves                                  | How portable                                                                                  | Real cost                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Authorising, capturing and refunding a card | Genuinely portable behind an interface                                                        | Days                                                        |
| The **stored cards**                        | Only with both providers' cooperation — a PCI-to-PCI vault transfer between certified parties | **4–12 weeks**, and the losing provider can delay or refuse |
| **Connected-account onboarding and KYC**    | Not portable at all. Every owner re-verifies with the new provider                            | Unbounded, and it is a _people_ cost                        |

For a peer-to-peer marketplace the third dominates, and **no code we write
changes it**. BRD §4.3 even leans on it economically: Connect Express performs
identity verification as part of payout enablement at no separate charge, against
roughly $1.50 per verification standalone.

So an interface buys the first row almost free, helps a little on the second by
keeping the blast radius small, and buys **nothing** on the third. A team that
believes otherwise discovers it mid-migration.

BRD §4 already contains the answer to what _does_ help:

> _"Customer funds, platform fees, refunds and owner payouts must be tracked
> through an immutable internal ledger. The platform database must never treat a
> payment-provider webhook alone as the accounting record."_

## Decision

**Our double-entry ledger is the accounting record. A payment provider is a
channel that executes movements the ledger already describes.**

Four consequences, all binding:

1. **Nothing in the ledger names a provider.** `ledger_accounts`,
   `ledger_transactions` and `ledger_entries` carry no provider column, no
   provider status and no provider vocabulary. A provider adapter causes a
   posting by calling `LedgerService`, exactly as the Clerk webhook causes an
   identity write — it never writes ledger rows.

2. **No provider identifier is ever a primary key, a foreign key, or a domain
   concept.** Provider references live in their own mapping rows, added by the
   slice that needs them. This is what makes a future migration a data backfill
   rather than a rewrite.

3. **The port speaks our verbs, not the provider's nouns.** `authorise the damage
security for this booking up to this ceiling, and tell me when it expires` —
   not `createPaymentIntent`. The money models genuinely differ: Stripe Connect
   has no wallet and moves platform → connected account, Mangopay holds funds in
   e-wallets, Adyen in balance accounts. A port with `transfer()` on it has
   silently modelled one of them, and the others must then lie.

4. **Where a provider fact genuinely leaks, it is exposed rather than hidden.**
   A hold's expiry is a timestamp the provider returns, never a duration we
   assume (§8.7.2, `capture_before`). Whether a hold is possible at all is a
   capability the port answers and the domain refuses on — §8.7.2's
   `SECURITY_FAILED`, never a silent unsecured handover.

**And the thing this ADR mostly exists to record: the interface does not make a
provider switch cheap. The ledger does.** The vault and the KYC are the cost, and
they are not an engineering problem. Nobody reading a clean `PaymentProvider`
interface in eighteen months should conclude that changing provider is a
fortnight's work.

## Consequences

Phase 5's first slice is the ledger and contains no provider at all, which is why
it is first: it is the highest-leverage portability decision in the phase.

Reconciliation compares the provider's record against ours (§8.7, daily) rather
than importing theirs as truth. That is more work than trusting a webhook and it
is the work that makes the books ours.

**The provider is Stripe Connect, decided by the product owner on 20 August 2026
— in their words, _"for now we will start with Stripe"_.** Mangopay was the other
candidate and remains the obvious one to reconsider: it is FCA-authorised as an
EMI in the UK, was built for rental and peer-to-peer platforms, and its e-wallet
model is structurally what §8.7.2's hold and the payout hold actually are. Stripe
wins on developer experience and on bundling the KYC that BRD §4.3 would
otherwise cost us roughly $1.50 a head.

**"For now" is the operative phrase, and this ADR is what gives it meaning.**
Everything above still binds: the ledger is the record, no Stripe identifier
becomes a key, and the port speaks our verbs. Choosing a provider does not license
`createPaymentIntent` to appear in a service signature.

**A Stripe account in test mode costs nothing and needs no company**, so BRD §14's
first Phase 5 line item — the payment-provider sandbox adapter — is not blocked.
What _is_ blocked is anything real: live keys and Connect onboarding need the UK
limited company and then a business bank account, and **Connect approval is not
instant**. So the company is the urgent item, and it was urgent before this
decision too.

An orchestration layer (Gr4vy, Primer, Payrails, Basis Theory, or the open-source
Hyperswitch) is the industrial answer to this problem and is **rejected for now**:
the commercial ones take a cut of every transaction, and Hyperswitch is another
service with its own Postgres and Redis on a box already running eight
containers. Revisit only if we ever want two live providers at once.

## Alternatives considered

**A provider-agnostic vault from the start** (Basis Theory or similar), so the
stored cards are ours and row two of the table above disappears. It is the
correct answer for a funded team and it costs money per transaction that a
pre-revenue platform does not have. The decision is revisitable precisely because
the ledger, not the vault, is what this ADR makes load-bearing.

**Building two adapters immediately**, to prove the port is not provider-shaped.
Rejected as cost with no user: the fake plus one real adapter exercises every
method, and a second live integration has to be maintained against a provider
nobody is paying.

**Treating the provider's balance as the record** and reconciling our own numbers
against it. This is what most small integrations do, and it is what BRD §4
forbids in as many words. It makes the provider's data model our data model,
which is the lock-in this ADR is about — expressed as an accounting dependency
rather than a code one, and therefore much harder to see.

## What would change this

Genuine multi-currency settlement, or running two providers concurrently, would
both justify revisiting — the first because the ledger's currency handling
assumes denomination rather than conversion, the second because it is the
condition under which an orchestration layer starts earning its cut.
