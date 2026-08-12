/**
 * Turning a submitted form into something the API contract will accept.
 *
 * A separate, pure function rather than logic inside the server action, because
 * this is where the mistakes live and none of them need a server to reproduce.
 * HTML forms have no concept of null, no concept of a nested object, and send
 * `""` for every box a person left alone — so the mapping from `FormData` to
 * `ProfileInput` is real work, not plumbing.
 */

import { parseProfileInput } from '@platform/contracts';
import type { ProfileInput } from '@platform/contracts';

/** The subset of `FormData` used here, so tests need no DOM. */
export interface FormValues {
  get(name: string): FormDataEntryValue | null;
}

function text(form: FormValues, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** `""` means "left blank", which for an optional field means null, not empty. */
function optional(form: FormValues, name: string): string | null {
  const value = text(form, name);
  return value === '' ? null : value;
}

export type FormResult =
  | { readonly kind: 'ok'; readonly input: ProfileInput }
  | { readonly kind: 'invalid'; readonly issues: readonly string[] };

/**
 * Read a profile out of a submitted form.
 *
 * Validated against the same contract the API enforces, so the form and the
 * server cannot disagree about what a valid postcode is — and so a person sees
 * the problem without a round trip.
 *
 * The address is **all-or-nothing**, decided by whether any of its boxes were
 * filled. Somebody who fills in a postcode and nothing else has started
 * entering an address and should be told what is missing; somebody who filled
 * in none of it simply has no address, which is allowed.
 */
export function readProfileForm(form: FormValues): FormResult {
  const addressFields = {
    line1: text(form, 'line1'),
    line2: optional(form, 'line2'),
    town: text(form, 'town'),
    postcode: text(form, 'postcode'),
  };

  const anyAddress = Object.values(addressFields).some(
    (value) => value !== null && value !== '',
  );

  try {
    return {
      kind: 'ok',
      input: parseProfileInput({
        displayName: text(form, 'displayName'),
        phone: optional(form, 'phone'),
        address: anyAddress ? addressFields : null,
        /*
         * **Null when neither radio was picked**, which is what an unanswered
         * question posts — a radio group with nothing selected sends no value
         * at all. That is exactly the state the publication gate refuses on, so
         * it must survive the round trip rather than being coerced into a
         * default here. `parseProfileInput` refuses anything that is neither
         * null nor one of the two known values, so a hand-crafted POST cannot
         * invent a third.
         */
        ownerStatus: optional(form, 'ownerStatus'),
      }),
    };
  } catch (error) {
    return {
      kind: 'invalid',
      issues: issuesOf(error),
    };
  }
}

function issuesOf(error: unknown): readonly string[] {
  if (
    typeof error === 'object' &&
    error !== null &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    return (error as { issues: readonly string[] }).issues;
  }
  return [error instanceof Error ? error.message : String(error)];
}
