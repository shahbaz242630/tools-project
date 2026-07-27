import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown.js';
import type { Closable } from './shutdown.js';
import { createRecordingLogger } from './testing/recording-logger.js';

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

function build(closables: readonly Closable[], timeoutMs = 50) {
  const recording = createRecordingLogger();
  const exits: number[] = [];
  const shutdown = createShutdown({
    closables,
    logger: recording.logger,
    timeoutMs,
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

  it('exits 1 when shutdown cannot finish', async () => {
    // The one case that genuinely is not a clean stop.
    const { shutdown, exits } = build([hanging('http')], 20);

    shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(exits).toEqual([1]);
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
