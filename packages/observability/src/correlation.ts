/**
 * Correlation identifiers.
 *
 * BRD §9 requires correlation IDs so a failure can be traced across the
 * frontend, API, workers and provider adapters. A booking touches several of
 * those in sequence, and without a shared id the only way to reconstruct what
 * happened is to guess from timestamps.
 *
 * Context is carried by AsyncLocalStorage rather than threaded through every
 * function signature. Explicit passing is purer, but in practice it gets
 * dropped at exactly the boundaries that matter — inside a catch block, in a
 * queue handler, in a retry.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  /** Follows one logical operation across services. */
  readonly correlationId: string;
  /** Identifies a single hop. Absent for operations that are not requests. */
  readonly requestId?: string;
  /** Present once authenticated. Never a name or email — logs are not a CRM. */
  readonly userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Accepts an inbound correlation id only if it looks like one.
 *
 * The value arrives from an untrusted header, so it reaches logs, and possibly
 * a log query. Length-capping and character-restricting it stops a caller
 * injecting newlines to forge log entries or bloating every line with a
 * megabyte of junk.
 */
export function sanitiseCorrelationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/** Run `fn` with the given context available to everything it awaits. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Add fields to the current context for the duration of `fn`.
 *
 * Used when identity becomes known partway through a request — the correlation
 * id is assigned before authentication, the user id only after.
 */
export function withContextFields<T>(
  fields: Partial<Omit<RequestContext, 'correlationId'>>,
  fn: () => T,
): T {
  const current = storage.getStore();
  const next: RequestContext = {
    correlationId: current?.correlationId ?? newCorrelationId(),
    ...(current?.requestId !== undefined ? { requestId: current.requestId } : {}),
    ...(current?.userId !== undefined ? { userId: current.userId } : {}),
    ...fields,
  };
  return storage.run(next, fn);
}
