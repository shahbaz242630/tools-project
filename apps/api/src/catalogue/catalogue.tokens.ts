/**
 * Injection token for the catalogue service.
 *
 * A symbol rather than a string, for the reason `profiles.tokens.ts` gives: two
 * modules naming their token `'CATALOGUE_SERVICE'` silently overwrite one
 * another in Nest's container.
 */
export const CATALOGUE_SERVICE = Symbol('CATALOGUE_SERVICE');

/**
 * Injection token for the listings service.
 *
 * Separate from `CATALOGUE_SERVICE` even though BRD §5.1 puts both aggregates in
 * the Catalogue module. They have different collaborators — one writes audit
 * entries, the other does not — and a single token would mean every test that
 * wanted a fake listing store also had to build a category service and an audit
 * log it never uses.
 */
export const LISTINGS_SERVICE = Symbol('LISTINGS_SERVICE');
