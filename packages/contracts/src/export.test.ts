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
  signIns: [],
  signInsTruncated: false,
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
