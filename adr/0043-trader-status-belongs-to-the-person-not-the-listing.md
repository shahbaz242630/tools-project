# 0043. Private-owner or professional-trader status belongs to the person, not to the listing

- **Status:** Accepted
- **Date:** 2026-08-12
- **Relates to:** BRD §8.3, §8.14.2, §10.1, §14 Phase 2; ADR 0028, ADR 0029, ADR 0042
- **Amends:** BRD §8.3, which places the declaration on the listing. The amendment of 12 August 2026 moves it to the account.

## Context

BRD §8.3 says, in one line:

> Listings must declare private-owner or professional-trader status
> (consumer-law disclosure) and are blocked if the item matches a known safety
> recall.

The disclosure is not optional and it is not cosmetic. Under UK consumer law a
renter has materially stronger rights against a **trader** — somebody acting for
purposes relating to their trade or business — than against a private
individual, and they are entitled to know which they are dealing with before
they contract. Slice 2.10 built the public listing page and could not make the
statement, because nothing in the system knew the answer: there was no field on
`listings`, none on `profiles`, and none in any contract.

Two questions had to be settled before it could be built: **where the answer
lives**, and **what happens when somebody says "business"**.

## Where it lives

The BRD says the listing declares it. **Every marketplace we could find holds it
on the account instead.** Vinted Pro carries a "Pro" badge on every listing,
rendered from a profile-level flag, with company name and registration number on
the profile itself; eBay splits private from business at the account level.

The reason is not convention. It is a fact about **who somebody is**, not about
an object they own — and per-listing storage lets one person's listings
contradict each other about their own legal capacity. A renter reading two
adverts from the same owner, one saying private and one saying business, has no
way to know which disclosure is true, and the platform has published at least one
falsehood. There is no version of that failure which is better than not asking.

**This is the same shape as ADR 0042**, one slice along: the BRD specified a
placement, the research showed nobody does it that way, and the reason nobody
does it turned out to be a defect in the placement rather than a preference.

It is also **not** `seller_tax_profiles` (ADR 0028). That table records which
HMRC reporting regime a return is filed under and whether the seller's identity
is verified for it. This records who the counterparty is for consumer-law
purposes. They correlate and they are not the same question — a trader can be
non-reportable, and a reportable seller can be a private individual — and one
column answering to two statutes would diverge silently the first time they
disagreed. `seller-tax-profile-is-inactive` is untouched.

## What happens when somebody says "business"

A trader selling at a distance owes disclosures a private individual does not.
Under the Electronic Commerce (EC Directive) Regulations 2002 and the Consumer
Contracts (Information, Cancellation and Additional Charges) Regulations 2013,
they must make available their business name and a **UK geographic address**, and
the postal address must be available _before_ a consumer responds to the advert.

That is the opposite of what the public listing page does for a private owner,
which deliberately shows a postal district and nothing finer (§8.4.1). A trader's
listing would have to render differently, with a real address on it, and the
platform would have to collect and verify one.

**The product owner's decision of 12 August 2026 is that this platform is
peer-to-peer only**: client to client, no businesses, revisited if demand appears.
So the option is offered, the answer is stored, and a business is refused
publication with an honest explanation.

**Offered rather than hidden**, which is the part worth recording. Not asking at
all was rejected because it would leave the page asserting something nobody had
been asked. Offering only a confirmation — _"I am not a business"_ — was rejected
too: a business would either tick it untruthfully or leave without telling us,
and in both cases we learn nothing. Recording the real answer is the only version
that produces the demand signal the decision is explicitly waiting for.

## Decision

**Store it on `profiles.ownerStatus`** — `private_owner` or
`professional_trader`, nullable, **no default**, with a `CHECK` constraint
(`owner_status_is_known`) in the database as well as the vocabulary in code.

**No default, and the reason is the strongest form of ADR 0025's rule.** A
default of `private_owner` would be the platform answering a legal question on
somebody's behalf — and because it is the _likely_ answer it would be wrong
rarely and invisibly, which is the worst frequency a wrong answer can have. NULL
means "has not answered", and nothing publishes until a human has said.

**Constrained in the database, unlike `listings.status`**, because the value
carries a legal meaning. A row written by a fixture script, a migration or a
hand-edit that this build cannot interpret would have a public page state
something untrue about somebody's capacity, and the constraint holds for writers
that are not this application.

**Catalogue reads it through a port it declares** (`OwnerStatusSource`), answered
by Profiles — the sixth port crossing that boundary, and the same shape as
`ListingLocator`. Catalogue owns nothing about a person (§5.1).

**Publication refuses a listing whose owner has not declared, or has declared
business**, as two messages from one `PublicationBlocker` field. A blocker rather
than its own error because from the owner's point of view it genuinely is a
reason their listing cannot go live — unlike the platform-wide publishing switch,
which says nothing about them and gets its own status.

**Public visibility depends on the declaration, evaluated on every read.** This is
the part that is easy to leave out and is the reason the disclosure can be
trusted. Publication settles completeness once and never looks again, so without
it an owner could publish as a private individual, change their profile to
business, and go on serving a disclosure that had become false. Making the public
read check means changing the answer takes the listing out of public view until
it is changed back — and the owner's own status stays `PUBLISHED`, because this
is a visibility rule, not a retraction.

**The wire carries the value rather than the page assuming it.** Only private
owners can be publicly visible today, so the field is constant — and a constant
is a thing somebody has to remember stays constant. Carrying it means the day
traders are supported the page renders the truth without being edited.

## Consequences

A listing cannot be published until its owner has answered one question, which is
a new gate on an existing flow and will be the first thing every new owner meets.
The local fixture owner had to answer once before the published fixture could be
served again.

**Businesses cannot list.** That is a deliberate closed door and it cuts against
the supply-first launch (§2), which is why the refusal says so in plain words at
the point of declaring rather than at the point of publishing. The recorded
answers are the evidence for reopening it.

**Building trader support later is a slice, not a field.** It needs a business
name, a UK geographic address, those disclosures rendered on the listing page
before a consumer responds, and a decision about which obligations follow the
seller into bookings and disputes. Nothing here forecloses it; the vocabulary and
the storage are already right.

## Alternatives rejected

**On the listing, as §8.3 says.** Rejected because one person's listings could
disagree about their own legal capacity, and because every platform that has
solved this put it on the account.

**Merged into `seller_tax_profiles`.** Rejected: two statutes, two questions, and
a single column would have made the first divergence silent. It would also have
activated a table ADR 0028 deliberately froze.

**Defaulting to `private_owner`.** Rejected as the platform answering a legal
question for somebody, wrongly and invisibly in exactly the cases that matter.

**Asking only for a confirmation that somebody is not a business.** Rejected: it
produces no demand signal, and it invites an untruthful tick from the only people
whose answer would change anything.

**Hard-coding the disclosure on the public page** on the grounds that only private
owners can publish. Rejected as a sentence that would go on being printed after
it stopped being true.
