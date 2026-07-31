/**
 * Injection token for the audit service.
 *
 * A symbol rather than a string, for the reason `profiles.tokens.ts` gives:
 * two modules naming their token `'AUDIT_SERVICE'` silently overwrite one
 * another in Nest's container.
 */
export const AUDIT_SERVICE = Symbol('AUDIT_SERVICE');
