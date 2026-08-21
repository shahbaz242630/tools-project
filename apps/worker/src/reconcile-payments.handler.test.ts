import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecordingLogger } from '@platform/observability/testing';
import type { RecordingLogger } from '@platform/observability/testing';
import { createReconcilePaymentsHandler } from './reconcile-payments.handler.js';
import { envelope } from './envelope.js';

/**
 * The reconciliation trigger (slice 5.4b).
 *
 * **The mechanics live in `internal-trigger.ts` and are tested there**, so this file
 * asserts only what is this handler's own: the path it calls and **what it says
 * about what came back**. The narration is the reason this is a separate handler
 * rather than a shared one with a parameter.
 *
 * **The assertions that matter are about `unreconcilable`** — the count that means
 * money may have moved with nothing pointing at it — and about the secret never
 * reaching a log line.
 */

const SECRET = 'example-internal-trigger-secret-not-a-real-one';
const BASE = 'http://api:3000';

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

const sweep = (over: Record<string, unknown> = {}) => ({
  examined: 0,
  settled: 0,
  stillPending: 0,
  unreconcilable: 0,
  reachedLimit: false,
  ...over,
});

describe('the reconciliation handler', () => {
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = createRecordingLogger();
  });

  function handlerWith(fetchImpl: typeof fetch) {
    return createReconcilePaymentsHandler({
      apiBaseUrl: BASE,
      secret: SECRET,
      logger: logger.logger,
      fetchImpl,
    });
  }

  it('POSTs to the reconciliation trigger with the secret in the header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ok(sweep()));

    await handlerWith(fetchImpl)(envelope({}));

    const [target, init] = fetchImpl.mock.calls[0] ?? [];
    expect(target).toBe('http://api:3000/internal/payments/reconcile');
    expect(init?.method).toBe('POST');
    expect(
      (init?.headers as Record<string, string> | undefined)?.['x-internal-trigger'],
    ).toBe(SECRET);
  });

  /**
   * **Production's actual behaviour today**, because `booking.payment` is off so no
   * attempt can be opened. Forty-eight ticks a day, every one of them empty — at
   * `debug`, or the log becomes something nobody reads.
   */
  it('says nothing at info when there was nothing to examine', async () => {
    await handlerWith(vi.fn<typeof fetch>().mockResolvedValue(ok(sweep())))(
      envelope({}),
    );

    expect(logger.at('info')).toHaveLength(0);
    expect(logger.at('debug')).toHaveLength(1);
  });

  it('reports what an ordinary sweep found', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(ok(sweep({ examined: 3, settled: 2, stillPending: 1 })));

    await handlerWith(fetchImpl)(envelope({}));

    expect(logger.at('info')[0]?.fields).toMatchObject({
      examined: 3,
      settled: 2,
      stillPending: 1,
    });
  });
});

/**
 * **The line this whole slice exists to produce.**
 *
 * An attempt with no provider reference cannot be read back at all — either the call
 * never left or the answer was lost, and in the second case money moved with nothing
 * pointing at it. It gets its own `warn`, separate from the summary, because folding
 * it in would put the one number meaning *go and look* beside four meaning *fine*.
 */
describe('when attempts could not be reconciled at all', () => {
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = createRecordingLogger();
  });

  const run = (body: unknown) =>
    createReconcilePaymentsHandler({
      apiBaseUrl: BASE,
      secret: SECRET,
      logger: logger.logger,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(ok(body)),
    })(envelope({}));

  it('warns, on its own line, with the count', async () => {
    await run(sweep({ examined: 2, unreconcilable: 2 }));

    const warned = logger
      .at('warn')
      .find((record) => record.message.includes('could not be reconciled'));

    expect(warned?.fields).toMatchObject({ unreconcilable: 2 });
  });

  /**
   * **Even on a sweep that was otherwise entirely ordinary.** This is the case that
   * would be missed by folding the count into the summary: nine attempts settled
   * perfectly and one cannot be found, which reads as a good sweep unless the number
   * is called out.
   */
  it('warns even when everything else went well', async () => {
    await run(sweep({ examined: 10, settled: 9, unreconcilable: 1 }));

    expect(
      logger
        .at('warn')
        .some((record) => record.message.includes('could not be reconciled')),
    ).toBe(true);
    // And the ordinary summary is still written, so both facts are available.
    expect(logger.at('info')).toHaveLength(1);
  });

  it('stays quiet when there are none', async () => {
    await run(sweep({ examined: 5, settled: 5 }));

    expect(
      logger
        .at('warn')
        .some((record) => record.message.includes('could not be reconciled')),
    ).toBe(false);
  });

  it('warns when the batch filled, because more may be waiting', async () => {
    await run(sweep({ examined: 100, settled: 100, reachedLimit: true }));

    expect(
      logger.at('warn').some((record) => record.message.includes('filled its batch')),
    ).toBe(true);
  });
});

/**
 * **The secret is an outbound header, which is the direction that leaks.** A `fetch`
 * rejection can carry the whole request on `cause`. What keeps it out of a log is
 * `SENSITIVE_KEY_PATTERNS` at the logging layer plus this handler describing errors
 * rather than logging them — and this asserts the result rather than the mechanism.
 */
describe('the secret', () => {
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = createRecordingLogger();
  });

  const failing = (fetchImpl: typeof fetch) =>
    createReconcilePaymentsHandler({
      apiBaseUrl: BASE,
      secret: SECRET,
      logger: logger.logger,
      fetchImpl,
    })(envelope({}));

  it('appears in nothing this handler writes when the API is unreachable', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: { headers: { 'x-internal-trigger': SECRET } },
      }),
    );

    await expect(failing(fetchImpl)).rejects.toThrow(/failed to reach the API/);

    expect(JSON.stringify(logger.records)).not.toContain(SECRET);
  });

  it('appears in nothing this handler writes when the API refuses', async () => {
    // A 401 means the two halves of ADR 0048 disagree about the secret — the
    // commonest way this breaks, and the worst moment to write it into a log.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, status: 401 } as Response);

    await expect(failing(fetchImpl)).rejects.toThrow(/returned 401/);

    expect(JSON.stringify(logger.records)).not.toContain(SECRET);
    expect(logger.at('error')[0]?.fields).toMatchObject({ status: 401 });
  });
});
