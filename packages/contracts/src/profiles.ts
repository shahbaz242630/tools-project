/**
 * The profile contract between the API and the web app.
 *
 * Two response shapes, and the difference between them is the entire security
 * property of this module (ADR 0016):
 *
 *   `myProfileResponseSchema`   what you may see about yourself — name, phone,
 *                               full address
 *   `publicProfileSchema`       what a stranger may see about you — name, and a
 *                               postal district
 *
 * They are separate types rather than one type with optional fields, and that
 * is deliberate. An optional `phone?: string` compiles perfectly whether or not
 * the API remembered to strip it, so the check would live only in a controller
 * someone could edit. Two shapes make over-disclosure a type error at the point
 * of construction.
 *
 * Validated at runtime for the reason set out in `health.ts`: the services
 * deploy independently, so one is always briefly talking to the other's
 * previous version.
 */

import { Phone } from '@platform/core';
import { z } from 'zod';
import { postalAddressSchema } from './address.js';
import { parseWith } from './parse.js';

/** Where the API serves the caller's own profile. */
export const ME_PROFILE_PATH = '/me/profile';

/**
 * Where the API serves anyone's public profile.
 *
 * A function rather than a template someone spells at the call site, so the
 * shape stays in one place — and so the *public* path is visibly distinct from
 * the private one at every use.
 */
export function publicProfilePath(userId: string): string {
  return `/users/${encodeURIComponent(userId)}/profile`;
}

/** The Nest route pattern for the above. Kept beside it so the two cannot drift. */
export const PUBLIC_PROFILE_ROUTE = '/users/:userId/profile';

export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 50;

/**
 * A name other people will see.
 *
 * Trimmed before length is measured, so `"  a  "` is a two-character name
 * rather than a six-character one.
 *
 * Control and format characters are rejected — `\p{Cc}` and `\p{Cf}`. Not
 * fussiness: U+202E RIGHT-TO-LEFT OVERRIDE reverses the rendering of everything
 * after it, which is how a display name is made to read as something it is not,
 * and a newline in a name breaks every list it appears in. Letters, marks and
 * punctuation from any script are welcome; real names are not ASCII.
 */
const displayName = z
  .string()
  .trim()
  .min(
    DISPLAY_NAME_MIN_LENGTH,
    `must be at least ${DISPLAY_NAME_MIN_LENGTH} characters`,
  )
  .max(DISPLAY_NAME_MAX_LENGTH, `must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`)
  .refine(
    (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
    'must not contain control or direction-changing characters',
  );

/**
 * A UK phone number, normalised to E.164 on the way in.
 *
 * Normalising here rather than in the service means every layer below sees one
 * representation. Unverified — nothing has proved the number belongs to the
 * person typing it — so it must not be read as a trust signal.
 */
const phone = z
  .string()
  .trim()
  .refine(Phone.isValid, 'must be a UK phone number')
  .transform(Phone.parse);

/**
 * An address as the owner supplies it — the shared shape, not a second one.
 *
 * Defined in `address.ts` from slice 2.5a, when a listing acquired a collection
 * address and the platform needed the two to agree about what an address is.
 * Aliased here rather than re-declared so this module keeps its own vocabulary
 * at the point of use while there is only ever one definition.
 */
export const addressInputSchema = postalAddressSchema;
export type AddressInput = z.infer<typeof addressInputSchema>;

/**
 * What a person may save about themselves.
 *
 * `displayName` is required because the row does not exist until there is one.
 * `phone` and `address` are nullable because BRD §8.1 requires contact details
 * before *listing or booking*, not before having an account — demanding them at
 * sign-up would block somebody who only wants to look around.
 */
export const profileInputSchema = z.object({
  displayName,
  phone: phone.nullable().default(null),
  address: addressInputSchema.nullable().default(null),
});
export type ProfileInput = z.infer<typeof profileInputSchema>;

/** The caller's own profile, in full. Never sent to anyone else. */
export const myProfileSchema = z.object({
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
});
export type MyProfile = z.infer<typeof myProfileSchema>;

/**
 * `null` until the first save.
 *
 * Wrapped in an object rather than answering 404, so "you have not made a
 * profile yet" is a normal state the page can render a form for, distinct from
 * "that route does not exist", which is a deploy problem.
 */
export const myProfileResponseSchema = z.object({
  profile: myProfileSchema.nullable(),
});
export type MyProfileResponse = z.infer<typeof myProfileResponseSchema>;

/**
 * What anybody may see. **Every field here is world-readable — assume it is
 * indexed by a search engine and scraped the day it ships.**
 *
 * No phone, no email, no street lines, no full postcode. Adding a field to this
 * object is a decision to publish it to the entire internet; adding one because
 * it was convenient for a page layout is how drip disclosure happens.
 */
export const publicProfileSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),

  /**
   * The postal district only — `BS7`, never `BS7 8AA`.
   *
   * A full postcode averages about fifteen households and is often one
   * building; beside a name that is close enough to an address to find someone
   * on the electoral roll. The district covers thousands and still answers the
   * only question a renter is asking: roughly how far away is this.
   */
  outwardCode: z.string().nullable(),

  /** Post town. Coarse enough to publish, and it makes the district legible. */
  town: z.string().nullable(),

  /**
   * Month precision — `2026-07`.
   *
   * An exact signup timestamp is a correlation handle for linking accounts
   * across services, and "member since July 2026" is the whole of what a
   * renter is judging. Same reasoning as the outward code: publish the bucket,
   * not the point.
   */
  memberSince: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM'),
});
export type PublicProfile = z.infer<typeof publicProfileSchema>;

export function parseMyProfileResponse(raw: unknown): MyProfileResponse {
  return parseWith(myProfileResponseSchema, 'The profile response', raw);
}

export function parsePublicProfile(raw: unknown): PublicProfile {
  return parseWith(publicProfileSchema, 'The public profile response', raw);
}

/** Validate a profile submission, reporting every problem rather than the first. */
export function parseProfileInput(raw: unknown): ProfileInput {
  return parseWith(profileInputSchema, 'The profile', raw);
}
