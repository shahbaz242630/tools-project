import { describe, expect, it } from 'vitest';
import {
  getContext,
  getCorrelationId,
  newCorrelationId,
  runWithContext,
  sanitiseCorrelationId,
  withContextFields,
} from './correlation.js';

describe('newCorrelationId', () => {
  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newCorrelationId()));
    expect(ids.size).toBe(100);
  });
});

describe('sanitiseCorrelationId', () => {
  it('accepts a well-formed id', () => {
    expect(sanitiseCorrelationId('abc-123_XYZ')).toBe('abc-123_XYZ');
    expect(sanitiseCorrelationId('  trimmed  ')).toBe('trimmed');
  });

  it('rejects a value carrying newlines, which would forge log entries', () => {
    // The header is attacker-controlled and lands in a log line. Without this,
    // a caller could inject a fabricated record.
    expect(
      sanitiseCorrelationId('good\n{"level":"error","message":"fake"}'),
    ).toBeNull();
  });

  it('rejects values that would bloat every log line', () => {
    expect(sanitiseCorrelationId('x'.repeat(129))).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['has spaces', 'spaces'],
    ['semi;colon', 'punctuation'],
  ])('rejects %s (%s)', (value) => {
    expect(sanitiseCorrelationId(value)).toBeNull();
  });

  it.each([[42], [null], [undefined], [{}]])('rejects non-string %s', (value) => {
    expect(sanitiseCorrelationId(value)).toBeNull();
  });
});

describe('context propagation', () => {
  it('is undefined outside a context', () => {
    expect(getCorrelationId()).toBeUndefined();
    expect(getContext()).toBeUndefined();
  });

  it('survives await boundaries', async () => {
    // The whole point: the id must still be there inside a catch block or a
    // queue handler, where explicit threading reliably gets dropped.
    await runWithContext({ correlationId: 'c1' }, async () => {
      expect(getCorrelationId()).toBe('c1');
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getCorrelationId()).toBe('c1');

      try {
        await Promise.reject(new Error('boom'));
      } catch {
        expect(getCorrelationId()).toBe('c1');
      }
    });
  });

  it('keeps concurrent operations separate', async () => {
    const seen: string[] = [];

    const operation = (id: string, delay: number) =>
      runWithContext({ correlationId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        seen.push(getCorrelationId() ?? 'missing');
      });

    await Promise.all([operation('a', 5), operation('b', 1), operation('c', 3)]);

    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not leak out of its scope', () => {
    runWithContext({ correlationId: 'c1' }, () => {
      expect(getCorrelationId()).toBe('c1');
    });
    expect(getCorrelationId()).toBeUndefined();
  });
});

describe('withContextFields', () => {
  it('adds fields while preserving the correlation id', () => {
    runWithContext({ correlationId: 'c1' }, () => {
      withContextFields({ userId: 'u_1' }, () => {
        expect(getContext()).toEqual({ correlationId: 'c1', userId: 'u_1' });
      });
      // Restored on exit.
      expect(getContext()?.userId).toBeUndefined();
    });
  });

  it('creates a correlation id when there is no surrounding context', () => {
    withContextFields({ userId: 'u_1' }, () => {
      expect(getCorrelationId()).toBeDefined();
      expect(getContext()?.userId).toBe('u_1');
    });
  });
});
