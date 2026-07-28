/**
 * The health and readiness contract between the API and everything that calls
 * it.
 *
 * These are shared *and validated at runtime*, which for an internal call
 * between two of our own services looks like paranoia. It is not. The API and
 * the web app are separate containers deployed independently, and a deploy
 * replaces them at slightly different moments — so there is always a window
 * where a new web app is talking to the previous API, or the reverse. A shared
 * TypeScript type says nothing about what actually arrives over the wire during
 * that window.
 *
 * Parsing turns "the API changed shape" into a named error at the boundary,
 * rather than `undefined` propagating into a component and rendering as a blank
 * page.
 */

import { z } from 'zod';

/** Where the API serves these. Callers should not spell the paths themselves. */
export const HEALTH_PATH = '/health';
export const READY_PATH = '/ready';

/**
 * How a single dependency answered.
 *
 * Coarse on purpose: the underlying driver error names hosts, ports, users and
 * sometimes the whole connection string, so it is logged and never serialised.
 */
export const dependencyStatusSchema = z.enum(['ok', 'failed', 'timeout']);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

/**
 * Liveness. Deliberately depends on nothing — it answers "is this process
 * alive", not "can it serve".
 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * Readiness. Should this instance receive traffic right now?
 *
 * `checks` is an open record rather than a fixed set of keys: dependencies get
 * added over time, and a web app that refused to parse a response containing a
 * dependency it had not heard of would break on every API deploy that adds one.
 */
export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.record(z.string(), dependencyStatusSchema),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;

/** Raised when a response does not match the contract. */
export class ContractViolationError extends Error {
  readonly issues: readonly string[];

  constructor(what: string, issues: readonly string[]) {
    super(
      `${what} did not match the expected contract:\n${issues
        .map((issue) => `  - ${issue}`)
        .join('\n')}`,
    );
    this.name = 'ContractViolationError';
    this.issues = issues;
  }
}

function parseWith<T>(schema: z.ZodType<T>, what: string, raw: unknown): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new ContractViolationError(
      what,
      result.error.issues.map((issue) => {
        const path = issue.path.join('.');
        return path === '' ? issue.message : `${path}: ${issue.message}`;
      }),
    );
  }

  return result.data;
}

export function parseHealthResponse(raw: unknown): HealthResponse {
  return parseWith(healthResponseSchema, 'The health response', raw);
}

export function parseReadyResponse(raw: unknown): ReadyResponse {
  return parseWith(readyResponseSchema, 'The readiness response', raw);
}
