import { describe, expect, it, vi } from 'vitest';
import { FORWARD_TIMEOUT_MS, forwardIdentityEvent } from './clerk-webhook';
import type { FetchLike } from './clerk-webhook';

const BASE = 'http://api:3000';

const EVENT = {
  deliveryId: 'msg_1',
  type: 'user.created',
  data: { id: 'user_1' },
};

const answering = (status: number, body: unknown): FetchLike =>
  vi.fn(() =>
    Promise.resolve({
      status,
      text: () =>
        Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    }),
  );

describe('forwardIdentityEvent', () => {
  it('posts the event to the API', async () => {
    const fetchImpl = answering(200, { outcome: 'applied' });
    await forwardIdentityEvent(BASE, EVENT, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api:3000/internal/identity/clerk-events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(EVENT),
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('forwards the payload without interpreting it', async () => {
    // Clerk's event shape is understood in exactly one place, the API's
    // identity module. Parsing it here would mean two services having to change
    // together every time Clerk adds a field.
    const fetchImpl = answering(200, { outcome: 'applied' });
    await forwardIdentityEvent(
      BASE,
      { ...EVENT, data: { id: 'user_1', unknown_future_field: 42 } },
      fetchImpl,
    );

    const body = JSON.parse(
      (fetchImpl as unknown as { mock: { calls: [string, { body: string }][] } }).mock
        .calls[0]![1].body,
    ) as { data: Record<string, unknown> };
    expect(body.data).toEqual({ id: 'user_1', unknown_future_field: 42 });
  });

  it.each([['applied'], ['duplicate'], ['ignored']])(
    'reports the API’s %s outcome',
    async (outcome) => {
      const result = await forwardIdentityEvent(
        BASE,
        EVENT,
        answering(200, { outcome }),
      );
      expect(result).toEqual({ kind: 'accepted', result: { outcome } });
    },
  );

  it.each([[400], [404], [422]])('treats %i as not retryable', async (status) => {
    // A payload the API cannot map will never map. Asking Clerk to redeliver
    // it forever is pure noise.
    const result = await forwardIdentityEvent(BASE, EVENT, answering(status, ''));
    expect(result.kind).toBe('rejected');
  });

  it.each([[500], [502], [503]])('treats %i as retryable', async (status) => {
    // The event has not been applied, so we want the redelivery.
    const result = await forwardIdentityEvent(BASE, EVENT, answering(status, ''));
    expect(result.kind).toBe('failed');
  });

  it('treats an unreachable API as retryable', async () => {
    const result = await forwardIdentityEvent(BASE, EVENT, () =>
      Promise.reject(new Error('connect ECONNREFUSED')),
    );
    expect(result).toEqual({ kind: 'failed', reason: 'connect ECONNREFUSED' });
  });

  it('says how long it waited when the request times out', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const result = await forwardIdentityEvent(BASE, EVENT, () =>
      Promise.reject(timeout),
    );

    expect(result).toEqual({
      kind: 'failed',
      reason: `no response within ${FORWARD_TIMEOUT_MS}ms`,
    });
  });

  it('bounds the request', async () => {
    const fetchImpl = answering(200, { outcome: 'applied' });
    await forwardIdentityEvent(BASE, EVENT, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not ask for a redelivery when the API accepted but answered oddly', async () => {
    // A 2xx means it was applied. Requesting a retry on the strength of an
    // unreadable body would be acting on a claim we have no evidence for — the
    // ledger would absorb the duplicate, but the retry storm looks like a fault.
    const result = await forwardIdentityEvent(
      BASE,
      EVENT,
      answering(200, '<html>ok</html>'),
    );
    expect(result).toEqual({ kind: 'accepted', result: { outcome: 'applied' } });
  });

  it('does not ask for a redelivery when the outcome is unrecognised', async () => {
    const result = await forwardIdentityEvent(
      BASE,
      EVENT,
      answering(200, { outcome: 'something-new' }),
    );
    expect(result.kind).toBe('accepted');
  });
});

describe('forwardIdentityEvent — awkward failures', () => {
  it('describes a rejection that is not an Error', async () => {
    const result = await forwardIdentityEvent(BASE, EVENT, () =>
      Promise.reject('socket hang up'),
    );
    expect(result).toEqual({ kind: 'failed', reason: 'socket hang up' });
  });

  it('asks for a redelivery when the body fails while being read', async () => {
    // We never saw the API's answer, so we cannot claim it was applied. A
    // redelivery is safe — the ledger makes the second attempt a no-op.
    const result = await forwardIdentityEvent(BASE, EVENT, () =>
      Promise.resolve({
        status: 200,
        text: () => Promise.reject(new Error('aborted mid-body')),
      }),
    );
    expect(result).toEqual({ kind: 'failed', reason: 'aborted mid-body' });
  });
});
