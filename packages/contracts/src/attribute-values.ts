/**
 * What a listing answers its category's attributes with.
 *
 * ADR 0027 fixed the *definition* vocabulary — four types, closed, because a
 * type is a renderer. This is the other half: the values, and the check that
 * they fit the schema the listing pinned.
 *
 * **The validator is category-dependent, so it is not part of the wire schema.**
 * `listingDraftSchema` can only say "this is an object of values"; which values
 * are legal depends on configuration that the request does not carry and the
 * client must not choose. The real check therefore happens in the Catalogue
 * service, against the schema on the version being pinned, inside the same read
 * that pins it — see `ListingStore`. This module is the shared implementation so
 * the web app can give the same answer before the round trip, exactly as it
 * shares `listingDraftSchema` today.
 *
 * **Required attributes are deliberately not enforced here.** §8.3 says owners
 * "create draft listings and save progress", and a draft that refuses to save
 * until every field is answered is the form people abandon. Completeness is a
 * publication rule (slice 2.8), the same way the description is required to be
 * *present* and allowed to be *empty*.
 */

import { Scaled, ScaledError } from '@platform/core';
import type { CategoryAttribute, AttributeOption } from './catalogue.js';
import { MAX_CATEGORY_ATTRIBUTES } from './catalogue.js';
import { hasUnsafeCharacters, UNSAFE_CHARACTERS_MESSAGE } from './text.js';

/**
 * One **stored** answer.
 *
 * A string for `text` and `choice`, a scaled integer for `number` (ADR 0027 —
 * 2.5 kg is `25` at one decimal place), and a list of option values for
 * `choice-many`. There is no `null`: an unanswered attribute is **absent**, so
 * that the platform has one representation of "not answered" rather than two
 * that later code has to remember to treat alike.
 *
 * **What arrives on the wire is not this.** A `number` is submitted as the text
 * somebody typed — "2.5" — and scaled here, because the scale is category
 * configuration and a client that supplied both the value and its scale could
 * not be checked. The submitted shape is deliberately unnamed: it is whatever
 * `validateAttributeValues` accepts, and nothing else should be building it.
 */
export type AttributeValue = string | number | readonly string[];

/** Answers keyed by attribute key, in the schema's own order. */
export type ListingAttributeValues = Readonly<Record<string, AttributeValue>>;

/**
 * A problem with one answer.
 *
 * `key` is present so a form can put the message beside the field that caused
 * it rather than in a banner at the top; it is null only when the whole value is
 * the wrong shape and no single field is to blame.
 */
export interface AttributeValueIssue {
  readonly key: string | null;
  readonly message: string;
}

export type AttributeValueResult =
  | { readonly ok: true; readonly values: ListingAttributeValues }
  | { readonly ok: false; readonly issues: readonly AttributeValueIssue[] };

/**
 * How an issue reads once it has left the structured world, e.g. in a 400 body.
 *
 * **No `key:` prefix, which departs from every other contract error in this
 * package** — those read `title: must be at least 3 characters`, where the path
 * *is* the field name somebody sees on screen. An attribute's path is its `key`,
 * which is deliberately internal: `weight_kg` appears nowhere on the form, and
 * ADR 0027 split `key` from `label` precisely so that one is for machines and
 * one is for people. So the message names the field itself, by its label, and
 * prefixing it produced *"weight_kg: Weight "2.55" has more than 1 decimal
 * place"* — which is the field named twice, once in a way the reader has never
 * seen.
 *
 * The key is not lost: it stays on `AttributeValueIssue` for whatever renders
 * errors beside their fields. When that arrives, the 400 body should carry the
 * keys as structure rather than as a string prefix.
 */
export function describeAttributeIssue(issue: AttributeValueIssue): string {
  return issue.message;
}

function optionList(options: readonly AttributeOption[]): string {
  return options.map((option) => option.label).join(', ');
}

function isOption(options: readonly AttributeOption[], value: string): boolean {
  return options.some((option) => option.value === value);
}

/**
 * A plain object, and not an array.
 *
 * `typeof [] === 'object'` and an array would otherwise pass every subsequent
 * check by having no keys at all, storing `{}` for something that was plainly
 * not a set of answers.
 */
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/**
 * Check one answer against one definition.
 *
 * Returns the value to store, or a message. The switch is exhaustive over the
 * vocabulary and has no default: adding a fifth type is a deploy (ADR 0027), and
 * this is one of the places the compiler should insist on being told about it.
 */
function readValue(
  attribute: CategoryAttribute,
  raw: unknown,
): { readonly value: AttributeValue } | { readonly message: string } {
  switch (attribute.type) {
    case 'text': {
      if (typeof raw !== 'string') {
        return { message: `${attribute.label} must be text` };
      }
      const trimmed = raw.trim();
      if (trimmed === '') {
        return {
          message: `${attribute.label} must not be blank — leave it out rather than sending an empty answer`,
        };
      }
      if (trimmed.length > attribute.maxLength) {
        return {
          message: `${attribute.label} must be at most ${String(
            attribute.maxLength,
          )} characters`,
        };
      }
      if (hasUnsafeCharacters(trimmed)) {
        return { message: `${attribute.label} ${UNSAFE_CHARACTERS_MESSAGE}` };
      }
      return { value: trimmed };
    }

    case 'number': {
      // **A number arrives as the text somebody typed, and is scaled here.**
      //
      // The scale is *category configuration*, so the conversion has to happen
      // where the authoritative schema is — which is the server, reading the
      // version it is about to pin. If the wire carried the scaled integer, a
      // client would be supplying both the value and the scale it was computed
      // at, and 25 would be indistinguishable from 2.5 kg entered against a
      // tampered decimal place.
      //
      // Text also keeps the ADR 0002 rule that a decimal is a string until
      // something with the scale in hand converts it: no float exists at any
      // point on this path.
      if (typeof raw !== 'string') {
        return {
          message: `${attribute.label} must be sent as text, such as "2.5", not as a number`,
        };
      }

      const typed = raw.trim();
      if (typed === '') {
        return {
          message: `${attribute.label} must not be blank — leave it out rather than sending an empty answer`,
        };
      }

      // Refused here rather than by the primitive, which would read "2.5" out of
      // "2.5kg" and silently accept a unit we never asked for — and would read
      // "1,299" as "1", a value a thousandfold too small.
      if (!/^-?\d+(?:\.\d+)?$/.test(typed)) {
        return {
          message:
            `${attribute.label} must be a number in ${attribute.unit}, such as 2.5 — ` +
            'digits only, with no unit and no thousands separator',
        };
      }

      try {
        return { value: Scaled.fromDecimalString(typed, attribute.decimalPlaces) };
      } catch (error) {
        if (error instanceof ScaledError) {
          // The primitive's message already names the value and the scale —
          // "2.55" has more than 1 decimal place — so the label goes in front
          // of it rather than replacing it.
          return { message: `${attribute.label} ${error.message}` };
        }
        /* c8 ignore next */
        throw error;
      }
    }

    case 'choice': {
      // The wrong type and an unrecognised value get the same message on
      // purpose. To the person reading it they are the same mistake — the
      // answer is not one of the offered ones — and a message that said
      // "expected string, received number" would be about our wire format
      // rather than about their form.
      if (typeof raw !== 'string' || !isOption(attribute.options, raw)) {
        return {
          message: `${attribute.label} must be one of ${optionList(attribute.options)}`,
        };
      }
      return { value: raw };
    }

    case 'choice-many': {
      if (!Array.isArray(raw)) {
        return {
          message: `${attribute.label} must be a list of ${optionList(attribute.options)}`,
        };
      }
      const chosen: string[] = [];
      for (const entry of raw as readonly unknown[]) {
        if (typeof entry !== 'string' || !isOption(attribute.options, entry)) {
          return {
            message: `${attribute.label} may only contain ${optionList(attribute.options)}`,
          };
        }
        if (chosen.includes(entry)) {
          // One ticked box, one entry. A repeat means the client built the list
          // wrongly, and storing it would make "how many are selected" a
          // question with two answers.
          return { message: `${attribute.label} lists the same choice twice` };
        }
        chosen.push(entry);
      }
      if (chosen.length === 0) {
        return {
          message: `${attribute.label} must not be an empty list — leave it out if nothing applies`,
        };
      }
      // Stored in the definition's order rather than the order they were sent,
      // so two listings with the same answers store the same value and a later
      // comparison does not depend on how a form happened to serialise.
      return {
        value: attribute.options
          .map((option) => option.value)
          .filter((value) => chosen.includes(value)),
      };
    }
  }
}

/**
 * Validate a set of answers against a category's attribute schema.
 *
 * The result is built by walking the **definitions**, not the submitted keys, so
 * what gets stored is in the schema's own order regardless of how it arrived.
 *
 * `null` is treated as *absent*, deliberately, and it is the one lenient reading
 * here. It is what an unanswered field serialises to from a form, and a draft
 * that has not answered something is the normal case rather than an error. An
 * unknown **key** gets no such leniency: that means the client and the schema
 * disagree about what this category is, which is a real inconsistency and is
 * refused rather than silently dropped — dropping it would throw away something
 * the owner typed without telling them.
 */
export function validateAttributeValues(
  attributes: readonly CategoryAttribute[],
  raw: unknown,
): AttributeValueResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      issues: [
        { key: null, message: 'The attribute values must be an object of answers' },
      ],
    };
  }

  const submitted = Object.keys(raw);

  // Bounded before anything is walked. The schema caps definitions at
  // MAX_CATEGORY_ATTRIBUTES, so a larger object cannot be valid however it is
  // read — and refusing it in one issue stops a request with ten thousand junk
  // keys producing ten thousand messages.
  if (submitted.length > MAX_CATEGORY_ATTRIBUTES) {
    return {
      ok: false,
      issues: [
        {
          key: null,
          message: `At most ${String(MAX_CATEGORY_ATTRIBUTES)} attribute values may be supplied`,
        },
      ],
    };
  }

  const issues: AttributeValueIssue[] = [];
  const known = new Set(attributes.map((attribute) => attribute.key));

  for (const key of submitted) {
    if (!known.has(key)) {
      issues.push({
        key,
        message:
          `"${key}" is not a field of this category. It may have been renamed or ` +
          'removed since this form was opened',
      });
    }
  }

  const values: Record<string, AttributeValue> = {};

  for (const attribute of attributes) {
    if (!Object.hasOwn(raw, attribute.key)) continue;

    const supplied = raw[attribute.key];
    if (supplied === null || supplied === undefined) continue;

    const read = readValue(attribute, supplied);
    if ('message' in read) {
      issues.push({ key: attribute.key, message: read.message });
      continue;
    }
    values[attribute.key] = read.value;
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, values };
}
