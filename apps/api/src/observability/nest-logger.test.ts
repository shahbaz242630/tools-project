import { describe, expect, it } from 'vitest';
import { NestLoggerAdapter, splitParams } from './nest-logger.js';
import { createRecordingLogger } from '../testing/recording-logger.js';

function build() {
  const recording = createRecordingLogger();
  return { adapter: new NestLoggerAdapter(recording.logger), recording };
}

describe('splitParams', () => {
  it('is empty for no parameters', () => {
    expect(splitParams([])).toEqual({});
  });

  it('treats a trailing string as the emitting context', () => {
    expect(splitParams(['RoutesResolver'])).toEqual({ context: 'RoutesResolver' });
  });

  it('keeps other values rather than discarding them', () => {
    expect(splitParams([{ id: 1 }, 'AppModule'])).toEqual({
      context: 'AppModule',
      details: [{ id: 1 }],
    });
  });

  it('treats a non-string tail as detail, not context', () => {
    expect(splitParams([{ id: 1 }])).toEqual({ details: [{ id: 1 }] });
  });
});

describe('NestLoggerAdapter', () => {
  it('maps log to info', () => {
    const { adapter, recording } = build();
    adapter.log('started', 'NestFactory');
    expect(recording.records[0]).toMatchObject({
      level: 'info',
      message: 'started',
      fields: { context: 'NestFactory' },
    });
  });

  it('maps warn and error to their own levels', () => {
    const { adapter, recording } = build();
    adapter.warn('deprecated');
    adapter.error('failed');
    expect(recording.records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('maps debug to debug', () => {
    const { adapter, recording } = build();
    adapter.debug('resolving dependency');
    expect(recording.records[0]).toMatchObject({
      level: 'debug',
      message: 'resolving dependency',
    });
  });

  it('collapses verbose into debug', () => {
    // Our level set stops at debug. Inventing a level nothing filters on would
    // be worse than losing the distinction.
    const { adapter, recording } = build();
    adapter.verbose('detail');
    expect(recording.records[0]?.level).toBe('debug');
  });

  it('records fatal as an error, flagged', () => {
    const { adapter, recording } = build();
    adapter.fatal('unrecoverable');
    expect(recording.records[0]).toMatchObject({
      level: 'error',
      fields: { fatal: true },
    });
  });

  it('stringifies a non-string message', () => {
    const { adapter, recording } = build();
    adapter.log({ event: 'boot' });
    expect(recording.records[0]?.message).toBe('{"event":"boot"}');
  });

  it('uses the message of an Error', () => {
    const { adapter, recording } = build();
    adapter.error(new Error('listen EADDRINUSE'));
    expect(recording.records[0]?.message).toBe('listen EADDRINUSE');
  });

  it('survives a value that cannot be serialised', () => {
    // A logger that throws turns a diagnostic into an outage.
    const { adapter, recording } = build();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => adapter.log(circular)).not.toThrow();
    expect(recording.records[0]?.message).toBe('[object Object]');
  });
});
