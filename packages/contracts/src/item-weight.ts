/**
 * Reading an item's weight out of the answers a form is holding (§8.3).
 *
 * **Its own module because of a dependency direction, not because it is big.**
 * `catalogue.ts` imports `transport.ts` — a category's configuration includes its
 * transport options — so `transport.ts` must not import `catalogue.ts` back. This
 * needs both: `CategoryAttribute` to find the weight and know its scale, and
 * `WEIGHT_ATTRIBUTE_KEY` to know which attribute is the weight. It sits below
 * both instead.
 *
 * **The key is the contract; the unit string is decoration.** ADR 0027 made
 * `unit` free text and said so explicitly: anything needing to know an attribute
 * *is* a weight keys off `weight_kg` and never parses "kg" out of a label. A
 * category that names its weight something else simply gets no suggestion — no
 * error, because nothing is wrong.
 */

import { Scaled, ScaledError } from '@platform/core';
import type { CategoryAttribute } from './catalogue.js';
import { WEIGHT_ATTRIBUTE_KEY } from './transport.js';
import type { ItemWeight } from './transport.js';

/** Answers as a form holds them — typed text, or a list of ticked values. */
export type TypedAnswers = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/**
 * The weight this form is currently describing, or null if there is not one.
 *
 * **Null is the normal case and not a failure.** It is what a half-typed "12."
 * looks like, what an untouched form looks like, and what a category with no
 * weight attribute looks like. All three mean the same thing to the only caller
 * that matters — do not suggest anything yet — so they are not distinguished.
 * Returning an error for a value somebody is still in the middle of typing would
 * make the form shout at every keystroke.
 */
export function readItemWeight(
  attributes: readonly CategoryAttribute[],
  answers: TypedAnswers,
): ItemWeight | null {
  const attribute = attributes.find(
    (candidate) => candidate.key === WEIGHT_ATTRIBUTE_KEY,
  );

  // Configured as something other than a number — a `text` weight, say. There is
  // no scale to read it against, so there is nothing to compare.
  if (attribute === undefined || attribute.type !== 'number') return null;

  const answer = answers[WEIGHT_ATTRIBUTE_KEY];
  if (typeof answer !== 'string') return null;

  const typed = answer.trim();
  if (typed === '') return null;

  // The same pattern `attribute-values.ts` refuses on, and for the same reason:
  // the primitive would read "2.5" out of "2.5kg" and "1" out of "1,299". Here
  // it also catches the half-typed states — "12." and "-" — that a live
  // suggestion sees on the way to a real number.
  if (!/^-?\d+(?:\.\d+)?$/.test(typed)) return null;

  try {
    const scaled = Scaled.fromDecimalString(typed, attribute.decimalPlaces);
    // A negative weight is not a lighter item, it is a typo. Suggesting the
    // least demanding option for it would be confidently wrong.
    if (scaled < 0) return null;
    return { scaled, decimalPlaces: attribute.decimalPlaces };
  } catch (error) {
    // More decimal places than the category allows — "2.55" where one is
    // configured. The API refuses that on submit with a message naming the
    // field; a suggestion has nothing useful to say about it and stays quiet.
    if (error instanceof ScaledError) return null;
    /* c8 ignore next */
    throw error;
  }
}
