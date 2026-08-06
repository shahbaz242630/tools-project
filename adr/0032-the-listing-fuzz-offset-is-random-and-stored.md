# 0032. The listing fuzz offset is random and stored, never derived

- **Status:** Accepted
- **Date:** 2026-08-06
- **Relates to:** BRD §8.4.1, §8.3, §8.4, §4.2, §14 Phase 2 and Phase 3; ADR 0016

## Context

BRD §8.4.1 is one of the handful of mechanisms the BRD marks **normative** — §15
says to implement it as written or raise an ADR before deviating. It reads:

> Returning a precise distance from an arbitrary user-supplied origin allows an
> attacker to query from three postcodes and trilaterate a listing's exact
> address. The following controls are mandatory:
>
> - Each listing is assigned a **deterministic, persisted fuzz offset** at
>   creation — a fixed random displacement of at least 500 m, stored once and
>   never recomputed. Recomputing per request leaks the true point through
>   averaging.
> - All public distance calculations and map markers use the fuzzed point only.
>   The true coordinate is never returned by any public or pre-booking API
>   response.
> - Displayed distances are rounded to coarse buckets rather than exact values.
> - The true coordinate and full address become available to the renter only once
>   the booking reaches a state that authorises collection, and access is
>   audit-logged.

This ADR exists because the first bullet contains a word that pulls two ways.
**"Deterministic"** and **"random"** appear in the same sentence, and an
implementer can honour the sentence in two incompatible ways:

1. **Derive** the offset from the listing id with a keyed function — an HMAC of
   the id under a server secret, mapped to a bearing and a distance. Genuinely
   deterministic: the same listing always yields the same offset, and the value
   need not be stored at all.
2. **Draw it at random once**, store it, and never compute it again.

Both satisfy "the same listing always sits in the same wrong place", which is the
property the bullet's _reason_ is about — recomputing per request leaks the true
point through averaging, and neither of these recomputes anything meaningful.

The choice is not obvious. Derivation is attractive: it needs no columns, it
cannot drift, and it is trivially reproducible if a row is lost.

There is a second decision hiding underneath, which the BRD does not address at
all: **what the radius filter runs against.** §8.4.1 says distances shown to
people use the fuzzed point. It does not say which point decides whether a
listing is _in_ a 5-mile search at all, and the obvious reading — filter on the
true coordinate for accuracy, display the fuzzed distance for privacy — is the
one that destroys the whole control.

## Decision

**The offset is drawn at random once, at the moment coordinates first exist, and
stored.** Not derived.

A derived offset is **invertible**. Anyone holding the derivation key can compute
every listing's displacement from its id, and the id is in every public URL. Feed
that back through the published fuzzed point and the true coordinate falls out
exactly — for every listing on the platform, at once, **with no database access
at all**. That converts a key leak from "an attacker can forge or read something"
into "an attacker has the home address of every owner", and it does so silently,
because nothing about the system changes when the key escapes.

A stored random offset has no inverse. Recovering true locations requires the
database, and an attacker with the database already has the true coordinates
sitting in a column beside them — so the offset adds no new exposure at all.
That asymmetry is the whole decision. It costs two integer columns.

**"Deterministic" is satisfied by storage.** The property §8.4.1 is protecting is
_stability per listing_, which the reason attached to it makes explicit:
recomputation is banned because averaging many different displacements of the
same true point converges on the true point. A stored value is maximally stable —
it cannot be recomputed even by accident, which is a stronger guarantee than a
derivation that merely happens to be reproducible.

**The displacement is an annulus, not a circle.** A random bearing in [0°, 360°)
and a random distance in **[500 m, 1000 m]**. The floor is the BRD's. The ceiling
is ours, and the range matters: a _fixed_ 500 m displacement would put every true
point on a circle of exactly known radius around the published one, which reduces
the search area from a disc to a ring about 3 km long. A range makes the true
point lie somewhere in a band, and an attacker who knows the algorithm still
cannot narrow it further.

The ceiling is 1000 m rather than something larger because the fuzz is noise in
every distance we will ever show. At the smallest radius the BRD names — 5 miles,
about 8 km — a displacement of up to 1 km is already 12% of the radius. Larger
would start making "within 5 miles" wrong often enough to notice.

**The fuzzed point is stored too, beside the offset.** Deriving it at read time
from the true point and the offset would be correct today and is a computation
somebody can change: a different formula, a different earth radius, a rounding
difference, and every listing quietly moves. Storing it makes the published
location a fact rather than the output of a function. The offset is kept as well,
so it remains possible to show that a given listing was displaced by at least
500 m without recovering anything.

**The radius filter runs against the fuzzed point, and this is binding on
Phase 3.** Not merely the displayed distance — the filter itself.

If a search filters on the true coordinate and shows a bucketed distance from the
fuzzed one, an attacker recovers the true point by binary search: query from an
origin with a 1-mile radius, then 2, then 3, and the radius at which the listing
appears is its true distance from that origin, to whatever precision the radius
control allows. Three origins and it is trilaterated — the exact attack the
opening sentence of §8.4.1 describes, arriving through the filter rather than
through the displayed number. Filtering on the fuzzed point makes every such
probe return facts about the fuzzed point, which is public by construction.

The cost is that a listing near the edge of a radius can fall on the wrong side
of it by up to a kilometre. That is the correct trade and it is invisible to
users, who cannot tell a 5.0-mile radius from a 5.1-mile one.

**The geography column is built on the fuzzed point.** BRD §4.2 requires a
nullable `Unsupported("geography(Point,4326)")` maintained by trigger with a GiST
index. It is derived from the fuzzed coordinates, not the true ones, because it
exists to serve exactly the query above and an index on the true point would be
an index no public query may use.

**The true coordinates are still stored**, because Phase 7 has to hand the renter
an exact place once a booking authorises it, and re-geocoding at handover time
would make a two-stranger meeting depend on a third party being up.

## Consequences

**Losing a `listing_locations` row loses the offset, and re-creating it moves the
listing.** With a derived offset the same row could be rebuilt identically from
the id. This is a real cost of the decision and it is accepted: the row also
holds the postcode and the encrypted street lines, so losing it loses far more
than the offset, and the answer is backups rather than reproducibility. ADR 0009
already treats off-box backups as non-negotiable.

**The offset cannot be rotated.** If a displacement is ever found to be too small
for a particular kind of listing, changing it moves the published point — and
anybody who recorded the old one learns that the true point is within 1 km of
both, narrowing the search area. Any future change to the range must therefore
apply to new listings only, and this is worth knowing before somebody "improves"
the constant.

**A listing can exist with an address and no coordinates**, because geocoding
depends on a third party that can be down or can simply not recognise a valid new
postcode. §8.3 makes a draft permissive, so this must not block saving one. The
consequence lands on **slice 2.8: publication must refuse a listing with no
coordinates**, because a published listing that no search can find is worse than
one that is still a draft.

**Nothing in this ADR protects against a compromised API process**, which holds
the true coordinates by necessity — the same honest boundary ADR 0016 draws for
encrypted addresses. The threat model here is a public search API being used as
an oracle, and offline copies of published data. It is not live code execution.

## Alternatives rejected

**HMAC-derived offset.** Rejected above: invertible, and the failure is total and
silent.

**Fixed 500 m displacement.** Simplest reading of the BRD's words, and it puts
every true point on a circle of known radius. The BRD says "at least 500 m", and
a range is what makes that floor mean something.

**Snapping to a grid** — rounding each coordinate to, say, three decimal places.
Cheap, needs no stored state, and is worse in the way that matters: a grid is
public knowledge, so an attacker knows the true point is inside a specific
100 m cell. It is a smaller search area than a 500 m floor and it is the same for
every listing, so one solved listing teaches the attacker the grid.

**Fuzzing at read time with a per-listing seed held in memory.** A cache is not
storage: two API containers disagree, and a restart moves every listing. This is
the "recomputed per request" case the BRD names, wearing a hat.

**Storing only the offset and deriving the published point.** Rejected for the
reason given above — it makes the published location the output of a function
somebody can edit, rather than a stored fact. The extra two columns are cheaper
than that risk.
