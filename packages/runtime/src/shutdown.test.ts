import { describe, expect, it, vi } from 'vitest';
import { createRecordingLogger } from '@platform/observability/testing';
import { createShutdown } from './shutdown.js';
import type { Closable } from './shutdown.js';

const closable = (name: string, order: string[]): Closable => ({
  name,
  close: async () => {
    order.push(name);
  },
});

const failing = (name: string, message: string): Closable => ({
  name,
  close: () => Promise.reject(new Error(message)),
});

const hanging = (name: string): Closable => ({
  name,
  close: () => new Promise<void>(() => {}),
});

function build(closables: readonly Closable[], timeoutMs = 50, closeTimeoutMs = 20) {
  const recording = createRecordingLogger();
  const exits: number[] = [];
  const shutdown = createShutdown({
    closables,
    logger: recording.logger,
    timeoutMs,
    closeTimeoutMs,
    exit: (code) => void exits.push(code),
  });
  return { shutdown, exits, recording };
}

/** Lets the queued shutdown promise chain run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('createShutdown', () => {
  it('closes resources in order and exits cleanly', async () => {
    const order: string[] = [];
    const { shutdown, exits } = build([
      closable('http', order),
      closable('postgres', order),
      closable('redis', order),
    ]);

    shutdown('SIGTERM');
    await settle();

    expect(order).toEqual(['http', 'postgres', 'redis']);
    expect(exits).toEqual([0]);
  });

  it('exits 0 when a resource fails to close', async () => {
    // Regression: `redis.quit()` rejects when the client never connected, which
    // is exactly the state during a Redis outage. Exiting non-zero told the
    // orchestrator the process had crashed, so an ordinary deploy during an
    // outage looked like a crash loop. Found by CI, where no Redis exists.
    const { shutdown, exits } = build([
      failing(
        'redis',
        "Stream isn't writeable and enableOfflineQueue options is false",
      ),
    ]);

    shutdown('SIGTERM');
    await settle();

    expect(exits).toEqual([0]);
  });

  it('keeps closing the rest after one fails', async () => {
    const order: string[] = [];
    const { shutdown } = build([
      failing('http', 'already closed'),
      closable('postgres', order),
      closable('redis', order),
    ]);

    shutdown('SIGTERM');
    await settle();

    // A failure early in the list must not strand a database connection.
    expect(order).toEqual(['postgres', 'redis']);
  });

  it('logs which resource failed rather than swallowing it', async () => {
    const { shutdown, recording } = build([failing('redis', 'never connected')]);

    shutdown('SIGTERM');
    await settle();

    const warnings = recording.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields?.['resource']).toBe('redis');
    expect((warnings[0]?.fields?.['error'] as Error).message).toBe('never connected');
  });

  it('gives up on a resource that never closes, and still stops cleanly', async () => {
    // Regression, bullmq 6: `Worker.close()` never settles when Redis was never
    // reachable. Before this was bounded, the wait ran past the container's
    // stop_grace_period every time and Docker SIGKILLed the process, so an
    // ordinary deploy during a Redis outage produced exit 137 — a crash, as far
    // as the orchestrator is concerned. A hang is the same failure as a throw.
    //
    // This test previously asserted the opposite (`exits 1 when shutdown cannot
    // finish`), which was the honest reading of the old design: nothing bounded
    // an individual close, so the only possible outcome was the outer timeout.
    const { shutdown, exits, recording } = build([hanging('worker')], 200, 20);

    shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(exits).toEqual([0]);
    const warnings = recording.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields?.['resource']).toBe('worker');
    expect(warnings[0]?.fields?.['timeoutMs']).toBe(20);
  });

  it('keeps closing the rest after one hangs', async () => {
    // The point of bounding each wait rather than only the sequence: one wedged
    // resource must not consume the window every later one was going to share.
    const order: string[] = [];
    const { shutdown, exits } = build(
      [hanging('worker'), closable('postgres', order), closable('redis', order)],
      500,
      20,
    );

    shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(order).toEqual(['postgres', 'redis']);
    expect(exits).toEqual([0]);
  });

  it('honours a per-resource bound over the default', async () => {
    // A worker draining a real job needs longer than a socket being dropped.
    const { shutdown, exits, recording } = build(
      [{ ...hanging('worker'), timeoutMs: 15 }],
      200,
      5_000,
    );

    shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(exits).toEqual([0]);
    expect(recording.at('warn')[0]?.fields?.['timeoutMs']).toBe(15);
  });

  it('exits 1 when the whole sequence outruns its backstop', async () => {
    // Still reachable, and now reachable *before* the orchestrator gives up —
    // which is the entire point. Three bounded hangs outlast the backstop.
    const { shutdown, exits } = build(
      [hanging('a'), hanging('b'), hanging('c')],
      40,
      30,
    );

    shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(exits[0]).toBe(1);
  });

  it('does not let a late rejection escape after it stopped waiting', async () => {
    // Abandoning a promise without a handler turns a slow failure into an
    // unhandled rejection during exit — a second bad exit code chasing the first.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const slowFailure: Closable = {
        name: 'redis',
        close: () =>
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('too late')), 30),
          ),
      };
      const { shutdown, exits } = build([slowFailure], 200, 10);

      shutdown('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 90));

      expect(exits).toEqual([0]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('ignores a repeated signal', async () => {
    const order: string[] = [];
    const { shutdown, exits } = build([closable('http', order)]);

    shutdown('SIGTERM');
    shutdown('SIGTERM');
    shutdown('SIGINT');
    await settle();

    expect(order).toEqual(['http']);
    expect(exits).toEqual([0]);
  });

  it('cancels the force-exit timer once finished', async () => {
    // A live timer would hold the event loop open and delay the exit it exists
    // to prevent.
    vi.useFakeTimers();
    try {
      const { shutdown } = build([], 60_000);
      shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the signal it acted on', async () => {
    const { shutdown, recording } = build([]);

    shutdown('SIGINT');
    await settle();

    expect(recording.at('info').map((r) => r.fields?.['signal'])).toEqual([
      'SIGINT',
      'SIGINT',
    ]);
  });
});
