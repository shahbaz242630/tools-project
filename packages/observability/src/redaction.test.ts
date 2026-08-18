import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactString } from './redaction.js';

describe('redactString', () => {
  it('strips the password from a connection string', () => {
    expect(redactString('postgresql://rental:hunter2@localhost:5433/rental_dev')).toBe(
      `postgresql://rental:${REDACTED}@localhost:5433/rental_dev`,
    );
  });

  it('leaves a credential-free url intact', () => {
    expect(redactString('redis://cache:6379')).toBe('redis://cache:6379');
  });

  it('strips bearer and basic tokens from free text', () => {
    expect(redactString('called with Authorization: Bearer abc.def-ghi_123==')).toBe(
      `called with Authorization: Bearer ${REDACTED}`,
    );
    expect(redactString('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED}`);
  });
});

describe('redact', () => {
  it('redacts sensitive keys at any depth', () => {
    const input = {
      user: 'alice',
      auth: { password: 'hunter2', apiKey: 'sk_live_123' },
      nested: [{ token: 'abc' }, { safe: 'keep me' }],
    };

    expect(redact(input)).toEqual({
      user: 'alice',
      auth: REDACTED,
      nested: [{ token: REDACTED }, { safe: 'keep me' }],
    });
  });

  it.each([
    'password',
    'Password',
    'POSTGRES_PASSWORD',
    'apiKey',
    'api_key',
    'API-KEY',
    'accessToken',
    'authorization',
    'cvv',
    'cardNumber',
    'nationalInsurance',
    'dateOfBirth',
  ])('treats %s as sensitive', (key) => {
    expect(redact({ [key]: 'value' })).toEqual({ [key]: REDACTED });
  });

  it('redacts precise location, which our own privacy design withholds', () => {
    // BRD §8.4.1 keeps true coordinates out of public responses so an owner's
    // address cannot be trilaterated. Logging them would undo that.
    const listing = {
      id: 'l_1',
      latitude: 51.5072,
      longitude: -0.1276,
      title: 'Drill',
    };

    expect(redact(listing)).toEqual({
      id: 'l_1',
      latitude: REDACTED,
      longitude: REDACTED,
      title: 'Drill',
    });
  });

  it('keeps non-sensitive values usable', () => {
    const input = { bookingId: 'bk_1', amount: 1234, currency: 'GBP', active: true };
    expect(redact(input)).toEqual(input);
  });

  it('serialises errors instead of dropping them to an empty object', () => {
    const error = new Error('failed to connect to postgresql://u:pw@db:5432/x');
    const result = redact(error) as Record<string, unknown>;

    expect(result.name).toBe('Error');
    expect(result.message).toContain(REDACTED);
    expect(result.message).not.toContain('pw@');
    expect(typeof result.stack).toBe('string');
  });

  it('follows the error cause chain', () => {
    const root = new Error('password=supersecret123456');
    const wrapper = new Error('booking failed', { cause: root });
    const result = redact(wrapper) as Record<string, unknown>;
    const cause = result.cause as Record<string, unknown>;

    expect(cause.name).toBe('Error');
    expect(cause.message).toBe('password=supersecret123456');
  });

  it('survives a circular reference rather than throwing', () => {
    // A logger that crashes on a self-referencing object turns a diagnostic
    // into an outage.
    const node: Record<string, unknown> = { name: 'a' };
    node.self = node;

    expect(() => redact(node)).not.toThrow();
    expect(redact(node)).toEqual({ name: 'a', self: '[circular]' });
  });

  it('passes primitives through untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
    expect(redact(true)).toBe(true);
  });

  describe('the internal trigger header (ADR 0048, slice 4.7b)', () => {
    const SECRET = 'example-shared-secret-that-must-never-be-logged';

    it('redacts it as a key', () => {
      // It normalises to `xinternaltrigger` and matches none of the credential words,
      // so it is in the list by name. Without that entry this prints in full.
      expect(redact({ 'x-internal-trigger': SECRET })).toEqual({
        'x-internal-trigger': '[redacted]',
      });
    });

    it('redacts it inside an error cause, which is the path that matters', () => {
      /*
       * **This is the assertion the worker's handler relies on.** The header travels
       * in an outbound `fetch`, a rejection can carry that request on `cause`,
       * `redact` recurses into `cause`, and the worker's `failed` handler logs the
       * whole error. So this is the last thing between a refused connection and the
       * secret sitting in Loki for fourteen days.
       */
      const underlying = new TypeError('fetch failed');
      (underlying as { cause?: unknown }).cause = {
        headers: { 'x-internal-trigger': SECRET },
      };
      const thrown = new Error('expiry trigger failed to reach the API', {
        cause: underlying,
      });

      expect(JSON.stringify(redact(thrown))).not.toContain(SECRET);
    });
  });
});
