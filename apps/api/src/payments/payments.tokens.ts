/**
 * Injection token for the reconciliation sweep (slice 5.4a).
 *
 * A symbol rather than a string, for the reason `catalogue.tokens.ts` gives: two
 * modules naming their token `'RECONCILIATION_SERVICE'` silently overwrite one
 * another in Nest's container.
 *
 * **The first token this module has, and `PaymentsService` still does not have
 * one.** That is not an oversight: nothing resolves `PaymentsService` from the
 * container — Booking reaches it through the `HirePayments` port, wired by hand in
 * `main.ts`, which is what keeps a booking from importing anything about cards.
 * The sweep is different because a *controller* resolves it, and a controller is
 * the one thing Nest constructs for us.
 */
export const RECONCILIATION_SERVICE = Symbol('RECONCILIATION_SERVICE');
