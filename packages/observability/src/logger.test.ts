import { describe, expect, it } from 'vitest';
import { REDACTED } from './redaction.js';
import { createLogger, type LogRecord } from './logger.js';
import { newCorrelationId, runWithContext, withContextFields } from './correlation.js';

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'debug',
    sink: (line) => lines.push(line),
  });
  return {
    logger,
    records: () => lines.map((l) => JSON.parse(l) as LogRecord),
    raw: () => lines,
  };
}

describe('record shape', () => {
  it('emits one JSON object per line', () => {
    const { logger, raw } = capture();
    logger.info('first');
    logger.info('second');

    expect(raw()).toHaveLength(2);
    for (const line of raw()) {
      expect(line).not.toContain('\n');
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('includes time, level, service and message', () => {
    const { logger, records } = capture();
    logger.warn('careful', { bookingId: 'bk_1' });

    const [record] = records();
    expect(record?.level).toBe('warn');
    expect(record?.service).toBe('test');
    expect(record?.message).toBe('careful');
    expect(record?.bookingId).toBe('bk_1');
    // UTC, per BRD §6.1 — never a local timestamp.
    expect(record?.time).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});

describe('levels', () => {
  it('suppresses records below the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: 'test',
      level: 'warn',
      sink: (line) => lines.push(line),
    });

    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');

    expect(lines).toHaveLength(2);
  });

  it('defaults to info', () => {
    const lines: string[] = [];
    const logger = createLogger({ service: 'test', sink: (line) => lines.push(line) });
    logger.debug('hidden');
    logger.info('shown');
    expect(lines).toHaveLength(1);
  });
});

describe('correlation', () => {
  it('attaches the ambient correlation id without being asked', () => {
    const { logger, records } = capture();
    const correlationId = newCorrelationId();

    runWithContext({ correlationId }, () => logger.info('inside'));

    expect(records()[0]?.correlationId).toBe(correlationId);
  });

  it('omits correlation fields entirely when there is no context', () => {
    const { logger, records } = capture();
    logger.info('outside');

    const record = records()[0];
    expect(record).not.toHaveProperty('correlationId');
    expect(record).not.toHaveProperty('userId');
  });

  it('picks up identity added partway through a request', () => {
    const { logger, records } = capture();

    runWithContext({ correlationId: 'c1' }, () => {
      logger.info('before auth');
      withContextFields({ userId: 'u_1' }, () => logger.info('after auth'));
    });

    expect(records()[0]?.userId).toBeUndefined();
    expect(records()[1]?.userId).toBe('u_1');
    expect(records()[1]?.correlationId).toBe('c1');
  });
});

describe('redaction', () => {
  it('redacts secrets passed as fields, at any depth', () => {
    const { logger, raw, records } = capture();
    logger.info('connecting', {
      databaseUrl: 'postgresql://rental:hunter2@db:5432/x',
      config: { password: 'hunter2', poolSize: 10 },
    });

    // The property that actually matters: the secret is nowhere in the output.
    expect(raw()[0]).not.toContain('hunter2');

    // `config` is not itself a sensitive name, so redaction descends into it
    // and leaves the harmless siblings usable.
    expect(records()[0]?.config).toEqual({ password: REDACTED, poolSize: 10 });
    expect(records()[0]?.databaseUrl).toBe(`postgresql://rental:${REDACTED}@db:5432/x`);
  });

  it('redacts secrets in child logger base fields', () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: 'test',
      sink: (line) => lines.push(line),
    }).child({ apiKey: 'sk_live_secret' });

    logger.info('using provider');
    expect(lines[0]).not.toContain('sk_live_secret');
  });
});

describe('child loggers', () => {
  it('merges base fields into every record', () => {
    const { records } = capture();
    const lines: string[] = [];
    const base = createLogger({
      service: 'test',
      sink: (line) => lines.push(line),
    });
    const child = base.child({ module: 'booking' });

    child.info('created', { bookingId: 'bk_1' });

    const record = JSON.parse(lines[0] ?? '{}') as LogRecord;
    expect(record.module).toBe('booking');
    expect(record.bookingId).toBe('bk_1');
    expect(records()).toHaveLength(0);
  });
});

describe('resilience', () => {
  it('never throws on an unserialisable field', () => {
    // A logger that throws converts a diagnostic into an outage.
    const { logger, records } = capture();

    expect(() => logger.info('with bigint', { value: 1n })).not.toThrow();

    const record = records()[0];
    expect(record?.message).toBe('with bigint');
    expect(record?.logError).toBe('fields could not be serialised');
  });
});
