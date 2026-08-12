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
 *
 * **That rule is about old readers meeting new files.** The reverse direction
 * is what this constant is actually for, and it does need a bump: a *required*
 * field added here means yesterday's file no longer parses, and the useful
 * failure is "this is a version 1 document" rather than "signIns is missing",
 * which reads like corruption. Version 2 added `signIns` and
 * `signInsTruncated` in slice 1.11a; version 3 added `listings` in 2.5a, when
 * Catalogue became the second module holding personal data; version 4 added
 * `listingsTruncated` in H2, when the listings read stopped being unbounded.
 */
export const EXPORT_SCHEMA_VERSION = 5;

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
 * What happened around this person: what they did, **and what was done to
 * them**.
 *
 * **The second half arrived in schema 5, and its absence was the defect.**
 * Through schema 4 this section was assembled from the actor side of the audit
 * trail alone, so an administrator reading somebody's account showed up on their
 * activity page and was missing from the copy of their data they downloaded. The
 * export is the artefact §10.1 makes a legal answer, so it was the wrong one of
 * the two to be incomplete.
 *
 * **One list with an author rather than two sections.** Sign-ins are a section
 * of their own because they carry a device and a place that no activity entry
 * has; a disclosure carries exactly the same fields as an own action and differs
 * only in who performed it. That is an attribute, not a kind — and two sections
 * would have made the reader correlate them by timestamp to see their own story
 * in order.
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
    /**
     * Who did it: the person themselves, an administrator, or the platform.
     *
     * The field that makes the rest of the row legible. *"Your account was
     * read"* means something quite different depending on the answer, and
     * without it a subject cannot tell their own actions from ours.
     */
    by: z.enum(['subject', 'administrator', 'system']),
    /**
     * Why, in the administrator's own words — null for anything the person did
     * themselves, which owes no explanation.
     *
     * ADR 0024's rule, now in the export as well as on the screen: a person
     * reads the reason for a decision made about them, verbatim. It is the most
     * meaningful thing a disclosure carries and the export omitted it entirely
     * until schema 5.
     */
    reason: z.string().nullable(),
    /**
     * **Always null unless `by` is `subject`.** On somebody else's action the
     * address belongs to the administrator who acted, and it is not the
     * subject's to see — the same withholding the activity page performs, and
     * the type that enforces it is `ActivityRecord`.
     */
    ipAddress: z.string().nullable(),
    createdAt: z.iso.datetime(),
  }),
);

/**
 * Sign-ins and sign-outs — BRD §8.1's authentication events.
 *
 * A section of its own rather than more `activity` rows, because the two are
 * different kinds of record: an activity entry is something the person chose to
 * do, a sign-in is something that happened to their account, and only the
 * latter carries a device and an address. Flattening them would lose that
 * distinction in the one document a person is most likely to read years later.
 *
 * Unlike the audit trail's digests, **these are real values and that is the
 * point** — nobody recognises an intruder from an HMAC. It also makes this the
 * second bulk disclosure the export performs, after the decrypted address, and
 * the reason the whole endpoint is audited (ADR 0019, ADR 0025).
 *
 * Every field but `event`, `sessionId` and `occurredAt` is nullable: a webhook
 * can arrive with no request attributes, and a user agent can fail to parse.
 * There is no city or country — Clerk resolves those only on its Backend API,
 * behind the secret key ADR 0015 withholds from us (ADR 0025).
 */
export const exportedSignInsSchema = z.array(
  z.object({
    /** `started`, `ended`, `removed` or `revoked`. */
    event: z.string(),
    /** Clerk's `sess_…`, so a line here can be matched to a device at Clerk. */
    sessionId: z.string(),
    occurredAt: z.iso.datetime(),
    ipAddress: z.string().nullable(),
    browserName: z.string().nullable(),
    browserVersion: z.string().nullable(),
    deviceType: z.string().nullable(),
    isMobile: z.boolean().nullable(),
  }),
);
export type ExportedSignIns = z.infer<typeof exportedSignInsSchema>;

/**
 * The listings this person has written, as Catalogue holds them — **with the
 * collection address decrypted**.
 *
 * A section of its own from slice 2.5a, and the reason it exists at all is that
 * a listing carries somebody's address. Until 2.5a the only personal data
 * outside Identity was a profile, and this document said so by omission; a
 * subject-access request answered from it would have missed the street the
 * person is standing on.
 *
 * **Not the whole listing.** The title and the id are here so the address has
 * something to belong to — an address in a file with no indication of which
 * listing it is for is a fact nobody can act on. Prices, photographs and
 * attribute values are content this person can read on the listing page itself
 * and are not what Article 15 is about; the moment any of them holds personal
 * data, they belong here too.
 *
 * The empty list is the answer for somebody with no listings. There is no null
 * variant beside it: "you have no listings" and "we hold no listing data about
 * you" are the same statement, and two ways to say it is how a reader ends up
 * treating them differently.
 */
export const exportedListingsSchema = z.array(
  z.object({
    id: z.uuid(),
    title: z.string(),
    createdAt: z.iso.datetime(),
    /**
     * Null for a draft that has not said where the item lives — which is a
     * legitimate state for a draft (§8.3), not a missing value.
     */
    collectionLocation: z
      .object({
        line1: z.string(),
        line2: z.string().nullable(),
        town: z.string(),
        postcode: z.string(),
      })
      .nullable(),
  }),
);
export type ExportedListings = z.infer<typeof exportedListingsSchema>;

/**
 * Catalogue's contribution to the document, as it hands it over.
 *
 * **A shape rather than a bare array, from slice H2**, because the listings read
 * is now bounded and the module that applied the bound is the only one that
 * knows whether it bit. Identity assembles the document but does not run the
 * query, so a bare array would leave it inferring truncation from a length —
 * which is precisely the guess `Paging.probe` exists to remove.
 *
 * Not a schema, because it never crosses the wire: it is the internal type of a
 * `PersonalDataSource` section. It lives here beside the document it feeds so
 * that the two move together, and so Identity does not have to import it from
 * Catalogue.
 */
export interface ExportedListingsSection {
  readonly listings: ExportedListings;
  readonly truncated: boolean;
}

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
  /**
   * Whether `activity` was cut short (schema 5).
   *
   * The third section to declare it, after sign-ins and listings, and it became
   * necessary when the section started carrying disclosures as well as own
   * actions — twice as much competing for one bound. H2's rule: an export that
   * truncates without saying so is one somebody reads as their whole record.
   */
  activityTruncated: z.boolean(),
  signIns: exportedSignInsSchema,
  listings: exportedListingsSchema,

  /**
   * Whether `signIns` was cut short.
   *
   * A truncated export that does not say so is one somebody reads as the whole
   * record — and the person most likely to hit the limit is the one with most
   * to review. Stating it is cheaper than pagination and honest about what
   * pagination would fix.
   */
  signInsTruncated: z.boolean(),

  /**
   * Whether `listings` was cut short.
   *
   * Added in slice H2, and it is the *reason* that slice could bound the
   * listings read at all. Until then the query had no `take` and returned every
   * listing an owner had ever written — correct for a subject-access response
   * and a memory problem at scale. A bare `take` would have replaced the memory
   * problem with a worse one: a silently partial answer to a UK GDPR Article 15
   * request, which §10.1 requires to be complete.
   *
   * So the read is bounded and the cut is declared, exactly as `signIns` is. The
   * bound is set far above any plausible number of listings, so this is false
   * for everybody until somebody is genuinely extraordinary — and for that
   * person it is the difference between a document that is wrong and one that is
   * short and says so.
   */
  listingsTruncated: z.boolean(),
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
