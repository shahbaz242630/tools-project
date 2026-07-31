# 0018. Erase our data before deleting the credential, and say what survives

- **Status:** Accepted
- **Date:** 2026-07-31
- **Relates to:** BRD §8.1, §10.1, §14 Phase 1; ADR 0015, ADR 0016, ADR 0017

## Context

BRD §14 Phase 1 asks for an "account suspension and deletion request skeleton", and §8.1 for "account suspension, deletion request, data export and blocked-user controls". Slice 1.4 knowingly left a debt behind: a deleted account's profile row survived, and only the public route's account check kept the display name and postal district off the internet. ADR 0016 says in as many words that the erasure slice must clear `profiles` and `addresses`.

Two facts about this platform make deletion more than a `DELETE` statement.

**We cannot erase everything, and pretending otherwise would be the lie.** From Phase 5 the immutable ledger references `users.id` and can never lose a counterparty; §10.1 retains security logs for a year hot and six years cold. So §10.1 also requires that the workflow "distinguish erasable personal data from retained transactional records and **explain the distinction to the user**". The explanation is a requirement, not copy.

**The credential is not ours to delete from the API.** ADR 0015 deliberately withheld `CLERK_SECRET_KEY` from the API — it holds only the JWT public key, which makes session verification networkless and means a compromised API yields something Clerk already publishes. Only the web app can delete a Clerk user. So the deletion spans two services, and the order in which they act is a decision with consequences.

## Decision

**Erase our data first; delete the credential second.**

The API erases the personal data, tombstones the email, and marks the account deleted. Only then does the web app ask Clerk to delete the credential.

The reasoning is entirely about what a failure between the two steps leaves behind:

- **This order:** the credential survives, our data is gone, and the account is soft-deleted — so the guard already refuses every session for it. Nothing is reachable, and the person can sign in and ask again if they want to.
- **The reverse:** the credential is gone and our data remains. The person is locked out of an account that still holds their address, with no way to authenticate and ask again. Somebody would have to fix it by hand.

One of those is recoverable and one is not.

**Deletion of the credential is best effort, and its failure is never reported as the deletion failing.** By the time it runs, the account is erased and locked out. If Clerk cannot be reached, the mirror is already in exactly the state Clerk's own `user.deleted` webhook would have produced. The page says the sign-in may take longer to disappear rather than claiming something went wrong.

**`POST /me/deletion-request`, not `DELETE /me`.** What happens is not a hard delete, and the verb should not promise more than the platform does. The name matches what BRD §14 calls it.

**Two timestamps, not one.** `deletionRequestedAt` records when somebody asked; `deletedAt` records the state the guard checks. They are set together today because there is no grace period — but a provider webhook can tombstone an account nobody asked us about, and recording a request in that case would fabricate the one fact a data-protection enquiry cares about.

**Identity orchestrates through a port it declares.** `PersonalDataEraser` names what Identity & Access needs — "remove everything personal about this person" — and the composition root supplies an implementation backed by Profiles & Trust, which owns that data (BRD §5.1). Each module writes its own audit entry for what it removed, because the module that knows is the one that can say so. When listings and messages hold personal data, several erasers compose into one and nothing inside the identity module changes.

**The whole operation is idempotent, and answers success on a repeat.** A caller retrying after a dropped connection cannot sign in again to check — telling them it is too late would be both unhelpful and untrue.

**The confirmation is a typed word.** There is no undo, so the cost of an accidental submit is total, and a checkbox is not proportionate to that.

## Alternatives rejected

**Delete the credential first.** Reads more naturally — remove the login, then clean up. Rejected on the failure analysis above: it produces the one unrecoverable state.

**Hard-delete the `users` row.** What "delete my account" implies. Impossible: the ledger will reference it from Phase 5, and an immutable financial record cannot lose its counterparty. The row is tombstoned instead and the explanation says so.

**Soft-delete the profile rather than erasing it.** Symmetric with `users`, and one fewer kind of delete in the codebase. Rejected: a flagged address row keeps the encrypted street lines in every backup taken afterwards, with a retention clock nobody is watching. The account row is retained because we are _obliged_ to keep it; the profile is not, so keeping it would be data held for no purpose.

**A grace period with restore.** Standard, and kinder. Rejected for now because it needs a scheduler that does not exist, and half of it — marking the account and never getting round to erasing — is worse than neither. `deletionRequestedAt` is separate from `deletedAt` specifically so that adding one later changes nothing above it.

**Erase the audit trail too.** Consistent-looking. Rejected: §10.1 retains security logs for six years, and "when did they ask, and did you act" is exactly what an enquiry asks. The entries survive because ADR 0017 made them hold keyed digests rather than values — the retention is of the _event_, not of the person's data.

**Let the API delete the Clerk user.** Would put the whole operation in one service. Rejected because it requires giving the API `CLERK_SECRET_KEY`, undoing ADR 0015's central decision — a key that can mint sessions and read the entire directory, handed to a service to perform one call.

## Consequences

**A window exists where a valid Clerk session belongs to a deleted account.** Between our erasure and Clerk's deletion, and for longer if that deletion fails. The guard refuses those sessions — `resolveSession` throws for a soft-deleted account — and an integration test pins it, because that check is the only thing closing the window.

**Deletion is immediate and irreversible.** Stated on the page rather than discovered afterwards. If a grace period is ever wanted, it needs the scheduler and it changes the meaning of `deletedAt`, not of `deletionRequestedAt`.

**A deleted person cannot read their own retained audit trail**, because they can no longer authenticate. Reading it is an administrative capability and arrives with the admin role, its MFA requirement and its own audit entries.

**Data export is still missing.** BRD §8.1 lists it beside deletion, and offering deletion without export means somebody can destroy their data but not take a copy first. It is not in this slice and should be next in the sequence rather than much later.

**Suspension is still missing.** The other half of §14's line. Deletion is the destructive one and was the debt; suspension is a Trust & Safety control and depends on the admin surface to drive it.

**Nothing yet reconciles a deletion against records we are required to retain.** §10.1 says the workflow "must reconcile against records the platform is required to retain". Today there are no bookings or ledger entries to reconcile against, so the explanation is accurate as written — but it will need revisiting the moment either exists, and the wording is deliberately about categories so that it can be.
