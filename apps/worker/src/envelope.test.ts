import { getContext, runWithContext } from '@platform/observability';
import { describe, expect, it } from 'vitest';
import { envelope, runInJobContext } from './envelope.js';

describe('envelope', () => {
  it('inherits the ambient correlation id', () => {
    // The point of the whole mechanism: work enqueued while handling a request
    // stays attached to that request's trace.
    const wrapped = runWithContext({ correlationId: 'from-request' }, () =>
      envelope({ source: 'api' }),
    );
    expect(wrapped.correlationId).toBe('from-request');
  });

  it('generates an id when there is no ambient context', () => {
    // Jobs enqueued by a schedule have no originating request.
    expect(envelope({ source: 'cron' }).correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the payload untouched', () => {
    expect(envelope({ source: 'api' }).payload).toEqual({ source: 'api' });
  });
});

describe('runInJobContext', () => {
  it('re-establishes the correlation id inside the handler', () => {
    let seen: string | undefined;
    runInJobContext('carried-across', () => {
      seen = getContext()?.correlationId;
    });
    expect(seen).toBe('carried-across');
  });

  it('marks the job as a distinct hop', () => {
    // correlationId spans the operation; requestId identifies this execution,
    // so a retry is distinguishable from the original attempt.
    let context: ReturnType<typeof getContext>;
    runInJobContext('carried-across', () => {
      context = getContext();
    });
    expect(context?.requestId).toBeDefined();
    expect(context?.requestId).not.toBe('carried-across');
  });

  it('rejects an id that could forge a log line', () => {
    // Job data is only as trustworthy as Redis, and it flows into logs.
    let seen: string | undefined;
    runInJobContext('ok\nlevel=error injected', () => {
      seen = getContext()?.correlationId;
    });
    expect(seen).not.toContain('\n');
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('generates an id when the job carries none', () => {
    // A job enqueued before envelopes existed still has to be traceable.
    let seen: string | undefined;
    runInJobContext(undefined, () => {
      seen = getContext()?.correlationId;
    });
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates the context into awaited work', async () => {
    const seen = await runInJobContext('async-trace', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getContext()?.correlationId;
    });
    expect(seen).toBe('async-trace');
  });
});
