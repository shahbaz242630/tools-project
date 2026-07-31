# 0016. Publish a postal district, and store contact data only where a booking can gate it

- **Status:** Accepted
- **Date:** 2026-07-31
- **Relates to:** BRD §5.1, §6.2, §8.1, §8.4.1, §10, §14 Phase 1

## Context

Phase 1 asks for profile creation and edit. A rental marketplace profile is not the same object as a social profile: it is shown to a stranger who is deciding whether to hand over a £900 breaker, and it belongs to somebody who will eventually reveal their home address to that stranger in order to complete a booking. The incumbent's weakness is trust, not features (BRD §1), so the profile has to carry enough to be judged and no more than that.

BRD §6.2 lists the Profile entity's fields as _display name, photo, rating, location precision, trust indicators_, and models Address as a separate entity carrying _postcode, coordinates, fuzzed coordinates, provider ID, encrypted detail, visibility rules_. Four of the five profile fields depend on later phases — photo needs object storage, rating comes from reviews in Phase 8, trust indicators need phone and ID verification, and location precision needs the Phase 3 geocoding that does not exist. What remains buildable now is a name and an address.

Two questions had to be answered before any of it could be built, and the first was nearly answered wrongly.

**How much location is public?** The obvious reading of "show where someone is" is to publish their postcode. A full UK postcode averages about fifteen delivery points and is frequently a single building; beside a display name it is close enough to an address to locate someone on the electoral roll. That is the precise harm the product owner raised — impostors harvesting enough to impersonate or target a user — and publishing a full postcode would have caused it while looking like a feature.

**Where do phone numbers and street addresses live?** An earlier draft of this slice proposed storing none of them, on the grounds that data not held cannot leak. That was wrong for this product: the platform genuinely needs an address to place items on a map for search, and genuinely needs a phone number so that two people who have agreed a rental can arrange a handover. The requirement is not to avoid the data. It is to hold it and disclose it only when a booking authorises that — which is exactly what BRD §8.4.1 already mandates for a listing's true coordinates.

## Decision

**The public profile is a display name, a post town, a postal district and a joining month. Nothing else.** `publicProfileSchema` in `@platform/contracts` is the enumeration, and it is a separate type from the owner's view rather than the same type with optional fields — an optional `phone?: string` compiles identically whether or not the API remembered to strip it, so the guarantee would live in a controller somebody could edit.

**The outward code is stored as its own column, derived on write.** `addresses.outwardCode` holds `BS7`; `addresses.postcode` holds `BS7 8AA`. The public query selects a column that has never contained the inward code, so it cannot leak one by somebody forgetting a truncation at render time. Deriving on write means the two can only diverge in the one place that computes one from the other.

**Contact data is stored, never published, and released only by a future booking state.** `profiles.phone` and the address exist from this slice; no projection exposes them, and the tests assert that against raw response bodies rather than parsed objects. The mechanism that will release them to a counterparty arrives with the booking state machine in Phase 4, because it cannot be built before there is a booking to condition it on.

**Street lines are encrypted at rest; the postcode is not.** `addresses.encryptedDetail` holds an AES-256-GCM envelope over `{line1, line2}`, with the key in `PERSONAL_DATA_ENCRYPTION_KEY`, held by the API and by nothing else. The postcode and town stay in clear because Phase 3 must geocode the first and publish the second, and a value the search index needs cannot be ciphertext. The grading is the point: a stolen dump yields postal districts rather than front doors.

**The owner's user id is bound into the ciphertext as additional authenticated data.** An encrypted address copied onto another row fails to decrypt rather than being served as that person's — an attack available to anyone with database write access but no key.

**Joining dates are published to the month.** `2026-07`, not a timestamp. An exact signup time is a correlation handle for linking accounts across services, and "member since July 2026" is the whole of what a renter is judging.

**One 404 covers "no such account", "deleted account" and "no profile yet".** Distinguishing them turns the public route into an oracle for which user ids are real, which is the first step of scraping a user base.

**Profiles & Trust is a separate module from Identity & Access**, per BRD §5.1. It never writes to `users`; it asks what it needs about an account through its own `AccountLookup` port, which the composition root answers from the identity service.

## Alternatives rejected

**Publish the full postcode.** What was originally asked for, and it gives a renter a marginally better distance estimate. Rejected because it narrows a person to roughly fifteen households, which combined with a name is a finding aid. The district answers the only question a renter actually has — roughly how far away is this — at a fraction of the exposure.

**Publish a town or district name instead of a code.** Friendlier to read, but a town can be ten miles across, which is useless for judging whether an item is collectable. The decision publishes both, which costs nothing extra: the town is no more precise than the district.

**Store no contact data at all until Phase 4.** Considered, and wrong. It would mean asking every user for their address a second time later, and it does not remove the obligation — it defers it to a slice where the disclosure rule and the data model would both be new at once.

**Encrypt the whole address, postcode included.** Rejected because Phase 3 has to geocode the postcode and the search index has to hold something derived from it. Encrypting it would mean decrypting every row to answer "what is near me", which is not a search.

**Put address columns on `profiles`.** Simpler, one fewer join. Rejected because BRD §6.2 models Address separately, the sensitivity differs sharply, and Phase 3 adds a `geography(Point,4326)` column and a GiST index that have no business on the row every public profile view reads.

**Make display names unique.** Rejected: it invites squatting and a registration race, and it does not prevent impersonation anyway — `Support` and `Support ` are different strings. Impersonation is a Trust & Safety problem, not a constraint a column can express.

**A free-text bio.** Proposed, then dropped. On a platform where people reveal a home address after booking, an open text box invites volunteering exactly what this ADR is trying to withhold — "I'm away weekdays, the side gate is unlocked" — published to the world by the person it endangers. It can return later with moderation, which belongs to Trust & Safety.

## Consequences

**A deleted account's profile row survives its deletion.** The public route refuses to serve it because the account check fails, but the display name and address remain in the database. That is consistent with how `users` already tombstones rather than erases, and BRD §14 asks Phase 1 for a deletion skeleton only — but it means a deletion request does not yet erase profile text. **The erasure slice must clear `profiles` and `addresses`, and until it exists the disclosure check is the only thing keeping a deleted person off the internet.**

**The encryption key is now part of the backup plan, not an application detail.** Restoring `addresses` from a backup without `PERSONAL_DATA_ENCRYPTION_KEY` restores unreadable rows. It must be stored somewhere that survives losing the database and separately from it, and it must differ between staging and production. Rotation is possible but unbuilt: the envelope carries a `v1:` prefix so a second key can be introduced without ambiguity, and nothing yet re-encrypts.

**Encryption protects offline copies, not a compromised API.** The running process holds the key by necessity. The threat model is a stolen dump, a mis-scoped read or a backup that goes astray — not live code execution. Saying so prevents the protection being cited later for something it does not do.

**Phone numbers are unverified.** Nothing has proved a number belongs to the person who typed it. It must not be read as a trust signal until verification lands (Twilio in Phase 6, or a Clerk phone flow), and BRD §8.1 requires that before listing or booking rather than before having a profile.

**No content moderation.** A display name is user-supplied text published to the world. Control and direction-changing characters are rejected — U+202E can make a name render as something it is not — but nothing checks whether a name is offensive or impersonates a brand. That is Trust & Safety's, in a later phase.

**Public profile pages are `noindex`.** BRD §8.17 wants listings discoverable; nothing asks for user profiles to be. Until that is a decided product question rather than a side effect of having built a page, a page carrying a real name and postal district stays out of search results.

**Adding a field to `publicProfileSchema` is a disclosure decision.** It is the one file where that is true, which is why the schema carries the warning and the tests assert the shape rather than only the values.
