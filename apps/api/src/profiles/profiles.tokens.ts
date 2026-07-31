/**
 * Injection tokens for the profiles module.
 *
 * In their own file rather than beside the service, because both controllers
 * import the token and only the composition root imports the service. Keeping
 * them apart means a controller's import list does not suggest it may construct
 * one.
 *
 * A symbol rather than a string: two modules that both call their token
 * `'PROFILES_SERVICE'` silently overwrite one another in Nest's container, and
 * the failure looks like a wiring bug in whichever one loads second.
 */
export const PROFILES_SERVICE = Symbol('PROFILES_SERVICE');
