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

/**
 * Injection token for the listing media service (slice 2.6b-i).
 *
 * Its own token for the reason `LISTINGS_SERVICE` is separate from
 * `CATALOGUE_SERVICE`: the collaborators differ. This one needs an
 * `ObjectStore`, which nothing else in the module does, and a test of the
 * listing routes should not have to construct one to get a listings service.
 */
export const LISTING_MEDIA_SERVICE = Symbol('LISTING_MEDIA_SERVICE');
