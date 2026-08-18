import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecordingLogger } from '@platform/observability/testing';
import type { RecordingLogger } from '@platform/observability/testing';
import { createExpireRequestsHandler } from './expire-requests.handler.js';
import { envelope } from './envelope.js';

/**
 * The scheduled sweep's handler (slice 4.7b).
 *
 * **`fetch` is injected rather than an HTTP server stood up**, because what this
 * file is about is the *call*: the path, the header, and what each answer does to the
 * job. That the route exists and answers is 4.7a's, proved through the real routing
 * in `bookings.integration.test.ts`.
 */

const SECRET = 'example-internal-trigger-secret-not-a-real-one';
const BASE = 'http://api:3000';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createExpireRequestsHandler', () => {
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = createRecordingLogger();
  });

  function handlerWith(fetchImpl: typeof fetch) {
    return createExpireRequestsHandler({
      apiBaseUrl: BASE,
      secret: SECRET,
      logger: logger.logger,
      fetchImpl,
    });
  }

  describe('the call it makes', () => {
    it('POSTs to the trigger with the secret in the header', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(ok({ expired: 0, bookingIds: [], reachedLimit: false }));

      await handlerWith(fetchImpl)(envelope({}));

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [target, init] = fetchImpl.mock.calls[0] ?? [];
      expect(target).toBe('http://api:3000/internal/bookings/expire-requests');
      expect(init?.method).toBe('POST');
      expect(
        (init?.headers as Record<string, string> | undefined)?.['x-internal-trigger'],
      ).toBe(SECRET);
    });

    it('does not double the slash when the base URL has a trailing one', async () => {
      // `new URL(path, base)` rather than concatenation. A trailing slash is what an
      // env file gets when somebody pastes a URL from a browser.
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(ok({ expired: 0, reachedLimit: false }));

      await createExpireRequestsHandler({
        apiBaseUrl: 'http://api:3000/',
        secret: SECRET,
        logger: logger.logger,
        fetchImpl,
      })(envelope({}));

      expect(fetchImpl.mock.calls[0]?.[0]).toBe(
        'http://api:3000/internal/bookings/expire-requests',
      );
    });

    it('bounds the request with a timeout signal', async () => {
      // Without one, `fetch` waits on the OS — minutes for a black-holed
      // connection, which is longer than the interval between sweeps.
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(ok({ expired: 0, reachedLimit: false }));

      await handlerWith(fetchImpl)(envelope({}));

      expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('what it says about the outcome', () => {
    it('logs nothing at info when the sweep found nothing', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(ok({ expired: 0, bookingIds: [], reachedLimit: false }));

      await handlerWith(fetchImpl)(envelope({}));

      // Ninety-six ticks a day, almost all empty.
      expect(logger.at('info')).toEqual([]);
      expect(logger.at('debug')).toHaveLength(1);
    });

    it('logs a count when it expired something, and no ids', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        ok({
          expired: 2,
          bookingIds: ['12eca8a6-acb2-4c1b-9f9b-ee75312d78bd', 'other-id'],
          reachedLimit: false,
        }),
      );

      await handlerWith(fetchImpl)(envelope({}));

      const [line] = logger.at('info');
      expect(line?.message).toBe('expiry sweep expired requests');
      expect(line?.fields).toMatchObject({ expired: 2 });

      /*
       * The API's own line carries the ids. Repeating them here would put the same
       * data in two places with two retention stories, and the worker has no reason
       * to know which rows they were.
       */
      expect(JSON.stringify(logger.records)).not.toContain('12eca8a6');
    });

    it('warns when the batch filled, because that means look', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(ok({ expired: 500, reachedLimit: true }));

      await handlerWith(fetchImpl)(envelope({}));

      expect(logger.at('warn')).toHaveLength(1);
      expect(logger.at('warn')[0]?.message).toContain('filled its batch');
    });

    it('does not warn when it did not fill the batch', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(ok({ expired: 1, reachedLimit: false }));

      await handlerWith(fetchImpl)(envelope({}));

      expect(logger.at('warn')).toEqual([]);
    });

    it('treats a response with no count as nothing expired rather than throwing', async () => {
      /*
       * The worker does not own this contract and parses it loosely on purpose: a
       * *successful* sweep must not fail the job because a field it only logs
       * changed shape. `@platform/contracts` holds the strict schema for callers
       * that act on the answer.
       */
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok({}));

      await expect(handlerWith(fetchImpl)(envelope({}))).resolves.toBeUndefined();
      expect(logger.at('debug')).toHaveLength(1);
    });
  });

  describe('when it fails', () => {
    it('throws when the API refuses, so BullMQ fails the job', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('', { status: 401 }));

      await expect(handlerWith(fetchImpl)(envelope({}))).rejects.toThrow('401');

      // A 401 means the two halves of ADR 0048 disagree about the secret, and that
      // has to be readable off one line.
      expect(logger.at('error')[0]?.fields).toMatchObject({ status: 401 });
    });

    it('throws when the API cannot be reached', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError('fetch failed'));

      await expect(handlerWith(fetchImpl)(envelope({}))).rejects.toThrow(
        'failed to reach the API',
      );
      expect(logger.at('error')[0]?.fields).toMatchObject({ reason: 'TypeError' });
    });

    it('reports a timeout by name rather than as a generic failure', async () => {
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(abort);

      await expect(handlerWith(fetchImpl)(envelope({}))).rejects.toThrow();

      expect(logger.at('error')[0]?.fields).toMatchObject({ reason: 'AbortError' });
    });

    it('writes no secret in the fields it chooses itself', async () => {
      /*
       * **What this pins and what it does not.** The handler's *own* log fields carry
       * a target and an error name and nothing else — this asserts that.
       *
       * It deliberately does **not** assert that the rethrown error is secret-free.
       * It is not: the cause is attached, because dropping it loses the only useful
       * diagnostic and `preserve-caught-error` refuses it. What keeps the secret out
       * of a log is `x-internal-trigger` being in `SENSITIVE_KEY_PATTERNS`, proved
       * in `redaction.test.ts` — and `createRecordingLogger` applies no redaction, so
       * a test here could not be evidence of it either way.
       */
      const carrier = new TypeError('fetch failed');
      (carrier as { cause?: unknown }).cause = {
        headers: { 'x-internal-trigger': SECRET },
      };
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(carrier);

      await expect(handlerWith(fetchImpl)(envelope({}))).rejects.toThrow();

      expect(JSON.stringify(logger.at('error')[0]?.fields)).not.toContain(SECRET);
    });

    it('attaches the cause, so a refused connection is diagnosable', async () => {
      // Dropping it would leave `reason: 'TypeError'` and nothing about the address
      // or the syscall — which is most of what a person needs at 3am.
      const underlying = new TypeError('fetch failed');
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(underlying);

      await expect(handlerWith(fetchImpl)(envelope({}))).rejects.toMatchObject({
        cause: underlying,
      });
    });

    it('never writes the secret on a refusal either', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(SECRET, { status: 500 }));

      await expect(handlerWith(fetchImpl)(envelope({}))).rejects.toThrow();

      // The body is not logged. It is ours, but it is the one part of this exchange
      // nothing has validated — and here it is the secret itself.
      expect(JSON.stringify(logger.records)).not.toContain(SECRET);
    });
  });
});
