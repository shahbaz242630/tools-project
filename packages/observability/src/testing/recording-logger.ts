import type { LogFields, Logger } from '../logger.js';

export interface LoggedRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields | undefined;
}

export interface RecordingLogger {
  readonly logger: Logger;
  readonly records: LoggedRecord[];
  /** Records at one level, in order. */
  at(level: LoggedRecord['level']): LoggedRecord[];
}

/**
 * A logger that keeps what it was given.
 *
 * Asserting on log output matters here more than it usually does: the readiness
 * endpoint deliberately withholds failure detail from its response, so the log
 * is the only place that detail exists. A test that did not check it could not
 * tell "logged privately" from "lost".
 */
export function createRecordingLogger(): RecordingLogger {
  const records: LoggedRecord[] = [];

  const build = (base: LogFields): Logger => ({
    debug: (message, fields) =>
      records.push({ level: 'debug', message, fields: { ...base, ...fields } }),
    info: (message, fields) =>
      records.push({ level: 'info', message, fields: { ...base, ...fields } }),
    warn: (message, fields) =>
      records.push({ level: 'warn', message, fields: { ...base, ...fields } }),
    error: (message, fields) =>
      records.push({ level: 'error', message, fields: { ...base, ...fields } }),
    child: (fields) => build({ ...base, ...fields }),
  });

  return {
    logger: build({}),
    records,
    at: (level) => records.filter((record) => record.level === level),
  };
}
