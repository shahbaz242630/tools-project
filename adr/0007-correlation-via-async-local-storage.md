# 0007. Carry correlation context in AsyncLocalStorage

- **Status:** Accepted
- **Date:** 2026-07-26
- **Relates to:** BRD §9

## Context

A single booking touches the API, the database, a queue worker, and at least one external provider. When it fails, reconstructing what happened means correlating log lines across all of them. Without a shared identifier the only tool is timestamps, which is guesswork under any real concurrency.

The purist approach is to pass a context object explicitly through every function signature. It is honest, testable and visible. It also gets dropped — not usually, but at exactly the boundaries that matter. Inside a `catch` block. In a queue handler that reconstructs work from a serialised job. On a retry. Those are precisely the paths that only execute when something has already gone wrong, which is when the correlation id is most needed and least likely to have survived.

## Decision

Correlation context is carried in `AsyncLocalStorage` and read implicitly by the logger and the error tracker.

Inbound correlation ids are sanitised before use: non-empty, at most 128 characters, and restricted to `[A-Za-z0-9_-]`.

## Consequences

Nothing has to remember to pass a correlation id, and every log record from within a request carries one automatically. Code outside a context simply omits the field rather than failing.

Implicit context is harder to trace when reading code — the id appears in output without any visible source. This is the real cost, and it is why the mechanism is confined to observability rather than used for business data. Anything that affects behaviour is passed explicitly.

The sanitisation is not incidental. The value arrives in an untrusted header and lands in a log line, so without a charset restriction a caller could embed newlines and forge log records — writing a fake `"level":"error"` entry into our own logs. There is a test for that specific attack.

`AsyncLocalStorage` has a measurable but small cost, and ties the implementation to Node.

## Alternatives considered

**Explicit context parameter everywhere.** Purer, and reliably dropped in catch blocks and queue handlers. The failure mode is silent and concentrated in the error paths.

**A module-level mutable variable.** Broken under any concurrency; requests would attribute each other's ids.

**Full OpenTelemetry tracing now.** The eventual destination (BRD §4 nominates it) but heavier than Phase 0 warrants, and it needs a collector we have not stood up. The correlation id is designed to become a trace id rather than be replaced by one.

## What would change this

Adopting OpenTelemetry properly, at which point this becomes a thin adapter over its context propagation rather than a separate mechanism.
