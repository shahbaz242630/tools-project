# 0022. "View as user" is a read-only projection, not a session

- **Status:** Accepted
- **Date:** 2026-08-01
- **Relates to:** BRD §8.1, §8.4.1, §8.13, §10, §14 Phase 1; ADR 0015, ADR 0016, ADR 0019, ADR 0021

## Context

BRD §8.13 and §14 Phase 1 both ask for the same capability:

> A read-only "view as user" support capability is provided from Phase 1 and is fully audit-logged. Write-capable impersonation is prohibited at launch; if later introduced it requires dual approval and complete audit.

The phrase "view as user" has an obvious reading — sign the administrator in as that person and let them walk the site — and Clerk supports exactly that through actor tokens. Slice 1.8a built the role, the MFA requirement, the mandatory reason and the audit entry that any such capability needs; slice 1.8b-i made the resulting disclosure visible to the person it happened to. This decides what the capability itself actually is.

Two things constrain it that the BRD does not state directly. ADR 0015 deliberately withholds `CLERK_SECRET_KEY` from the API, so verification is networkless and a compromised API yields a key Clerk already publishes. And ADR 0019 records that the data export is **the one path** by which a decrypted street line leaves the database.

## Decision

**It is a projection, not a session.** `GET /admin/users/:userId` returns what an administrator may see about an account. The administrator's own session stays their own, no token is ever minted as another person, and there is no request shape anywhere in the capability that could change anything.

Write-capable impersonation is prohibited at launch, and the cheapest way to honour a prohibition is to build no mechanism for it. A session-switch implementation is write-capable **by default** and made read-only only by every write path remembering to check for it — a rule that has to hold across every route the platform will ever add, enforced nowhere. This inverts that: reads are enumerated, and everything else is unreachable because it was never built.

It also preserves ADR 0015. Minting an actor token needs `CLERK_SECRET_KEY`; a projection needs nothing from Clerk at all.

**The projection is a third one, and it is the narrowest that carries a name.** `myProfileSchema` gives the owner everything. `publicProfileSchema` gives a stranger a name and a district. `adminProfileSchema` gives support:

- the display name;
- **whether** a phone number is saved — not the number;
- the post town and outward code — **not** the street lines and not the full postcode;
- when the profile was last changed.

Plus the account itself: id, email, role, creation, and both deletion timestamps.

**No street lines and no phone number.** Support does not need to read somebody's address back to them — the person asking already knows their own address, and if they want a copy they can export one, which is audited as the bulk disclosure it is. Keeping them out is what keeps ADR 0019's claim true, and the claim is worth more than the convenience. The phone number is excluded for the same reason and one more: nothing has verified it, so it is not a fact about the person, and Phase 1 has no handover for support to arrange.

What is left answers every question the launch product can raise: does a profile exist, is it complete enough to list or book (BRD §8.1 gates that on contact details), and does the address resolve somewhere sensible. "Publish the bucket, not the point" is the same rule ADR 0016 applies to the public profile; the bucket is simply larger here.

**A deleted account is visible, with its timestamps.** A deliberate difference from the public profile route, which collapses "deleted", "never existed" and "no profile" into one null so it cannot be used to enumerate accounts. Enumeration is not the threat here — the caller is an administrator, holding a role and a recent second factor, named in an audit entry the subject can read. And "when was this deleted, and did anyone ask for it" is precisely what support is asked after a deletion.

**`admin.user_viewed` is its own action, not folded into `admin.activity_viewed`.** The two disclose different things, and somebody reading their own trail is entitled to know which happened. One action for both would make the narrower access indistinguishable from the wider one.

**A lookup that finds nothing is still recorded.** The audit entry is written before the read, so a well-formed id for an account that does not exist leaves an entry behind. That is correct: an administrator asking after an id is a real event, and a trail holding only the successful lookups is the wrong half of the record. A **malformed** id is refused before anything is written — see ADR 0021's correction for why that ordering matters.

**Profiles supplies its half through a third port, `ProfileSummarySource`.** Identity owns the account and assembles the view, but holds no profile and could not decrypt an address if it did. Deliberately not a second method on `PersonalDataSource`: that port answers "everything you hold, for the person themselves", this one answers "the least that helps support", and one name for both is how an administrator eventually starts seeing street lines.

## Alternatives rejected

**A real impersonation session, via Clerk actor tokens.** The literal reading of "view as user", and what a mature support tool eventually offers. Rejected on three counts: it needs `CLERK_SECRET_KEY` in a service ADR 0015 keeps it out of; it is write-capable unless every present and future write path checks for it, which is a rule with no enforcement point; and BRD §8.13 prohibits write-capable impersonation at launch, so the strongest implementation of that prohibition is no mechanism. If it is ever built, §8.13 already says the terms: dual approval and complete audit.

**Return the owner's own `MyProfile`.** The most useful thing for support and the most literal "view as user". Rejected: it creates a second path by which a decrypted street line leaves the database, which means amending ADR 0019 to say there are now two — and the second one is reachable by staff rather than by the data subject. The support benefit is speculative; the disclosure is certain.

**Account state only, with no profile fields at all.** Minimum disclosure. Rejected because it cannot answer "is my address saved correctly", which is among the likeliest Phase 1 support questions, and a support tool that cannot answer the common question gets worked around — usually by asking the person to email a screenshot, which discloses more than this would have.

**Show the phone number but not the address.** Tempting, since a phone number is disclosed to a counterparty at booking anyway. Rejected: that disclosure is Phase 5's and is conditioned on a booking existing, which is exactly the model BRD §8.4.1 sets out. Borrowing it early, for a different purpose, on an unverified number, is how a conditional disclosure quietly becomes an unconditional one.

**Reuse `publicProfileSchema`.** No new type, no new port. Rejected: it cannot express "a profile exists but has no address", which is the difference between "they have not finished signing up" and "something is broken" — the distinction support most needs.

**One `admin.viewed` action for both capabilities.** Fewer entries in the vocabulary. Rejected: a person reading their own trail cannot then tell whether an administrator read their activity or their account details.

## Consequences

**Support cannot read a street line or a phone number back to anyone, ever, through this tool.** That is the intended outcome and it will occasionally be inconvenient. The escape hatch is the right one: the account holder exports their own data and sends it. If a genuine need appears, it is a new capability with its own decision, not a field quietly added to `adminProfileSchema` — which is why that schema's comment says so.

**Three ports now connect Profiles & Trust to Identity & Access**, and ADR 0019's weak point applies to all three: nothing forces a new module holding personal data to implement any of them, and nothing will tell you if it implements none. Three is where that stops being a note and starts being a real risk to write down properly.

**The admin surface has two pages and no index.** They cross-link, which is enough at two. It will not be at four.

**Dual approval still does not exist.** §8.13 asks for it on "selected actions" and none of the actions that would need it exist yet — everything an administrator can do today is a read. It should be built before the first destructive admin capability, not after, because retrofitting approval onto an action people already use is much harder.

**Nothing records before/after state for admin actions**, still. §8.13 asks for it; every admin action so far is a read, and a read has no state change. The requirement first bites on the first admin write.
