# 0019. Treat the data export as the one plaintext egress, and audit it

- **Status:** Accepted
- **Date:** 2026-07-31
- **Relates to:** BRD §8.1, §10, §10.1; ADR 0016, ADR 0017, ADR 0018

## Context

BRD §8.1 lists "data export" beside account suspension and deletion requests, and §10 requires "data subject access, correction, deletion and portability processes". UK GDPR Article 15 gives a right of access and Article 20 a right to portability in a "structured, commonly used and machine-readable format".

Slice 1.5b shipped deletion first. That left the platform briefly able to destroy somebody's data but not to hand them a copy of it, which is the wrong order for the person and was called out at the time. This slice closes it.

One property makes the export different from every other endpoint. **Street lines are encrypted at rest** (ADR 0016) and no response has ever carried the whole record in one document. The export does, by definition — a portability file that omitted the address would not be a portability file.

## Decision

**The export is a single JSON document, produced synchronously.** Article 20's "structured, commonly used, machine-readable" is satisfied by JSON, and at current row counts an asynchronous job with an emailed link would be machinery serving nothing. A person clicks a link and gets a file.

**It carries a `schemaVersion` and an `exportedAt`.** Somebody may keep an export for years and open it long after the shape has moved on; without a version, an old file is indistinguishable from a malformed one. The version is bumped when a field is removed or changes meaning — adding one does not need it, because a reader that ignores unknown keys still works.

**It is audited as `account.exported`, recorded before the document is returned.** This is the one bulk disclosure the platform performs and the only path by which a decrypted address leaves the database. An access log with a hole exactly where the sensitive operation sits would be worse than no log. The entry carries no before or after digest: an export is a disclosure, not a mutation, and inventing a state transition would make the two indistinguishable in the trail.

**The document does not describe its own creation.** The entry is written before the activity list is assembled, so an export appears in the _next_ export rather than in itself. A file describing its own creation reads as a bug to anyone comparing two of them.

**Each module supplies its own section, through a `PersonalDataSource` port** — the mirror image of `PersonalDataEraser` from ADR 0018, and deliberately shaped the same way. A module that can be erased but not exported is a module somebody forgets when the next subject-access request arrives; putting the two ports side by side makes adding one without the other feel obviously incomplete. It is also load-bearing: only the profiles module holds the encryptor, so only it can decrypt an address, and handing that key elsewhere to avoid a port would put it in a second place.

**The digests stay out.** They are keyed with a secret the reader does not have, so they are meaningless to them, and Article 15 concerns the personal data we hold rather than our internal integrity checks.

**The web app serves the file from a route handler at `/account/data/download`.** This is the **second browser-reachable non-page route in the application**, after the Clerk webhook, and CLAUDE.md asks that adding one be deliberate. The reason it cannot be a server action is mundane and decisive: a download needs a `Content-Disposition` header and an action cannot set response headers. The alternative — returning the document to a client component and assembling a `Blob` — requires JavaScript for something that should be a link.

It is not an API. It takes no parameters, returns one file to one authenticated person, and calls the API server-side exactly as every page does. The API itself stays unreachable from the internet.

**The web app forwards the API's bytes unchanged.** It parses the body only to _check_ it, then serves the original string. Re-serialising a parsed document risks reordering keys or reformatting a value, and the bytes the API produced are the bytes the person should receive.

**The response is `no-store`.** It contains a home address; keeping it out of shared caches and the browser's back-forward cache costs a header.

## Alternatives rejected

**An asynchronous job with an emailed link.** What a large platform does, and what this will need eventually. Rejected now: it requires the worker, a transactional email decision that is still open (slice 1.3), and a signed expiring URL — all to avoid a request that currently reads a handful of rows. Building it early would mean maintaining it through every schema change until it was needed.

**Omit the address to keep plaintext out of any response.** Tempting given how much effort ADR 0016 spent encrypting it. Rejected because it would defeat the point: a portability export that withholds the most identifying thing we hold is not portability, and Article 20 is not optional.

**Return CSV.** Common for exports and friendly to spreadsheets. Rejected because the data is nested — an account with a profile with an address with an activity list — and flattening it either loses structure or produces several files. JSON is equally "commonly used" and does not lie about the shape.

**Let the identity module read the other tables directly.** Fewer moving parts than a port. Rejected for the same reason erasure uses one: it is the cross-module read the boundary exists to prevent, and identity has no way to decrypt an address regardless.

**Skip the audit entry.** An export changes nothing, so there is an argument that there is nothing to record. Rejected firmly: the audit trail exists to answer "who saw what", and the single largest disclosure the platform makes is exactly the event it must not miss.

**Re-serialise the parsed document in the web app.** Would let the web app pretty-print it. Rejected: it makes the file the web app's output rather than the API's, and any difference between them becomes a bug that only appears in what the person actually downloads.

## Consequences

**There is now a URL that returns somebody's full address to anyone holding their session.** That is inherent to the right of access, but it raises the value of a stolen session token above what it was yesterday. The mitigations are that the route is authenticated, has no id parameter, is `no-store`, and is audited — so a disclosure is at least always visible afterwards.

**Nothing rate-limits it.** A person could request their export repeatedly, and each request assembles several tables and decrypts. At current scale that is not a denial-of-service concern, but **it is the first endpoint where repetition costs real work**, and it is the obvious first candidate when rate limiting arrives.

**The export is unencrypted once downloaded.** The page says so and compares it to a bank statement. Offering an encrypted archive was considered out of scope for a file the person asked for and controls.

**Adding a module means adding a section.** A new module holding personal data must implement `PersonalDataSource` as well as `PersonalDataEraser`, and neither the compiler nor a test will notice if it does neither — the composition root simply will not wire it. That is the weak point of this design and is worth remembering when Listings arrives.

**Correction is still missing.** BRD §10 lists "access, correction, deletion and portability". Access, deletion and portability now exist; correction is partly covered by the profile edit form, but there is no route for correcting the account email, which lives at Clerk. That gap is real and belongs with whatever slice next touches identity.
