/**
 * Injection token for the availability service (slice 4.3b).
 *
 * A symbol rather than a string, for the reason `catalogue.tokens.ts` gives: two
 * modules naming their token `'AVAILABILITY_SERVICE'` silently overwrite one
 * another in Nest's container.
 *
 * **The first token this module has.** 4.1 was pure logic with nothing to
 * inject and 4.2 was a store the composition root passes by hand; the calendar
 * is the first thing here a controller resolves.
 */
export const AVAILABILITY_SERVICE = Symbol('AVAILABILITY_SERVICE');
