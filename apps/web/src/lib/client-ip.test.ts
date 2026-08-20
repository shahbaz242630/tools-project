import { describe, expect, it } from 'vitest';
import { clientIpFrom } from './client-ip';

/**
 * The topology each case describes, stated rather than defaulted.
 *
 * Every test below was written when this function trusted the last entry
 * unconditionally. They still describe the deployment §10.2 is aiming at —
 * browser → Caddy → web — so they now say so explicitly, and the cases where
 * *nothing* is in front get their own block at the bottom.
 */
const ONE_PROXY = 1;

describe('clientIpFrom', () => {
  it('takes the address our own proxy appended, not the one the client claimed', () => {
    // The mistake this function exists to avoid. A client may send its own
    // X-Forwarded-For and the proxy appends to it, so the *first* entry is
    // whatever the caller chose to write — and logging that as evidence means
    // an attacker picks what the audit trail says about them.
    expect(clientIpFrom('198.51.100.9, 203.0.113.7', ONE_PROXY)).toBe('203.0.113.7');
  });

  it('reads a single address', () => {
    expect(clientIpFrom('203.0.113.7', ONE_PROXY)).toBe('203.0.113.7');
  });

  it('tolerates the spacing proxies actually use', () => {
    expect(clientIpFrom('198.51.100.9,203.0.113.7', ONE_PROXY)).toBe('203.0.113.7');
    expect(clientIpFrom('  198.51.100.9 ,  203.0.113.7  ', ONE_PROXY)).toBe(
      '203.0.113.7',
    );
  });

  it('strips a port from an IPv4 address', () => {
    // Legal in this header, and not something the API's `inet` column accepts.
    expect(clientIpFrom('203.0.113.7:54321', ONE_PROXY)).toBe('203.0.113.7');
  });

  it('keeps a bare IPv6 address intact', () => {
    // Colons are part of the address here, so naive port-splitting would
    // truncate it into something that is still shaped like an address.
    expect(clientIpFrom('2001:db8::1', ONE_PROXY)).toBe('2001:db8::1');
  });

  it('strips a port from a bracketed IPv6 address', () => {
    expect(clientIpFrom('[2001:db8::1]:443', ONE_PROXY)).toBe('2001:db8::1');
  });

  it('keeps a bracketed IPv6 address with no port', () => {
    expect(clientIpFrom('[2001:db8::1]', ONE_PROXY)).toBe('2001:db8::1');
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
    expect(clientIpFrom(value, ONE_PROXY)).toBeNull();
  });

  it('returns null for a non-string', () => {
    expect(clientIpFrom(undefined, ONE_PROXY)).toBeNull();
  });

  /**
   * **The security boundary, and the reason this parameter exists.**
   *
   * `infra/compose`'s Caddy ingress has never run — it is deliberately down
   * until a domain exists (§10.2). So the real deployment today has *nothing*
   * in front, and every entry in the header is one the caller typed.
   */
  describe('when nothing we control is in front', () => {
    it('refuses to name an address, however plausible the header looks', () => {
      // The whole defect in one line: before this, the answer was 203.0.113.7 —
      // a value the caller chose, written to `audit_logs.ipAddress` as evidence.
      expect(clientIpFrom('198.51.100.9, 203.0.113.7', 0)).toBeNull();
      expect(clientIpFrom('203.0.113.7', 0)).toBeNull();
    });

    it('cannot be talked into an address by sending more entries', () => {
      // A caller who knows the shape cannot get back in by padding the list.
      expect(clientIpFrom('a, b, c, d, e, 203.0.113.7', 0)).toBeNull();
    });
  });

  describe('when two proxies are in front', () => {
    it('takes the entry the outermost one appended, not the innermost', () => {
      /*
       * The Cloudflare Tunnel §10.2 requires makes this the real topology:
       * client → Cloudflare → Caddy → web. Cloudflare appends the client, Caddy
       * appends Cloudflare. Taking the last entry would record *Cloudflare's*
       * address for every request on the platform — the failure ADR 0017
       * predicted and said would not fail loudly.
       */
      expect(clientIpFrom('198.51.100.9, 203.0.113.7, 192.0.2.1', 2)).toBe(
        '203.0.113.7',
      );
    });

    it('returns null when a hop we expected did not append', () => {
      /*
       * Somebody reaching the app past the ingress. `hops.at(-1)` would wrap to
       * the end of the list and hand back a caller-supplied entry as though a
       * proxy had vouched for it — the same bug as trusting the first entry,
       * arriving through the back door.
       */
      expect(clientIpFrom('203.0.113.7', 2)).toBeNull();
    });
  });
});
