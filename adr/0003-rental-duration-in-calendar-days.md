# 0003. Count rental duration in local calendar days, not elapsed time

- **Status:** Accepted
- **Date:** 2026-07-26
- **Relates to:** BRD §6.1, §8.5.2, §8.10

## Context

Rental pricing, late fees and return deadlines all depend on "how many days". The obvious implementation — divide elapsed milliseconds by 86,400,000 — is wrong in the United Kingdom twice a year.

British Summer Time makes one day in March 23 hours long and one day in October 25. In 2026 those are 29 March and 25 October. A two-day hire spanning the March transition elapses 47 hours; spanning October, 49. Billing on elapsed time under-charges every spring and over-charges every autumn, and the over-charge is the one that generates complaints and refunds.

There is a second-order problem. A tool collected at 09:00 is expected back at 09:00. Adding 24-hour blocks shifts the due time by an hour across a transition, which then cascades into a spurious late fee under BRD §8.10.

## Decision

Rental duration is the difference between the **local calendar date** of collection and the local calendar date of return, computed in the booking's stored IANA timezone (`Europe/London` at launch). Collect on the 27th, return on the 3rd is seven days, matching how UK equipment hire is conventionally priced. A same-day return counts as one day, so a rental is never billed as zero.

`addRentalDays` preserves local wall-clock time rather than adding fixed durations, so a 09:00 collection is due at 09:00 regardless of what the clocks did in between.

All timestamps are stored in UTC. Only the calculation and the rendering are timezone-aware.

## Consequences

A "day" is not 24 hours, and code that assumes otherwise will be subtly wrong. This is why the `Date` global is banned outside the time module by lint rule — a naive `new Date()` in domain code is the exact mechanism by which this decision gets undone.

Both 2026 transitions are covered by tests that assert the elapsed hours _are_ 47 and 49 while the day count remains 2, so the intent is legible to whoever reads them next.

Storing a timezone per booking is currently redundant — everything is `Europe/London`. It is carried anyway because retrofitting a timezone column onto historical bookings, once any exist outside the UK, means guessing what they meant.

## Alternatives considered

**Elapsed hours divided by 24, rounded up.** Simple, and wrong twice a year as above.

**Fixed 24-hour rental periods from the collection instant.** Defensible and used by some hire businesses, but it makes the return time drift for the renter and does not match how a customer thinks about "three days". It also complicates the availability calendar, which is date-based.

**Store everything in local time.** Removes conversion at render time and creates ambiguity during the autumn transition, when 01:30 occurs twice. Rejected: UTC storage is unambiguous by construction.

## What would change this

Expanding beyond the UK means bookings in multiple timezones, at which point the per-booking timezone starts doing real work and the "which timezone governs a cross-border hire" question needs answering — likely the listing's, not the renter's. Hourly rental pricing (BRD §8.5.2 permits it) would also need a companion rule, since calendar days are meaningless below a day.
