import { getContext } from '@platform/observability';
import { describe, expect, it } from 'vitest';
import { CORRELATION_HEADER, CorrelationMiddleware } from './correlation.middleware.js';

function run(headers: Record<string, string | string[] | undefined> = {}) {
  const middleware = new CorrelationMiddleware();
  const set = new Map<string, string>();
  let seen: ReturnType<typeof getContext>;

  middleware.use(
    { headers },
    { setHeader: (name, value) => void set.set(name, value) },
    () => {
      seen = getContext();
    },
  );

  return { set, context: seen };
}

describe('CorrelationMiddleware', () => {
  it('establishes a context for the request', () => {
    const { context } = run();
    expect(context?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('makes the context visible to downstream code', () => {
    // The whole point: a log line written deep inside a handler must carry the
    // id without anyone having threaded it through the call stack.
    expect(run().context).toBeDefined();
  });

  it('honours a valid inbound id so a trace survives the hop', () => {
    const { context } = run({ [CORRELATION_HEADER]: 'abc-123_XYZ' });
    expect(context?.correlationId).toBe('abc-123_XYZ');
  });

  it('echoes the id back to the caller', () => {
    const { set, context } = run();
    expect(set.get(CORRELATION_HEADER)).toBe(context?.correlationId);
  });

  it('gives each request its own request id, distinct from the correlation id', () => {
    // correlationId spans the whole operation; requestId identifies one hop.
    const { context } = run({ [CORRELATION_HEADER]: 'shared-trace' });
    expect(context?.correlationId).toBe('shared-trace');
    expect(context?.requestId).not.toBe('shared-trace');
  });

  it('rejects an inbound id containing a newline', () => {
    // Otherwise a caller can forge log entries: the header lands in a log line,
    // and a newline lets them write a second one that looks like ours.
    const { context } = run({ [CORRELATION_HEADER]: 'good\nlevel=error fake' });
    expect(context?.correlationId).not.toContain('\n');
    expect(context?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects an oversized inbound id', () => {
    const { context } = run({ [CORRELATION_HEADER]: 'x'.repeat(500) });
    expect(context?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores a repeated header rather than trusting the array', () => {
    const { context } = run({ [CORRELATION_HEADER]: ['one', 'two'] });
    expect(context?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates a fresh id per request', () => {
    expect(run().context?.correlationId).not.toBe(run().context?.correlationId);
  });
});
