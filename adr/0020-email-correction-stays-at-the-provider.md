# 0020. Correct the email at the provider, and let the mirror converge

- **Status:** Accepted
- **Date:** 2026-07-31
- **Relates to:** BRD §6, §8.1, §10; ADR 0015, ADR 0017

## Context

BRD §10 requires "data subject access, correction, deletion and portability processes". Slices 1.6 and 1.5b built access, portability and deletion. Correction was the remaining one, and it was already half-built without being called that: profile fields have been editable since 1.4, and the mirrored email already corrected itself two ways — the `user.updated` webhook, and just-in-time on the next authenticated request, both from ADR 0015.

So the question was not "how do we let somebody change their email". It was what was actually missing, which turned out to be two things neither of them a form.

## Decision

**The email is changed at Clerk, on Clerk's screen.** `<UserProfile />` is mounted at `/account/email`. The email address is a _credential_: changing one means proving the person holds the new address before it takes effect — a verification message, a code, and a rollback if it is never confirmed. ADR 0015 put credentials at Clerk precisely so we would not write that. Building our own form would mean duplicating the verification flow or skipping it, and skipping it turns an email change into account takeover.

**Both correction paths now record `account.email_changed`.** This is the substantive part of the slice. An email change is ordinary-looking and security-relevant out of proportion to that: it is how an account takeover is made permanent, and it is the one identity fact that can change while nothing else about the account does. It was previously silent on both paths. The entry stores digests rather than either address (ADR 0017), so the trail shows _that_ it changed without becoming a record of what it changed from.

**One shared `correctEmail` method serves both paths.** The webhook and the just-in-time correction are the same operation arriving by different routes. Two copies would drift the moment one gained a rule the other did not — most plausibly the audit entry, which is the rule that was missing from both.

**A collision leaves the mirror stale rather than failing the request.** `users.email` is unique, so a correction can lose: our mirror still holds an address that somebody else has since taken at Clerk. Clerk enforces uniqueness within an instance, so this needs a stale row on our side — user A changes away from an address, our mirror has not caught up, user B takes it, B signs in. Rare, and self-correcting: A's next request corrects A's row and frees the address.

The store surfaces it as `UserConflictError` and the service keeps the stale address and carries on. Throwing would turn a race that resolves itself into a 500 on an ordinary page load.

## Alternatives rejected

**Build our own email-change form.** Full control of the wording and the flow. Rejected: it requires re-implementing verification, and an email change that takes effect before the new address is proved is a takeover primitive. The provider exists to hold this.

**Correct the mirror only by webhook.** Simpler — one path, one place to audit. Rejected for the reason ADR 0015 already gives for provisioning: webhooks are asynchronous and can be missed, and a mirror that only converges on redelivery may never converge at all.

**Correct only just-in-time.** Also one path. Rejected because it never fires for an account that is not signing in, so a corrected address would sit unapplied indefinitely — and the webhook already exists.

**Let a collision throw.** Loudest, and it surfaces mirror drift immediately. Rejected because the person who sees the failure is not the person who caused it: an unrelated user gets a 500 on a page load because of somebody else's stale row.

**Force the correction by tombstoning the colliding row.** Would resolve the collision immediately. Rejected as far too aggressive — it mutates an account that has done nothing wrong, on the strength of an inference about which row is stale.

## Consequences

**A stale mirror can persist silently.** The collision path keeps the old address and records nothing, because nothing changed. It self-corrects when the other account next signs in — but if that account never does, the drift is permanent and invisible. **The reconciliation script noted in the handoff is the fix**, and it needs `CLERK_SECRET_KEY` on something that is not the API.

**Every authenticated request passes through the correction check.** It is a string comparison and writes nothing when they match — a test pins that, because an audit entry per request would bury the corrections that matter under thousands that changed nothing.

**Correcting an email does not correct the profile.** They are different things and the page says so, because somebody reasonably expects one "change my email" to change everything. The profile has held no email since it was built.

**Clerk's screen is unstyled by us and carries Clerk's own look.** It sits inside our page rather than replacing it, which is a visible seam. That is the cost of not writing a verification flow, and it goes away with the brand and design work rather than with a change here.

**The four data-subject rights are now all present in some form.** Access and portability by export, deletion by erasure, correction by this. None of them has been exercised against a real deployment, because there is no deployment.
