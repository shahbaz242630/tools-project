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

/** Injection token for the quote engine (slice 4.4b). */
export const QUOTES_SERVICE = Symbol('QUOTES_SERVICE');

/** Injection token for the request path (slice 4.5a). */
export const BOOKINGS_SERVICE = Symbol('BOOKINGS_SERVICE');

/**
 * Injection token for the expiry sweep (slice 4.7a).
 *
 * Its own token rather than sharing `BOOKINGS_SERVICE`, because it is its own
 * service — see `request-expiry.service.ts` for why a sweep with no actor does not
 * belong beside the methods whose job is scoping to one.
 */
export const REQUEST_EXPIRY_SERVICE = Symbol('REQUEST_EXPIRY_SERVICE');
