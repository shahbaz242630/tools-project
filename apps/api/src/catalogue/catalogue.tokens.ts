/**
 * Injection token for the catalogue service.
 *
 * A symbol rather than a string, for the reason `profiles.tokens.ts` gives: two
 * modules naming their token `'CATALOGUE_SERVICE'` silently overwrite one
 * another in Nest's container.
 */
export const CATALOGUE_SERVICE = Symbol('CATALOGUE_SERVICE');
