/**
 * Test doubles for the interfaces this package owns.
 *
 * A separate entry point, `@platform/observability/testing`, so a production
 * import cannot reach a fake by accident. Anything exported here is intended to
 * be used only from a test.
 */

export * from './recording-logger.js';
export * from './recording-metrics.js';
