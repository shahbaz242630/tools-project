/**
 * The data-export contract.
 *
 * UK GDPR Article 20 asks for a "structured, commonly used and machine-readable
 * format", and BRD §10 lists portability beside access and deletion. JSON is
 * the obvious reading of that, and it is what this document is.
 *
 * **This is the only place plaintext street lines leave the database.** They are
 * encrypted at rest (ADR 0016) and no other response carries them — the owner's
 * own profile view returns them too, but one field at a time and only to that
 * owner. An export is a bulk disclosure, which is why it is audited (ADR 0019).
 */

import { z } from 'zod';
import { parseWith } from './parse.js';

/** Where the API serves the caller's own export. */
export const ME_EXPORT_PATH = '/me/export';

/**
 * The document's own version, independent of the application's.
 *
 * A person may keep an export for years and open it long after the shape has
 * moved on; without this, an old file is indistinguishable from a malformed
 * one. Bumped when a field is removed or its meaning changes — adding a field
 * does not need it, because a reader that ignores unknown keys still works.
 */
export const EXPORT_SCHEMA_VERSION = 1;

/** The account itself, as Identity & Access holds it. */
export const exportedAccountSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.string(),
  createdAt: z.iso.datetime(),
  /** Present only for an account that has been deleted. */
  deletedAt: z.iso.datetime().nullable(),
  deletionRequestedAt: z.iso.datetime().nullable(),
});

/**
 * The profile, as Profiles & Trust holds it — **decrypted**.
 *
 * Null when the person never made one, which is different from an empty
 * profile and is worth the distinction in a file somebody may read years later.
 */
export const exportedProfileSchema = z
  .object({
    displayName: z.string(),
    phone: z.string().nullable(),
    address: z
      .object({
        line1: z.string(),
        line2: z.string().nullable(),
        town: z.string(),
        postcode: z.string(),
      })
      .nullable(),
    updatedAt: z.iso.datetime(),
  })
  .nullable();
export type ExportedProfile = z.infer<typeof exportedProfileSchema>;
export type ExportedAccount = z.infer<typeof exportedAccountSchema>;
export type ExportedActivity = z.infer<typeof exportedActivitySchema>;

/**
 * The person's own activity, as the audit trail holds it.
 *
 * Without the digests. They are keyed with a secret the reader does not have,
 * so they are meaningless to them — and Article 15 is about the personal data
 * we hold, not about our internal integrity checks. Including them would add
 * bytes nobody can use to a file that already carries an address.
 */
export const exportedActivitySchema = z.array(
  z.object({
    action: z.string(),
    targetType: z.string(),
    ipAddress: z.string().nullable(),
    createdAt: z.iso.datetime(),
  }),
);

/**
 * Everything the platform holds about one person.
 *
 * `retained` is not decoration: BRD §10.1 requires the deletion workflow to
 * explain what survives, and somebody comparing an export taken before a
 * deletion with what remains afterwards deserves the same explanation in the
 * file itself rather than only on a page they have since left.
 */
export const dataExportSchema = z.object({
  schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
  exportedAt: z.iso.datetime(),
  account: exportedAccountSchema,
  profile: exportedProfileSchema,
  activity: exportedActivitySchema,
});
export type DataExport = z.infer<typeof dataExportSchema>;

export function parseDataExport(raw: unknown): DataExport {
  return parseWith(dataExportSchema, 'The data export', raw);
}

/**
 * The filename a browser is told to save it as.
 *
 * Dated, so somebody taking two exports a year apart does not silently
 * overwrite the first. A function rather than a constant because the date is
 * the point.
 */
export function exportFilename(exportedAt: string): string {
  const day = exportedAt.slice(0, 10);
  return `account-data-${day}.json`;
}
