/**
 * The injection token for `Metrics`.
 *
 * Its own file for the reason `catalogue.tokens.ts` is: a token imported from
 * the module that provides it makes the provider and its consumers import each
 * other, and Nest resolves that at construction time rather than at compile
 * time — so the cycle surfaces as an undefined dependency at boot.
 */
export const METRICS = Symbol('METRICS');
