# 0004. Prevent double booking in the database, not the application

- **Status:** Accepted
- **Date:** 2026-07-26
- **Relates to:** BRD §8.5.1, §7.1

## Context

Double booking is the failure that destroys trust fastest in a rental marketplace. Two renters accepted for the same drill on the same weekend means one of them turns up to nothing, and the owner is blamed for a platform bug.

The tempting implementation is a check followed by an insert: query for conflicting bookings, and if none, create one. This is a textbook race. Two acceptances arriving milliseconds apart both read an empty result and both insert. It passes every test written against a single request and fails in production under exactly the conditions that matter — a popular listing with competing demand.

Application-level locking (advisory locks, a mutex, a queue) can be made correct but relies on every future code path remembering to take the lock. The guarantee then lives in developer discipline rather than in the data.

## Decision

Overlap prevention is enforced by a PostgreSQL `EXCLUDE` constraint using `btree_gist`, over `listing_id WITH =` and the booking period as a `tstzrange WITH &&`, scoped to the booking states that occupy the calendar.

The database rejects the second conflicting insert regardless of which code path attempted it, how many application instances are running, or whether anyone remembered to take a lock.

`REQUESTED` is deliberately **not** a blocking state. Multiple renters may hold pending requests for the same dates; the first acceptance to commit wins and auto-declines the others in the same transaction (BRD §7.1). Blocking on request would let one renter sit on a listing without committing.

## Consequences

A hard dependency on PostgreSQL with the `btree_gist` extension. This constrains managed-database choice later — not every provider enables arbitrary extensions — and is called out in the handoff as a check to make before selecting a production provider.

The conflict surfaces as a database error that the application must translate into a domain-meaningful response, rather than as a clean pre-flight check. That is the correct trade: an error we must handle beats a race we cannot see.

Both the local stack verification and CI create a real constraint, insert an overlapping booking and assert it is rejected, then assert the same period on a _different_ listing is allowed. The guarantee is tested rather than assumed, on every pull request.

## Alternatives considered

**Check-then-insert in application code.** Racy. Rejected on principle, not on measurement — this class of bug is invisible until it is expensive.

**`SELECT … FOR UPDATE` on the listing row.** Correct if applied consistently, but serialises all writes to a listing and depends on every path remembering. The guarantee lives in discipline rather than in the schema.

**Advisory locks keyed on listing id.** Same objection, plus the lock is invisible in the schema, so nothing tells a future developer it exists.

**A serialisable transaction isolation level.** Correct, but pushes retry handling into every caller and carries a broader performance cost for a problem one constraint solves precisely.

## What would change this

Moving off PostgreSQL, which is not contemplated. If a managed provider we otherwise want cannot offer `btree_gist`, this decision and that provider choice must be weighed together — the constraint is the more important of the two.
