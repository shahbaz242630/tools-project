import { describe, expect, it } from 'vitest';
import {
  ContractViolationError,
  HEALTH_PATH,
  parseHealthResponse,
  parseReadyResponse,
  READY_PATH,
} from './health.js';

describe('paths', () => {
  it('are the ones the API actually serves', () => {
    // Asserted here so a change to either side is a failing test rather than a
    // 404 discovered in a browser.
    expect(HEALTH_PATH).toBe('/health');
    expect(READY_PATH).toBe('/ready');
  });
});

describe('parseHealthResponse', () => {
  it('accepts the documented shape', () => {
    expect(parseHealthResponse({ status: 'ok' })).toEqual({ status: 'ok' });
  });

  it.each([
    [{ status: 'fine' }, 'a different status word'],
    [{}, 'no status at all'],
    [null, 'null'],
    ['ok', 'a bare string'],
    // Both tuple elements are declared even though only the first is used:
    // vitest types the callback to the full tuple arity, so a one-parameter
    // callback is a type error.
  ])('rejects %j (%s)', (raw, _why) => {
    expect(() => parseHealthResponse(raw)).toThrow(ContractViolationError);
  });
});

describe('parseReadyResponse', () => {
  it('accepts a ready response', () => {
    const raw = { status: 'ready', checks: { postgres: 'ok', redis: 'ok' } };
    expect(parseReadyResponse(raw)).toEqual(raw);
  });

  it('accepts a not_ready response with a failing dependency', () => {
    const raw = { status: 'not_ready', checks: { postgres: 'failed', redis: 'ok' } };
    expect(parseReadyResponse(raw)).toEqual(raw);
  });

  it('accepts timeout as a distinct dependency status', () => {
    const raw = { status: 'not_ready', checks: { postgres: 'timeout' } };
    expect(parseReadyResponse(raw).checks['postgres']).toBe('timeout');
  });

  it('accepts a dependency it has never heard of', () => {
    // The API will grow dependencies. A web app that rejected an unfamiliar key
    // would break on every API deploy that adds one, which is the opposite of
    // what this validation is for.
    const raw = { status: 'ready', checks: { postgres: 'ok', s3: 'ok' } };
    expect(parseReadyResponse(raw).checks['s3']).toBe('ok');
  });

  it('accepts an empty check set', () => {
    expect(parseReadyResponse({ status: 'ready', checks: {} }).checks).toEqual({});
  });

  it.each([
    [{ status: 'ready' }, 'checks missing entirely'],
    [{ status: 'maybe', checks: {} }, 'an unknown status'],
    [{ status: 'ready', checks: { postgres: 'fine' } }, 'an unknown dependency status'],
    [{ status: 'ready', checks: [] }, 'checks as an array'],
    [{ checks: {} }, 'no status'],
    [undefined, 'nothing'],
  ])('rejects %j (%s)', (raw, _why) => {
    expect(() => parseReadyResponse(raw)).toThrow(ContractViolationError);
  });

  it('names the offending field, so a mid-deploy mismatch is diagnosable', () => {
    // The whole point of parsing here: this error should say what changed, not
    // surface later as undefined rendering a blank page.
    try {
      parseReadyResponse({ status: 'ready', checks: { postgres: 'fine' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractViolationError);
      expect((error as ContractViolationError).issues.join()).toContain(
        'checks.postgres',
      );
    }
  });
});
