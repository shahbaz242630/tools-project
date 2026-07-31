import { describe, expect, it } from 'vitest';
import { clientIpFrom } from './client-ip';

describe('clientIpFrom', () => {
  it('takes the address our own proxy appended, not the one the client claimed', () => {
    // The mistake this function exists to avoid. A client may send its own
    // X-Forwarded-For and the proxy appends to it, so the *first* entry is
    // whatever the caller chose to write — and logging that as evidence means
    // an attacker picks what the audit trail says about them.
    expect(clientIpFrom('198.51.100.9, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('reads a single address', () => {
    expect(clientIpFrom('203.0.113.7')).toBe('203.0.113.7');
  });

  it('tolerates the spacing proxies actually use', () => {
    expect(clientIpFrom('198.51.100.9,203.0.113.7')).toBe('203.0.113.7');
    expect(clientIpFrom('  198.51.100.9 ,  203.0.113.7  ')).toBe('203.0.113.7');
  });

  it('strips a port from an IPv4 address', () => {
    // Legal in this header, and not something the API's `inet` column accepts.
    expect(clientIpFrom('203.0.113.7:54321')).toBe('203.0.113.7');
  });

  it('keeps a bare IPv6 address intact', () => {
    // Colons are part of the address here, so naive port-splitting would
    // truncate it into something that is still shaped like an address.
    expect(clientIpFrom('2001:db8::1')).toBe('2001:db8::1');
  });

  it('strips a port from a bracketed IPv6 address', () => {
    expect(clientIpFrom('[2001:db8::1]:443')).toBe('2001:db8::1');
  });

  it('keeps a bracketed IPv6 address with no port', () => {
    expect(clientIpFrom('[2001:db8::1]')).toBe('2001:db8::1');
  });

  it.each([
    ['no header', null],
    ['undefined', undefined],
    ['empty', ''],
    ['only separators', ', ,'],
    ['only whitespace', '   '],
  ])('returns null for %s', (_label, value) => {
    // Local development has no proxy, so this is the normal case rather than a
    // failure. Guessing an address would put a fabrication in a security log.
    expect(clientIpFrom(value)).toBeNull();
  });

  it('returns null for a non-string', () => {
    expect(clientIpFrom(undefined)).toBeNull();
  });
});
