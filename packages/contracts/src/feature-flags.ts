/**
 * The feature-flag vocabulary (BRD §5, §9, §12; ADR 0036, slice H3a).
 *
 * **A closed set declared in code, not rows an administrator creates**, and the
 * reason is the same one ADR 0031 gives for transport requirements: a flag key
 * gates a code path, and code paths are code. A key somebody typed into a form
 * would gate nothing — a switch on an admin page that changes no behaviour,
 * which is a dead control with a database row behind it. Adding a flag is a line
 * here plus the `if` that reads it, reviewed together.
 *
 * The database stores **overrides** against these declarations. A key with no
 * row is not "off"; it is at its `defaultEnabled`.
 *
 * It lives in `@platform/contracts` rather than in the API because the web app
 * needs the same labels to render the admin page, and a second copy of a
 * vocabulary is how the two come to disagree about what a switch means.
 */

import { z } from 'zod';
import { parseWith } from './parse.js';

/** Where the API serves the administrative surface. */
export const ADMIN_FEATURE_FLAGS_ROUTE = '/admin/feature-flags';
export const ADMIN_FEATURE_FLAG_ROUTE = '/admin/feature-flags/:key';

export const adminFeatureFlagsPath = (): string => ADMIN_FEATURE_FLAGS_ROUTE;
export const adminFeatureFlagPath = (key: string): string =>
  `${ADMIN_FEATURE_FLAGS_ROUTE}/${encodeURIComponent(key)}`;

/**
 * What a flag declaration says about itself.
 *
 * `defaultEnabled` is the half that matters, and it is **per flag rather than a
 * single project-wide convention** because the safe direction differs. A kill
 * switch over working functionality defaults **on** — defaulting off would take
 * that functionality down every time the database hiccups, turning a blip into
 * an outage. A flag over an incomplete capability defaults **off**, because the
 * failure there is exposing something half-built.
 *
 * `gates` is prose for the administrator, and it is required for a reason worth
 * stating: somebody reaching for a kill switch during an incident is deciding
 * under pressure, and a list of bare keys is not something you can act on. It
 * says what *stops working* when the flag is off.
 */
export interface FeatureFlagDeclaration {
  readonly key: FeatureFlagKey;
  /** Short label for the admin list. */
  readonly label: string;
  /** What stops working when this is off. Written for somebody mid-incident. */
  readonly gates: string;
  readonly defaultEnabled: boolean;
}

/**
 * Every flag this build knows.
 *
 * Keep it short. A flag is a permanent branch in the code with two paths that
 * both have to keep working, so each one is a standing cost — §5 asks for flags
 * on "incomplete or high-risk capabilities", not on everything.
 */
export const FEATURE_FLAGS = [
  {
    key: 'listing.publication',
    label: 'Publishing listings',
    gates:
      'Owners publishing a listing. Turning this off leaves existing published ' +
      'listings exactly as they are and refuses new publications — the emergency ' +
      'stop for when something is going live that should not be.',
    // On, because it is a kill switch over functionality that works. Defaulting
    // off would mean a database outage silently stopped every owner publishing,
    // which is a worse failure than the one the switch exists to prevent.
    defaultEnabled: true,
  },
  {
    key: 'booking.payment',
    label: 'Paying for bookings',
    gates:
      'Renters paying for an accepted booking. It is OFF because there is no ' +
      'payment provider yet — slice 5.2e builds the Stripe adapter and needs a ' +
      'Stripe account. Turning it on before that adapter exists makes every ' +
      'payment attempt fail loudly rather than charging anybody. Nothing else in ' +
      'the product depends on it: a booking can still be requested, accepted, ' +
      'declined and expired with this off.',
    /*
     * **Off, and it is the other kind of flag from the one above.** That one is a
     * kill switch over functionality that works, so it defaults on. This one
     * covers a capability that is *incomplete* — the route, the transitions and
     * the ledger posting are all built and the provider is not — and the
     * declaration above says exactly what to do with those: default off, because
     * the failure is exposing something half-built.
     */
    defaultEnabled: false,
  },
] as const satisfies readonly FeatureFlagDeclarationShape[];

/** The shape `FEATURE_FLAGS` entries satisfy, before the key union exists. */
interface FeatureFlagDeclarationShape {
  readonly key: string;
  readonly label: string;
  readonly gates: string;
  readonly defaultEnabled: boolean;
}

/** Every declared key, as a union. Adding a flag widens it. */
export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]['key'];

export const FEATURE_FLAG_KEYS = FEATURE_FLAGS.map(
  (flag) => flag.key,
) as readonly FeatureFlagKey[];

/** Whether a string is a key this build declares. */
export function isFeatureFlagKey(value: unknown): value is FeatureFlagKey {
  return (
    typeof value === 'string' && FEATURE_FLAG_KEYS.includes(value as FeatureFlagKey)
  );
}

/** One declaration by key, or undefined for a key this build does not know. */
export function featureFlagDeclaration(
  key: string,
): FeatureFlagDeclaration | undefined {
  return FEATURE_FLAGS.find((flag) => flag.key === key);
}

/**
 * Where a flag's current value came from.
 *
 * Served to the administrator rather than inferred from the value, because
 * "on because nobody has touched it" and "on because somebody switched it on"
 * are different facts and only one of them has a person behind it. During an
 * incident that distinction is the first thing worth knowing.
 */
export const FEATURE_FLAG_SOURCES = ['default', 'override'] as const;
export type FeatureFlagSource = (typeof FEATURE_FLAG_SOURCES)[number];

/** One flag as the admin surface shows it. */
export const adminFeatureFlagSchema = z.object({
  key: z.string(),
  label: z.string(),
  gates: z.string(),
  enabled: z.boolean(),
  defaultEnabled: z.boolean(),
  source: z.enum(FEATURE_FLAG_SOURCES),
  /** Null while the flag is at its default — there is nobody to name. */
  changedAt: z.iso.datetime().nullable(),
  changedById: z.uuid().nullable(),
});
export type AdminFeatureFlag = z.infer<typeof adminFeatureFlagSchema>;

export const adminFeatureFlagsSchema = z.object({
  flags: z.array(adminFeatureFlagSchema),
});
export type AdminFeatureFlags = z.infer<typeof adminFeatureFlagsSchema>;

export function parseAdminFeatureFlags(raw: unknown): AdminFeatureFlags {
  return parseWith(adminFeatureFlagsSchema, 'The feature flags', raw);
}

export function parseAdminFeatureFlag(raw: unknown): AdminFeatureFlag {
  return parseWith(adminFeatureFlagSchema, 'The feature flag', raw);
}

/** What a switch request carries. */
export const featureFlagChangeSchema = z.object({
  enabled: z.boolean(),
});
export type FeatureFlagChange = z.infer<typeof featureFlagChangeSchema>;

export function parseFeatureFlagChange(raw: unknown): FeatureFlagChange {
  return parseWith(featureFlagChangeSchema, 'The feature flag change', raw);
}
