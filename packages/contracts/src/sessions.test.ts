import { describe, expect, it } from 'vitest';
import { ContractViolationError } from './parse.js';
import { describeSignInOrigin, parseSignInsResponse } from './sessions.js';
import type { SignInEntry } from './sessions.js';

const ENTRY: SignInEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  event: 'started',
  sessionId: 'sess_3HDhyL6953Z755UaiBQzqU9maQA',
  occurredAt: '2026-07-30T10:53:19.422Z',
  ipAddress: '2001:8f8:1761:2d72:c5e0:8d1a:4d4f:568e',
  browserName: 'Edge',
  browserVersion: '150.0.0.0',
  deviceType: 'Windows',
  isMobile: false,
};

describe('parseSignInsResponse', () => {
  it('accepts a full entry', () => {
    expect(parseSignInsResponse({ entries: [ENTRY] })).toEqual({ entries: [ENTRY] });
  });

  it('accepts an entry with nothing but the event and its time', () => {
    // A delivery can arrive with no request attributes and a user agent can
    // fail to parse, so this is a normal outcome rather than a degraded one.
    const bare: SignInEntry = {
      ...ENTRY,
      ipAddress: null,
      browserName: null,
      browserVersion: null,
      deviceType: null,
      isMobile: null,
    };

    expect(parseSignInsResponse({ entries: [bare] }).entries[0]).toEqual(bare);
  });

  it.each([['started'], ['ended'], ['removed'], ['revoked']])(
    'accepts the %s event',
    (event) => {
      expect(
        parseSignInsResponse({ entries: [{ ...ENTRY, event }] }).entries[0]?.event,
      ).toBe(event);
    },
  );

  it('refuses an event outside the four', () => {
    // A closed set on the wire, so an unrecognised value is a parse failure
    // rather than a blank line in a security list.
    expect(() =>
      parseSignInsResponse({ entries: [{ ...ENTRY, event: 'banana' }] }),
    ).toThrow(ContractViolationError);
  });

  it('refuses a missing field rather than defaulting it', () => {
    // Built by deletion rather than destructuring: the lint rule's ignore
    // pattern covers arguments, not variables, so a discarded `_dropped` binding
    // is still an error.
    const incomplete: Record<string, unknown> = { ...ENTRY };
    delete incomplete['ipAddress'];

    expect(() => parseSignInsResponse({ entries: [incomplete] })).toThrow(
      ContractViolationError,
    );
  });

  it('accepts an empty list', () => {
    expect(parseSignInsResponse({ entries: [] })).toEqual({ entries: [] });
  });
});

describe('describeSignInOrigin', () => {
  it('reads as prose when the browser and device are known', () => {
    expect(describeSignInOrigin(ENTRY)).toBe('Edge on Windows');
  });

  it('gives the browser alone when the device is unknown', () => {
    expect(describeSignInOrigin({ ...ENTRY, deviceType: null })).toBe('Edge');
  });

  it('gives the device alone when the browser is unknown', () => {
    expect(describeSignInOrigin({ ...ENTRY, browserName: null })).toBe('Windows');
  });

  it('says so rather than returning an empty string', () => {
    // An empty cell reads like a loading state, which is the one thing a
    // security page must not look like.
    expect(
      describeSignInOrigin({ ...ENTRY, browserName: null, deviceType: null }),
    ).toBe('Device not recorded');
  });

  it('says nothing about a city, because a webhook carries none', () => {
    // Clerk resolves a city only on its Backend API, behind the secret key
    // ADR 0015 withholds from us. Pinned so nobody reintroduces a field the
    // data cannot fill (ADR 0025).
    expect(describeSignInOrigin(ENTRY)).not.toMatch(/Dubai|United Arab Emirates/);
  });
});
