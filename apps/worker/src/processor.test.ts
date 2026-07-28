import { getCorrelationId, getContext } from '@platform/observability';
import { describe, expect, it } from 'vitest';
import { createJobProcessor } from './processor.js';
import type { JobHandler } from './processor.js';
import { envelope } from './envelope.js';

const job = (name: string, data: unknown) => ({ name, data });

describe('createJobProcessor', () => {
  it('routes a job to its handler', async () => {
    let called = false;
    const handlers: Record<string, JobHandler> = {
      heartbeat: async () => {
        called = true;
      },
    };

    await createJobProcessor(handlers)(job('heartbeat', envelope({ source: 'api' })));
    expect(called).toBe(true);
  });

  it('passes the whole envelope to the handler', async () => {
    let received: unknown;
    const handlers: Record<string, JobHandler> = {
      heartbeat: async (received_) => {
        received = received_;
      },
    };

    const data = envelope({ source: 'api' });
    await createJobProcessor(handlers)(job('heartbeat', data));
    expect(received).toEqual(data);
  });

  it('fails a job with no registered handler', async () => {
    await expect(
      createJobProcessor({})(job('unknown-job', envelope({}))),
    ).rejects.toThrow('no handler registered for job "unknown-job"');
  });

  it('names the job in the failure, so the log is actionable', async () => {
    // A deploy that removes a handler while its jobs are still queued needs to
    // say which handler went missing.
    await expect(
      createJobProcessor({})(job('send-notification', envelope({}))),
    ).rejects.toThrow('send-notification');
  });

  it('routes only by exact name', async () => {
    const handlers: Record<string, JobHandler> = { heartbeat: async () => {} };
    await expect(
      createJobProcessor(handlers)(job('heartbeat-v2', envelope({}))),
    ).rejects.toThrow('no handler registered');
  });

  it('establishes the correlation context from the envelope', async () => {
    let seen: string | undefined;
    const handlers: Record<string, JobHandler> = {
      heartbeat: async () => {
        seen = getCorrelationId();
      },
    };

    await createJobProcessor(handlers)(
      job('heartbeat', { correlationId: 'from-the-api', payload: {} }),
    );
    expect(seen).toBe('from-the-api');
  });

  it('gives the job its own request id', async () => {
    let context: ReturnType<typeof getContext>;
    const handlers: Record<string, JobHandler> = {
      heartbeat: async () => {
        context = getContext();
      },
    };

    await createJobProcessor(handlers)(
      job('heartbeat', { correlationId: 'shared', payload: {} }),
    );
    expect(context?.requestId).toBeDefined();
    expect(context?.requestId).not.toBe('shared');
  });

  it('still establishes a context when the job carries no envelope', async () => {
    // Jobs enqueued before envelopes existed must remain traceable.
    let seen: string | undefined;
    const handlers: Record<string, JobHandler> = {
      heartbeat: async () => {
        seen = getCorrelationId();
      },
    };

    await createJobProcessor(handlers)(job('heartbeat', undefined));
    expect(seen).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates the handler error to the caller', async () => {
    // BullMQ decides retries from a rejected promise; swallowing here would
    // mark a failed job complete.
    const handlers: Record<string, JobHandler> = {
      heartbeat: () => Promise.reject(new Error('downstream unavailable')),
    };

    await expect(
      createJobProcessor(handlers)(job('heartbeat', envelope({}))),
    ).rejects.toThrow('downstream unavailable');
  });
});
