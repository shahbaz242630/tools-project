import { describe, expect, it } from 'vitest';
import { ContractViolationError } from './parse.js';
import { EXPORT_SCHEMA_VERSION, exportFilename, parseDataExport } from './export.js';

const DOCUMENT = {
  schemaVersion: EXPORT_SCHEMA_VERSION,
  exportedAt: '2026-07-31T09:00:00.000Z',
  account: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'alice@example.com',
    role: 'USER',
    createdAt: '2026-07-15T09:00:00.000Z',
    deletedAt: null,
    deletionRequestedAt: null,
  },
  profile: null,
  activity: [],
  activityTruncated: false,
  signIns: [],
  signInsTruncated: false,
  listingsTruncated: false,
  // Booking's section, from schema 6 (slice 4.8d). Three arrays under one key,
  // because they are three answers to one question.
  bookings: { hires: [], lettings: [], quotes: [] },
  bookingsTruncated: false,
  // The empty list is this section's "holds nothing" — there is no null
  // variant beside it, deliberately (slice 2.5a).
  listings: [],
};

describe('parseDataExport', () => {
  it('accepts a minimal document', () => {
    expect(parseDataExport(DOCUMENT)).toEqual(DOCUMENT);
  });

  it('accepts a document with a decrypted address', () => {
    const withProfile = {
      ...DOCUMENT,
      profile: {
        displayName: 'Sarah M.',
        phone: '+447700900123',
        address: {
          line1: '12 Acacia Avenue',
          line2: null,
          town: 'Bristol',
          postcode: 'BS7 8AA',
        },
        updatedAt: '2026-07-31T09:00:00.000Z',
      },
    };
    expect(parseDataExport(withProfile).profile?.address?.line1).toBe(
      '12 Acacia Avenue',
    );
  });

  it('rejects a document from a future schema version', () => {
    // A person may keep this file for years. Refusing a version this code does
    // not understand beats rendering it as though it did.
    expect(() => parseDataExport({ ...DOCUMENT, schemaVersion: 99 })).toThrow(
      ContractViolationError,
    );
  });

  it('rejects a document with no version at all', () => {
    const withoutVersion: Record<string, unknown> = { ...DOCUMENT };
    delete withoutVersion['schemaVersion'];

    expect(() => parseDataExport(withoutVersion)).toThrow(ContractViolationError);
  });

  it('requires an export timestamp', () => {
    expect(() => parseDataExport({ ...DOCUMENT, exportedAt: 'yesterday' })).toThrow(
      ContractViolationError,
    );
  });
});

describe('exportFilename', () => {
  it('dates the file, so two exports do not collide', () => {
    expect(exportFilename('2026-07-31T09:00:00.000Z')).toBe(
      'account-data-2026-07-31.json',
    );
  });

  it('uses the date only, not the time', () => {
    const name = exportFilename('2026-07-31T23:59:59.999Z');
    expect(name).not.toContain(':');
    expect(name).toBe('account-data-2026-07-31.json');
  });
});

describe('the booking section (schema 6, slice 4.8d)', () => {
  const A_HIRE = {
    id: 'booking-1',
    state: 'ACCEPTED',
    startDate: '2026-08-21',
    endDate: '2026-08-23',
    itemTitle: 'Petrol hedge trimmer',
    categoryName: 'Outdoor and gardening',
    total: { amount: 5_832, currency: 'GBP' },
    collectionPostcode: 'BS7 8AA',
    createdAt: '2026-08-20T09:00:00.000Z',
  };

  const A_LETTING = {
    id: 'booking-2',
    listingId: '11111111-1111-4111-8111-111111111111',
    state: 'ACCEPTED',
    startDate: '2026-08-21',
    endDate: '2026-08-23',
    itemTitle: 'SDS+ rotary hammer drill',
    itemCharge: { amount: 5_400, currency: 'GBP' },
    createdAt: '2026-08-20T09:00:00.000Z',
  };

  it('accepts the three arrays', () => {
    expect(() =>
      parseDataExport({
        ...DOCUMENT,
        bookings: { hires: [A_HIRE], lettings: [A_LETTING], quotes: [] },
      }),
    ).not.toThrow();
  });

  it('requires the section, so an old file fails as an old file', () => {
    /*
     * A *required* field added means yesterday's document no longer parses, and
     * the useful failure is "this is a version 5 document" rather than "bookings
     * is missing", which reads like corruption. That is what the version bump is
     * for and why adding one without it would be the defect.
     */
    const withoutBookings: Record<string, unknown> = { ...DOCUMENT };
    delete withoutBookings['bookings'];

    expect(() => parseDataExport(withoutBookings)).toThrow();
  });

  it('carries a hire’s postcode, which is the datum the section exists for', () => {
    const parsed = parseDataExport({
      ...DOCUMENT,
      bookings: { hires: [A_HIRE], lettings: [], quotes: [] },
    });

    expect(parsed.bookings.hires[0]?.collectionPostcode).toBe('BS7 8AA');
  });

  it('gives a letting no postcode and no renter', () => {
    // The counterparty's address is not this person's data (§8.4.1).
    const parsed = parseDataExport({
      ...DOCUMENT,
      bookings: { hires: [], lettings: [A_LETTING], quotes: [] },
    });

    expect(parsed.bookings.lettings[0]).not.toHaveProperty('collectionPostcode');
    expect(parsed.bookings.lettings[0]).not.toHaveProperty('renterId');
  });

  it('says whether the section was cut short', () => {
    // H2's rule, for the fourth section to declare it.
    expect(
      parseDataExport({ ...DOCUMENT, bookingsTruncated: true }).bookingsTruncated,
    ).toBe(true);
  });
});
