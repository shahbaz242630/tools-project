import { describe, expect, it } from 'vitest';
import { ContractViolationError } from './parse.js';
import {
  DISPLAY_NAME_MAX_LENGTH,
  parseMyProfileResponse,
  parseProfileInput,
  parsePublicProfile,
  publicProfileSchema,
  publicProfilePath,
} from './profiles.js';

const validInput = {
  displayName: 'Sarah M.',
  phone: '07700 900123',
  address: {
    line1: '12 Acacia Avenue',
    line2: null,
    town: 'Bristol',
    postcode: 'bs7 8aa',
  },
};

describe('parseProfileInput', () => {
  it('accepts a complete profile and normalises what it stores', () => {
    // Normalising at the contract boundary means every layer below sees one
    // representation, rather than each remembering to fold the input first.
    expect(parseProfileInput(validInput)).toEqual({
      displayName: 'Sarah M.',
      phone: '+447700900123',
      address: {
        line1: '12 Acacia Avenue',
        line2: null,
        town: 'Bristol',
        postcode: 'BS7 8AA',
      },
      // Absent in, null out — the `.default(null)` on the input schema. Null
      // means "has not answered", which the publication gate refuses on, so a
      // profile saved without touching the question stays unable to publish
      // rather than being quietly declared private (slice 2.13).
      ownerStatus: null,
    });
  });

  it('accepts a name alone', () => {
    // BRD §8.1 wants contact details before listing or booking, not before
    // having an account. Demanding them here blocks somebody browsing.
    expect(parseProfileInput({ displayName: 'Sarah M.' })).toEqual({
      displayName: 'Sarah M.',
      phone: null,
      address: null,
      ownerStatus: null,
    });
  });

  it('trims the display name before measuring it', () => {
    expect(parseProfileInput({ displayName: '  Sarah M.  ' }).displayName).toBe(
      'Sarah M.',
    );
  });

  it.each([
    ['empty', ''],
    ['one character', 'a'],
    ['whitespace padded to look long enough', '  a  '],
    ['longer than the limit', 'a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1)],
  ])('rejects a display name that is %s', (_label, displayName) => {
    expect(() => parseProfileInput({ displayName })).toThrow(ContractViolationError);
  });

  it('rejects a right-to-left override in a display name', () => {
    // U+202E reverses the rendering of everything after it, which is how a
    // display name is made to read as something it is not. Length and
    // emptiness checks pass straight over it.
    expect(() => parseProfileInput({ displayName: 'Sarah‮M.' })).toThrow(
      ContractViolationError,
    );
  });

  it('rejects a newline in a display name', () => {
    expect(() => parseProfileInput({ displayName: 'Sarah\nM.' })).toThrow(
      ContractViolationError,
    );
  });

  it('accepts a name that is not ASCII', () => {
    // Real names are not ASCII. A validator that assumes they are excludes
    // people rather than attackers.
    expect(parseProfileInput({ displayName: 'Siân Ó Faoláin' }).displayName).toBe(
      'Siân Ó Faoláin',
    );
    expect(parseProfileInput({ displayName: '陈伟' }).displayName).toBe('陈伟');
  });

  it.each([
    ['a non-UK number', '+1 555 0100'],
    ['free text', 'call me'],
    ['too short', '0770090'],
  ])('rejects %s as a phone number', (_label, phone) => {
    expect(() => parseProfileInput({ ...validInput, phone })).toThrow(
      ContractViolationError,
    );
  });

  it('rejects an invalid postcode', () => {
    expect(() =>
      parseProfileInput({
        ...validInput,
        address: { ...validInput.address, postcode: '90210' },
      }),
    ).toThrow(ContractViolationError);
  });

  it('rejects an address with no street line', () => {
    // All-or-nothing. A postcode with no street line is not an address, and a
    // street line with no postcode cannot be geocoded.
    expect(() =>
      parseProfileInput({
        ...validInput,
        address: { ...validInput.address, line1: '   ' },
      }),
    ).toThrow(ContractViolationError);
  });

  it('reports every problem at once, naming each field', () => {
    // A form showing one error, then another on resubmission, is a form people
    // abandon.
    try {
      parseProfileInput({ displayName: 'x', phone: 'nope', address: null });
      expect.unreachable('should have thrown');
    } catch (error) {
      const { issues } = error as ContractViolationError;
      expect(issues.join('\n')).toContain('displayName');
      expect(issues.join('\n')).toContain('phone');
    }
  });
});

describe('publicProfileSchema', () => {
  const publicProfile = {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    displayName: 'Sarah M.',
    outwardCode: 'BS7',
    town: 'Bristol',
    memberSince: '2026-07',
  };

  it('accepts the public shape', () => {
    expect(parsePublicProfile(publicProfile)).toEqual(publicProfile);
  });

  it('allows a profile with no address yet', () => {
    expect(
      parsePublicProfile({ ...publicProfile, outwardCode: null, town: null }),
    ).toMatchObject({ outwardCode: null });
  });

  it.each(['2026-13', '2026', '2026-7', '2026-07-15', 'July 2026'])(
    'rejects %s as memberSince',
    (memberSince) => {
      expect(() => parsePublicProfile({ ...publicProfile, memberSince })).toThrow(
        ContractViolationError,
      );
    },
  );

  it('carries no contact field, and strips one that arrives anyway', () => {
    // The security property of this module, asserted rather than assumed. Zod
    // strips unknown keys by default — so even an API that mistakenly serialised
    // a phone number cannot deliver it through this parser to a page.
    const parsed = parsePublicProfile({
      ...publicProfile,
      phone: '+447700900123',
      email: 'sarah@example.com',
      postcode: 'BS7 8AA',
      line1: '12 Acacia Avenue',
    }) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual([
      'displayName',
      'id',
      'memberSince',
      'outwardCode',
      'town',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('900123');
    expect(JSON.stringify(parsed)).not.toContain('Acacia');
    expect(JSON.stringify(parsed)).not.toContain('8AA');
  });

  it('has no field the private shape would call contact data', () => {
    // A guard against the slow version of this mistake: someone adds a field
    // to the public schema because a page needed it, and nobody reviewing the
    // diff connects it to disclosure.
    const shape = Object.keys(publicProfileSchema.shape);
    for (const forbidden of ['phone', 'email', 'postcode', 'line1', 'line2']) {
      expect(shape).not.toContain(forbidden);
    }
  });
});

describe('parseMyProfileResponse', () => {
  it('accepts a profile that has not been created yet', () => {
    // Distinct from a 404, which would mean the route is missing — a deploy
    // problem, not a normal state a form can render for.
    expect(parseMyProfileResponse({ profile: null })).toEqual({ profile: null });
  });

  it('accepts a full profile', () => {
    const profile = {
      displayName: 'Sarah M.',
      phone: '+447700900123',
      address: {
        line1: '12 Acacia Avenue',
        line2: null,
        town: 'Bristol',
        postcode: 'BS7 8AA',
      },
      // **Required on the response, unlike on the input**, and the asymmetry is
      // the same one `moderationState` draws on `OwnerListing`: an older API
      // served to a newer web app must surface as malformed rather than as a
      // page confidently telling a renter this is a private individual because
      // the field defaulted. Absent here is a contract violation.
      ownerStatus: null,
      updatedAt: '2026-07-31T09:00:00.000Z',
    };
    expect(parseMyProfileResponse({ profile })).toEqual({ profile });
  });

  it('rejects a response missing the wrapper', () => {
    expect(() => parseMyProfileResponse({ displayName: 'Sarah M.' })).toThrow(
      ContractViolationError,
    );
  });
});

describe('publicProfilePath', () => {
  it('builds the path from an id', () => {
    expect(publicProfilePath('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(
      '/users/3f2504e0-4f89-41d3-9a0c-0305e82c3301/profile',
    );
  });

  it('encodes an id that would otherwise change the path', () => {
    // The id reaching here is normally a UUID, but a caller passing user input
    // straight through should not be able to reach a different route.
    expect(publicProfilePath('../../me')).toBe('/users/..%2F..%2Fme/profile');
  });
});
