import { describe, expect, it } from 'vitest';
import { validIpOrNull } from './ip-address.js';

/**
 * The shared IP validation, tested where it lives.
 *
 * Both callers reach an `inet` column, and on both paths a malformed value
 * becomes an outage rather than a bad row — a 500 on every authenticated
 * request through the guard, or an endlessly retried delivery through the
 * webhook. That is why this is validated at all, and why it is one function.
 */
describe('validIpOrNull', () => {
  it.each([['203.0.113.7'], ['127.0.0.1'], ['255.255.255.255'], ['0.0.0.0']])(
    'accepts the IPv4 address %s',
    (value) => {
      expect(validIpOrNull(value)).toBe(value);
    },
  );

  it.each([
    ['2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e'],
    ['::1'],
    ['fe80::1'],
    ['2001:db8::'],
  ])('accepts the IPv6 address %s', (value) => {
    // Real values from Clerk are frequently IPv6, so a check written for dotted
    // quads would discard most genuine addresses.
    expect(validIpOrNull(value)).toBe(value);
  });

  it('trims surrounding whitespace', () => {
    expect(validIpOrNull('  203.0.113.7 ')).toBe('203.0.113.7');
  });

  it('rejects a comma-joined pair, the repeated-header case', () => {
    // Fastify joins a header sent twice into one string, which is past any
    // `typeof` check and straight into the column. This is the 1.5a bug.
    expect(validIpOrNull('203.0.113.7,198.51.100.4')).toBeNull();
  });

  it.each([
    ['999.999.999.999'],
    ['not an address'],
    ['203.0.113.7/32'],
    ['203.0.113'],
    [''],
    ['   '],
  ])('rejects %s', (value) => {
    expect(validIpOrNull(value)).toBeNull();
  });

  it.each([[null], [undefined], [42], [{}], [['203.0.113.7']]])(
    'rejects the non-string %s',
    (value) => {
      // Takes `unknown` because one caller hands it a header value, which
      // Fastify types as `string | string[] | undefined`.
      expect(validIpOrNull(value)).toBeNull();
    },
  );
});
