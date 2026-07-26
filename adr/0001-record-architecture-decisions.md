# 0001. Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-07-26
- **Relates to:** BRD §11.3, §15

## Context

The team is two: one product owner who does not read code, and Claude as engineer. Sessions are discrete — context does not persist between them the way it does in a human developer's head.

That makes undocumented reasoning unusually expensive. A decision made deliberately in one session looks arbitrary in the next, and the natural instinct on encountering an odd-looking choice is to "fix" it. Several decisions already taken in Phase 0 are exactly that shape: they look like overengineering until you know the constraint behind them.

The BRD covers _what_ to build. It does not cover the implementation choices made while building, or the options rejected on the way.

## Decision

Record architecture decisions as numbered markdown files in `adr/`, using the format in `template.md`.

Write one when a decision is hard to reverse, surprising without context, or something a reasonable engineer would otherwise undo. Do not write one for routine choices.

Accepted ADRs are never edited or deleted — they are superseded, so the reasoning trail survives.

## Consequences

A small ongoing cost per architectural decision, and a judgement call each time about whether something qualifies. The failure mode to avoid is recording everything: an ADR set nobody reads is worse than none, because it implies decisions were considered when they were merely logged.

They live in `adr/` at the repository root rather than `docs/`, which is gitignored. ADRs explain committed code and must travel with it.

## Alternatives considered

**Comments in the code.** Good for local "why", useless for decisions spanning modules, and they cannot record a rejected alternative.

**The handoff document.** It already carries a decisions log, but that is a chronological session record, not a durable per-decision reference — and it is private, so it cannot explain the code to anyone reading the repository.

**Commit messages.** Genuinely useful and used properly here, but undiscoverable. Nobody greps history to find out why money is stored as integers.

## What would change this

If the ADR set grows past roughly thirty entries without being consulted, the format is not working and the effort should go elsewhere.
