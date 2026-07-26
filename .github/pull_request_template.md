<!--
One vertical slice per pull request (BRD §14, §15). If this PR does two
unrelated things, split it.
-->

## Slice

<!-- Which phase and slice? What is the smallest coherent thing this delivers? -->

## Modules touched

<!-- Which domain modules (BRD §5.1)? Note any new cross-module dependency and
why an interface or event was not used instead. -->

## Database

<!-- Migration, data impact, and rollback/roll-forward note. "None" is a valid
answer. -->

## Decisions worth reviewing

<!-- Anything a reviewer would otherwise have to reverse-engineer. Prefer
explaining *why* over restating *what*. -->

## Definition of Done (BRD §11.3)

- [ ] Acceptance criteria implemented and demonstrated
- [ ] Unit, integration and any relevant end-to-end tests included and passing
- [ ] Authorisation tests prove both permitted and forbidden access
- [ ] Loading, empty, success, failure and retry states implemented in UI
- [ ] No dead controls — every tab, button and link calls real behaviour or is visibly feature-flagged
- [ ] API validation, error codes and observability in place
- [ ] Migration reviewed and tested
- [ ] Security and privacy impact considered
- [ ] Dashboard, log or alert added where failure matters
- [ ] Documentation and any architecture decision record updated

Tick only what applies to this slice. Strike through and explain anything
deliberately skipped — an unexplained blank is treated as unfinished.

## Invariants (CLAUDE.md)

- [ ] Money is integer minor units with a currency code — no floats
- [ ] Timestamps stored UTC; rental duration counted in local calendar days
- [ ] No hard-coded category names, fees, radii, deposit bands or status labels
- [ ] No direct cross-module database writes
- [ ] Every new external provider has an interface, adapter, test fake and timeout strategy
- [ ] Idempotency for any payment, webhook, notification or state transition

## Not in this slice

<!-- What a reader might reasonably expect to find here and won't. Prevents a
reviewer flagging deliberate omissions as oversights. -->
