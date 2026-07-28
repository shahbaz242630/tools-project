import { describe, expect, it } from 'vitest';
import { buildLogArgs, LogArgsError, parseLogArgs } from './log-args.mjs';

const parse = (...argv) => parseLogArgs(argv);

describe('parseLogArgs', () => {
  it('defaults to the last hour, all services, 500 lines', () => {
    expect(parse('--env', 'staging')).toMatchObject({
      env: 'staging',
      service: null,
      since: '1h',
      tail: '500',
      follow: false,
    });
  });

  it('requires an environment', () => {
    expect(() => parse('--service', 'api')).toThrow(/--env is required/);
  });

  it('accepts the ingress stack', () => {
    expect(parse('--env', 'ingress').env).toBe('ingress');
  });

  it('rejects an unknown environment', () => {
    expect(() => parse('--env', 'prod')).toThrow(/must be one of/);
  });

  it('rejects a service that is not in the stack', () => {
    // Would otherwise return nothing and exit 0, which reads as "no logs".
    expect(() => parse('--env', 'staging', '--service', 'caddy')).toThrow(
      /--service must be one of/,
    );
  });

  it.each([
    ['30m'],
    ['45s'],
    ['2h'],
    ['500ms'],
    ['2026-07-28T09:30:00Z'],
    ['2026-07-28T09:30:00+01:00'],
  ])('accepts --since %j', (since) => {
    expect(parse('--env', 'staging', '--since', since).since).toBe(since);
  });

  it.each([
    ['yesterday', 'a word'],
    ['30', 'a bare number with no unit'],
    ['30 minutes', 'a spaced duration'],
    ['2026-07-28', 'a date with no time'],
  ])('rejects --since %j (%s)', (since) => {
    // The important case: Docker silently ignores these and returns the whole
    // log, so the operator concludes the incident window was quiet.
    expect(() => parse('--env', 'staging', '--since', since)).toThrow(
      /neither a duration nor a timestamp/,
    );
  });

  it('accepts --tail all', () => {
    expect(parse('--env', 'staging', '--tail', 'all').tail).toBe('all');
  });

  it('rejects a non-numeric --tail', () => {
    expect(() => parse('--env', 'staging', '--tail', 'lots')).toThrow(/whole number/);
  });

  it('refuses --follow with --out, which would never finish the file', () => {
    expect(() => parse('--env', 'staging', '--follow', '--out', 'x.log')).toThrow(
      /never be finished/,
    );
  });

  it('refuses an unrecognised flag', () => {
    expect(() => parse('--env', 'staging', '--tial', '10')).toThrow(LogArgsError);
  });

  it('refuses a flag with a missing value', () => {
    expect(() => parse('--env', 'staging', '--since', '--tail', '10')).toThrow(
      /--since needs a value/,
    );
  });
});

describe('buildLogArgs', () => {
  it('always asks for timestamps', () => {
    // Without them, correlating an API error with a worker retry is guesswork.
    expect(buildLogArgs(parse('--env', 'staging'))).toContain('--timestamps');
  });

  it('passes the window and line budget through', () => {
    expect(
      buildLogArgs(parse('--env', 'staging', '--since', '15m', '--tail', '20')),
    ).toEqual(['logs', '--timestamps', '--since', '15m', '--tail', '20']);
  });

  it('appends the service filter last, where compose expects it', () => {
    const args = buildLogArgs(parse('--env', 'production', '--service', 'worker'));
    expect(args.at(-1)).toBe('worker');
  });

  it('does not filter by service on the single-service ingress stack', () => {
    const args = buildLogArgs(parse('--env', 'ingress', '--service', 'api'));
    expect(args).not.toContain('api');
  });

  it('adds --follow only when asked', () => {
    expect(buildLogArgs(parse('--env', 'staging'))).not.toContain('--follow');
    expect(buildLogArgs(parse('--env', 'staging', '--follow'))).toContain('--follow');
  });
});
