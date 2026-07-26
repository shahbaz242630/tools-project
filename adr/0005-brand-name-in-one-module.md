# 0005. Confine the brand name to a single configuration module

- **Status:** Accepted
- **Date:** 2026-07-26
- **Relates to:** BRD §20

## Context

Development began before the product had a name. The obvious options were to wait, or to pick a placeholder and scatter it through package names, import paths, class names and copy — then rename everything later.

Waiting blocks work for no engineering reason. Scattering a placeholder creates a rename that touches every file and is never quite complete, with the residue surfacing months later in a log line or an email template.

Naming is also not purely cosmetic here. The engine is category-agnostic by design (BRD §20), so a name chosen around tools would need replacing on expansion anyway.

## Decision

The trading name exists in exactly one place: `packages/config/src/brand.ts`. No package name, import path, identifier or copy string anywhere else refers to it.

Internal packages use the neutral scope `@platform/*`, which never needs renaming regardless of what the product is called.

`assertBrandConfigured` throws when the placeholder is still in place, and is called during production startup, so an unnamed build cannot serve traffic.

## Consequences

Choosing the name is a one-line change plus a DNS record. Changing it later — including a full rebrand — costs the same.

User-facing copy must interpolate the brand rather than hardcode it, which is marginally more awkward to write and read.

The guard means production deployment is blocked until the name, legal entity, domain and support address all exist. That is deliberate: all four are required before serving consumers anyway, under consumer-law disclosure obligations.

## Alternatives considered

**Wait for the name.** Blocks engineering on a marketing decision with no dependency between them.

**Pick a working name and rename later.** The rename is never complete. The residue appears in exactly the places that embarrass you.

**Read the brand from an environment variable.** Adds deployment configuration for a value that changes approximately once. A typed module gives compile-time safety and a natural home for the production guard.

## What would change this

Nothing foreseeable. If the platform ever operated under multiple brands — a white-label arrangement — the module becomes a lookup rather than a constant, which the single-source structure already anticipates.
