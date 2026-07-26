---
name: adr
description: Write an architecture decision record. Use when a decision is hard to reverse, surprising without context, or would otherwise be undone by someone who lacks the reasoning.
---

# Write an ADR

`adr/` holds numbered decision records. Read `adr/README.md` first, then copy `adr/template.md`.

## Does this need one?

Yes if it is **hard to reverse**, **surprising without context**, or **something a reasonable engineer would otherwise undo**.

No for routine choices. A lint rule, a file layout, a library with an obvious alternative — those are commit messages. An ADR set nobody reads is worse than none, because it implies decisions were considered when they were merely logged.

BRD §15 also requires one _before_ deviating from any mechanism the BRD marks normative.

## The sections that actually matter

**Context** — the constraint that forced a choice. A provider limitation, a legal requirement, a failure we hit. Be specific: "card authorisations expire in 7 days" beats "payment timing is complex".

**Alternatives considered** — usually the most valuable section a year later. It stops a rejected option being proposed again, and it reveals whether the decision was reasoned or merely made. Include the option you would have picked in a different context, and say what made it lose.

**Consequences** — including what you do not like. An ADR listing only benefits is marketing.

**What would change this** — the trigger to revisit. A decision with no stated trigger outlives its context.

## Rules

- Present tense, imperative title. "Count rental duration in calendar days", not "We decided to…".
- Under a page.
- Never edit or delete an accepted ADR. Supersede it, and link both ways. The trail is the point.
- Add it to the index table in `adr/README.md`.

If a decision went against your own recommendation, record it with both sides intact. That is the format working, not failing.
