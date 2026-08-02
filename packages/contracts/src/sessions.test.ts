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
  city: 'Dubai',
  country: 'United Arab Emirates',
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
    // Clerk's `latest_activity` is optional and so is every field within it, so
    // this is a normal delivery rather than a degraded one.
    const bare: SignInEntry = {
      ...ENTRY,
      ipAddress: null,
      city: null,
      country: null,
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
  it('reads as prose when everything is present', () => {
    expect(describeSignInOrigin(ENTRY)).toBe(
      'Edge on Windows — Dubai, United Arab Emirates',
    );
  });

  it('drops the place when it is unknown', () => {
    expect(describeSignInOrigin({ ...ENTRY, city: null, country: null })).toBe(
      'Edge on Windows',
    );
  });

  it('drops the device when it is unknown', () => {
    expect(
      describeSignInOrigin({ ...ENTRY, browserName: null, deviceType: null }),
    ).toBe('Dubai, United Arab Emirates');
  });

  it('copes with a country but no city', () => {
    expect(
      describeSignInOrigin({
        ...ENTRY,
        city: null,
        browserName: null,
        deviceType: null,
      }),
    ).toBe('United Arab Emirates');
  });

  it('says so rather than returning an empty string', () => {
    // An empty cell reads like a loading state, which is the one thing a
    // security page must not look like.
    expect(
      describeSignInOrigin({
        ...ENTRY,
        city: null,
        country: null,
        browserName: null,
        deviceType: null,
      }),
    ).toBe('Device and location not recorded');
  });
});
