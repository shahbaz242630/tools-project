/**
 * Injection token for the feature-flags service.
 *
 * A symbol rather than a string, for the reason `catalogue.tokens.ts` gives: two
 * modules naming their token `'FEATURE_FLAGS_SERVICE'` silently overwrite one
 * another in Nest's container.
 */
export const FEATURE_FLAGS_SERVICE = Symbol('FEATURE_FLAGS_SERVICE');
