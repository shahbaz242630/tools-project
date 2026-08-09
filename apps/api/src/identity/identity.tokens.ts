/**
 * Injection tokens for the services `identity.service.ts` split into (slice H4).
 *
 * Symbols rather than strings, for the reason `catalogue.tokens.ts` gives: two
 * modules naming their token `'ACCOUNT_DATA_SERVICE'` silently overwrite one
 * another in Nest's container.
 *
 * `IDENTITY_SERVICE` is deliberately **not** here. It lives in `auth.guard.ts`
 * beside the guard that injects it, which is where it has always been — moving
 * it would have made this refactor touch the guard's consumers for no reason.
 */

/** BRD §10.1's subject rights: export, sign-in history, deletion. */
export const ACCOUNT_DATA_SERVICE = Symbol('ACCOUNT_DATA_SERVICE');

/** Administering somebody else's account: read, suspend, reinstate. */
export const ACCOUNT_ADMIN_SERVICE = Symbol('ACCOUNT_ADMIN_SERVICE');

/** Role changes, which need two administrators (ADR 0023). */
export const ROLE_APPROVAL_SERVICE = Symbol('ROLE_APPROVAL_SERVICE');
