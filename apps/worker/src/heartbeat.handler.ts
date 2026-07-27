import type { Logger } from '@platform/observability';
import type { JobEnvelope } from './envelope.js';
import type { HeartbeatPayload } from './queues.js';

/**
 * Proves the queue pipeline works end to end: enqueue, deliver, execute, log,
 * acknowledge.
 *
 * Deliberately does nothing else. A skeleton job that pretended to do real work
 * would have to be unpicked when the real work arrives, and a job with side
 * effects cannot be run freely in staging to check the worker is alive.
 */
export function createHeartbeatHandler(
  logger: Logger,
): (envelope: JobEnvelope<HeartbeatPayload>) => Promise<void> {
  return async function handle(envelope: JobEnvelope<HeartbeatPayload>): Promise<void> {
    const source = envelope.payload?.source;

    // Job data comes back from Redis as whatever was stored, which may predate
    // the current payload shape after a deploy. Rejecting it here turns a
    // malformed job into one failed job rather than a crashed worker.
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error('heartbeat payload is missing a source');
    }

    // The correlation id is already ambient — the caller established it from
    // the envelope — so the logger attaches it without being told.
    logger.info('heartbeat', { source });

    return Promise.resolve();
  };
}
