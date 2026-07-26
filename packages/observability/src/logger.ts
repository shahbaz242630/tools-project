/**
 * Structured logging.
 *
 * One JSON object per line, so logs stay queryable once they reach an
 * aggregator. Human-readable formatting is a local development convenience and
 * must never be the production format — a pretty log is an unsearchable log.
 *
 * Every record carries the correlation id from the ambient context, and every
 * field passes through redaction on the way out (BRD §10).
 */

import { Time } from '@platform/core';
import { getContext } from './correlation.js';
import { redact } from './redaction.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

export interface LogRecord {
  time: string;
  level: LogLevel;
  service: string;
  message: string;
  correlationId?: string;
  requestId?: string;
  userId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger that always includes `fields`. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Minimum level emitted. */
  level?: LogLevel;
  /** Which component produced the record — `api`, `worker`, `web`. */
  service: string;
  /** Where records go. Defaults to stdout. Injected for testing. */
  sink?: (line: string) => void;
  /** Fields present on every record from this logger. */
  base?: LogFields;
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function createLogger(options: LoggerOptions): Logger {
  const minimum = LEVEL_RANK[options.level ?? 'info'];
  const sink = options.sink ?? defaultSink;
  const base = options.base ?? {};

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < minimum) return;

    const context = getContext();

    const record: LogRecord = {
      time: Time.toIsoUtc(Time.nowUtc()),
      level,
      service: options.service,
      message: String(message),
      ...(context?.correlationId !== undefined
        ? { correlationId: context.correlationId }
        : {}),
      ...(context?.requestId !== undefined ? { requestId: context.requestId } : {}),
      ...(context?.userId !== undefined ? { userId: context.userId } : {}),
      ...(redact({ ...base, ...fields }) as LogFields),
    };

    // A logger that throws turns a diagnostic into an outage. Serialisation is
    // the realistic failure — a BigInt or an exotic getter — so fall back to a
    // record that still says something useful.
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({
        time: record.time,
        level: record.level,
        service: record.service,
        message: record.message,
        correlationId: record.correlationId,
        logError: 'fields could not be serialised',
      });
    }

    sink(line);
  }

  const logger: Logger = {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) =>
      createLogger({
        ...options,
        ...(options.level !== undefined ? { level: options.level } : {}),
        base: { ...base, ...fields },
      }),
  };

  return logger;
}
