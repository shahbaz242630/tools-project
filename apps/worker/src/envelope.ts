import {
  getCorrelationId,
  newCorrelationId,
  runWithContext,
  sanitiseCorrelationId,
} from '@platform/observability';

/**
 * Carries correlation across the queue boundary.
 *
 * BRD §9 requires a failure to be traceable across API, workers and provider
 * adapters. `AsyncLocalStorage` (ADR 0007) cannot cross a queue: the API
 * finishes its request and its context is gone long before a worker picks the
 * job up. The id has to travel inside the job, and be re-established on the
 * other side.
 *
 * Retrofitting this later would mean rewriting every enqueue site and
 * back-filling every payload, so it is built in before there is a second job
 * type.
 */
export interface JobEnvelope<T> {
  readonly correlationId: string;
  readonly payload: T;
}

/** Wrap a payload, inheriting the ambient correlation id when there is one. */
export function envelope<T>(payload: T): JobEnvelope<T> {
  return { correlationId: getCorrelationId() ?? newCorrelationId(), payload };
}

/**
 * Run a handler inside the correlation context the job carries.
 *
 * The id is sanitised even though we wrote it. Job data is deserialised from
 * Redis, so it is only as trustworthy as Redis is, and it flows straight into
 * logs — the same argument that applies to the inbound HTTP header. A fresh
 * `requestId` marks this as a distinct hop from the request that enqueued it.
 */
export function runInJobContext<T>(correlationId: unknown, fn: () => T): T {
  return runWithContext(
    {
      correlationId: sanitiseCorrelationId(correlationId) ?? newCorrelationId(),
      requestId: newCorrelationId(),
    },
    fn,
  );
}
