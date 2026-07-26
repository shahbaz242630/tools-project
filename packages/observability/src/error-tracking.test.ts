import { describe, expect, it } from 'vitest';
import {
  createNoopErrorTracker,
  createRecordingErrorTracker,
  installProcessHandlers,
} from './error-tracking.js';
import { createLogger } from './logger.js';
import { REDACTED } from './redaction.js';
import { runWithContext } from './correlation.js';

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'debug',
    sink: (line) => lines.push(line),
  });
  return { logger, lines };
}

describe('noop tracker', () => {
  it('still writes the error to the log rather than discarding it', () => {
    // Losing the diagnostic entirely would be worse than having no aggregator.
    const { logger, lines } = capture();
    const tracker = createNoopErrorTracker(logger);

    tracker.captureException(new Error('payment failed'), { operation: 'capture' });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record.level).toBe('error');
    expect(record.operation).toBe('capture');
  });

  it('redacts secrets on the way to the log', () => {
    const { logger, lines } = capture();
    const tracker = createNoopErrorTracker(logger);

    tracker.captureException(new Error('connect postgresql://u:hunter2@db:5432/x'), {
      extra: { apiKey: 'sk_live_x' },
    });

    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('sk_live_x');
  });

  it('logs a captured message at warn with its operation', () => {
    const { logger, lines } = capture();
    const tracker = createNoopErrorTracker(logger);

    tracker.captureMessage('reconciliation mismatch', {
      operation: 'ledger.reconcile',
      extra: { bookingId: 'bk_1' },
    });

    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record.level).toBe('warn');
    expect(record.capturedMessage).toBe('reconciliation mismatch');
    expect(record.operation).toBe('ledger.reconcile');
    expect(record.bookingId).toBe('bk_1');
  });

  it('flushes successfully', async () => {
    const { logger } = capture();
    await expect(createNoopErrorTracker(logger).flush()).resolves.toBe(true);
  });
});

describe('recording tracker', () => {
  it('records exceptions and messages', () => {
    const tracker = createRecordingErrorTracker();

    tracker.captureException(new Error('boom'), { operation: 'booking.create' });
    tracker.captureMessage('something odd');

    expect(tracker.events).toHaveLength(2);
    expect(tracker.events[0]?.kind).toBe('exception');
    expect(tracker.events[0]?.context?.operation).toBe('booking.create');
    expect(tracker.events[1]?.kind).toBe('message');
  });

  it('redacts what it records', () => {
    const tracker = createRecordingErrorTracker();
    tracker.captureException(new Error('password=hunter2 at postgresql://u:pw@db/x'));

    const recorded = JSON.stringify(tracker.events);
    expect(recorded).not.toContain('pw@db');
    expect(recorded).toContain(REDACTED);
  });

  it('captures the ambient correlation id so an event ties back to a request', () => {
    const tracker = createRecordingErrorTracker();

    runWithContext({ correlationId: 'c1' }, () => {
      tracker.captureException(new Error('boom'));
    });

    expect(tracker.events[0]?.correlationId).toBe('c1');
  });

  it('resets', () => {
    const tracker = createRecordingErrorTracker();
    tracker.captureMessage('one');
    tracker.reset();
    expect(tracker.events).toHaveLength(0);
  });
});

describe('process handlers', () => {
  it('captures an unhandled rejection that would otherwise vanish', () => {
    // A rejection inside a booking-expiry or payout-release job would leave no
    // trace at all without this.
    const { logger, lines } = capture();
    const tracker = createRecordingErrorTracker();
    const uninstall = installProcessHandlers(logger, tracker);

    try {
      process.emit('unhandledRejection', new Error('orphaned'), Promise.resolve());

      expect(tracker.events).toHaveLength(1);
      expect(tracker.events[0]?.context?.operation).toBe('unhandledRejection');
      expect(tracker.events[0]?.context?.severity).toBe('fatal');
      expect(lines[0]).toContain('unhandled promise rejection');
    } finally {
      uninstall();
    }
  });

  it('captures an uncaught exception', () => {
    const { logger, lines } = capture();
    const tracker = createRecordingErrorTracker();
    const uninstall = installProcessHandlers(logger, tracker);

    try {
      // Node would normally terminate the process here. The handler must both
      // log and report before that happens, or the cause is lost entirely.
      process.emit('uncaughtException', new Error('fatal'));

      expect(tracker.events).toHaveLength(1);
      expect(tracker.events[0]?.context?.operation).toBe('uncaughtException');
      expect(tracker.events[0]?.context?.severity).toBe('fatal');
      expect(lines[0]).toContain('uncaught exception');
    } finally {
      uninstall();
    }
  });

  it('redacts secrets before a fatal error reaches the tracker', () => {
    const { logger, lines } = capture();
    const tracker = createRecordingErrorTracker();
    const uninstall = installProcessHandlers(logger, tracker);

    try {
      process.emit('uncaughtException', new Error('postgresql://u:hunter2@db:5432/x'));

      expect(JSON.stringify(tracker.events)).not.toContain('hunter2');
      expect(lines[0]).not.toContain('hunter2');
    } finally {
      uninstall();
    }
  });

  it('removes its listeners on uninstall so tests do not leak them', () => {
    const { logger } = capture();
    const tracker = createRecordingErrorTracker();

    const before = process.listenerCount('unhandledRejection');
    const uninstall = installProcessHandlers(logger, tracker);
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);

    uninstall();
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });
});
