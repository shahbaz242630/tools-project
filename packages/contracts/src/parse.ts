/**
 * Turning an unknown response body into a typed one, or a named failure.
 *
 * Shared by every contract in this package. The reason parsing exists at all is
 * set out in `health.ts`: the API and the web app deploy independently, so
 * there is always a window where one is talking to the other's previous
 * version, and a shared TypeScript type says nothing about what actually
 * arrives over the wire during it.
 */

import type { z } from 'zod';

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

/**
 * Reports every problem rather than only the first, and names the field.
 *
 * "The identity response did not match" is not actionable on its own; "email:
 * invalid email address" says which side to go and look at.
 */
export function parseWith<T>(schema: z.ZodType<T>, what: string, raw: unknown): T {
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
