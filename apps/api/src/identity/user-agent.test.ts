import { describe, expect, it } from 'vitest';
import { UNKNOWN_USER_AGENT, parseUserAgent } from './user-agent.js';

/**
 * The user-agent parser.
 *
 * It exists because a session webhook carries a raw user agent where the
 * Backend API carries a parsed browser and device (ADR 0025's correction), and
 * BRD §10's minimisation says store the part with a purpose rather than the
 * fingerprint. The purpose is narrow: would a person recognise this as them.
 */
describe('parseUserAgent', () => {
  it('reads the real string Clerk sent us', () => {
    // Captured from a live delivery on 2 August 2026.
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
      ),
    ).toEqual({
      browserName: 'Edge',
      browserVersion: '150',
      deviceType: 'Windows',
      isMobile: false,
    });
  });

  it('does not call Edge "Chrome"', () => {
    // Edge reports `Chrome/… Edg/…`, so a table checked in the wrong order
    // labels every Edge user as Chrome. This is the assertion that pins the
    // ordering, and it fails the moment somebody sorts the list alphabetically.
    const edge = parseUserAgent(
      'Mozilla/5.0 (Windows NT 10.0) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
    );
    expect(edge.browserName).toBe('Edge');
  });

  it('does not call Chrome "Safari"', () => {
    // Chrome reports `Safari/537.36` too. Same trap, one row further down.
    const chrome = parseUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    );
    expect(chrome).toMatchObject({ browserName: 'Chrome', deviceType: 'macOS' });
  });

  it('recognises real Safari, which has no Chrome token', () => {
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
      ),
    ).toMatchObject({ browserName: 'Safari', browserVersion: '18' });
  });

  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
      'iPhone',
      true,
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
      'Android',
      true,
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'Windows',
      false,
    ],
  ])('reads %s as %s (mobile: %s)', (agent, deviceType, isMobile) => {
    expect(parseUserAgent(agent)).toMatchObject({ deviceType, isMobile });
  });

  it('prefers Android over Linux, which Android also reports', () => {
    // An Android string contains `Linux`, so the platform table has the same
    // ordering hazard the browser table does.
    expect(
      parseUserAgent('Mozilla/5.0 (Linux; Android 15) Chrome/150.0.0.0 Mobile'),
    ).toMatchObject({ deviceType: 'Android' });
  });

  it('returns null rather than false when it recognises nothing', () => {
    // "We could not tell" and "it was a desktop" are different claims, and only
    // one of them is honest about a string we failed to parse. `isMobile: false`
    // on an unparsed agent would read as a fact on a security page.
    expect(parseUserAgent('curl/8.4.0')).toEqual(UNKNOWN_USER_AGENT);
  });

  it('keeps a device it recognises even when the browser is unknown', () => {
    expect(parseUserAgent('SomeBot/1.0 (Windows NT 10.0; compatible)')).toMatchObject({
      browserName: null,
      deviceType: 'Windows',
      isMobile: false,
    });
  });

  it.each([[null], [undefined], [''], ['   ']])(
    'returns everything unknown for %s',
    (value) => {
      expect(parseUserAgent(value)).toEqual(UNKNOWN_USER_AGENT);
    },
  );

  it('keeps only the major version', () => {
    // The build numbers are fingerprinting detail with no recognition value.
    expect(parseUserAgent('Chrome/150.0.7204.169 Safari/537.36').browserVersion).toBe(
      '150',
    );
  });
});
