/**
 * What is needed to collect and carry an item (BRD §8.3, ADR 0031).
 *
 * **A closed platform vocabulary, and a per-category selection from it.** That
 * split is the whole design. §8.3 requires the requirement to reach the booking
 * summary, the collection instructions, the handover checklist and a search
 * filter — four consumers, in three later phases, that must be able to ask *any*
 * listing what it needs. A per-category option list would answer that only for
 * the categories whose administrator happened to spell it the same way, so
 * `van_required` in one category and `van` in another would be two different
 * filters with nothing to notice.
 *
 * Adding an option to a category is therefore configuration. Adding a **value**
 * here is a deploy — ADR 0027's rule about attribute types, for the same reason:
 * a value is something later code has to reason about, not merely render.
 *
 * Its own file rather than part of `catalogue.ts`, because it is read from both
 * sides of the boundary. A category *configures* which options it offers; a
 * listing *carries* one, and from Phase 3 a search filter compares them across
 * every category at once. Keeping it beside the category configuration would
 * make the search module import the admin contract to find out what a van is.
 */

import { z } from 'zod';
import { parseWith } from './parse.js';

/**
 * The vocabulary, in **display order**.
 *
 * The order looks like a ranking and is deliberately not treated as one
 * (ADR 0031). Somebody with a van cannot necessarily tow, so `trailer_required`
 * is not simply "more than" `van_required`, and nothing in this file ranks them:
 * the weight suggestion is driven by the thresholds a category configures, not
 * by position here. **Phase 3's filter must be a multi-select of what the renter
 * can do, never a "no more than X" slider** — a slider would silently exclude
 * the towing renter from trailer listings.
 *
 * There is no value for a long, light item — a ladder needs roof bars and weighs
 * nothing, which is a third axis. The launch category has no ladders, and a
 * guess in a vocabulary that costs a deploy to correct is worse than the gap.
 */
export const TRANSPORT_REQUIREMENTS = [
  'hand_carryable',
  'car_boot',
  'estate_or_hatchback',
  'van_required',
  'trailer_required',
] as const;
export type TransportRequirement = (typeof TRANSPORT_REQUIREMENTS)[number];

export const transportRequirementSchema = z.enum(TRANSPORT_REQUIREMENTS);

/**
 * Short wording, for a list of options and for the messages that name them.
 *
 * **In the contract rather than in the web app**, which departs from how
 * `riskLevel` and `reportableActivity` are handled — their labels live in
 * `category-form.tsx`. Those are read by one administrative form. These are read
 * by the admin form, the listing form, the public listing page from 2.10, the
 * search facet from Phase 3 and the handover checklist from Phase 7 — and by the
 * API, whose rejection has to name the offered options the way the owner saw
 * them. Six copies of the same five phrases is how they stop agreeing.
 */
export const TRANSPORT_REQUIREMENT_LABELS: Record<TransportRequirement, string> = {
  hand_carryable: 'Carried by hand',
  car_boot: 'Car boot',
  estate_or_hatchback: 'Estate or hatchback',
  van_required: 'Van or large vehicle',
  trailer_required: 'Trailer',
};

/**
 * The sentence a person needs to choose correctly, as opposed to the phrase that
 * identifies the choice once made.
 *
 * Separate from the labels because they do different jobs: a label goes in a
 * search facet and on a listing card where space is short, and this goes beside
 * a radio button where somebody is deciding. Folding them into one string would
 * make the facet unreadable or the choice ambiguous.
 */
export const TRANSPORT_REQUIREMENT_HINTS: Record<TransportRequirement, string> = {
  hand_carryable: 'Can be carried by hand, on foot or on public transport',
  car_boot: 'Fits in the boot of an ordinary car',
  estate_or_hatchback: 'Needs an estate, a hatchback, or rear seats folded down',
  van_required: 'Needs a van or a large panel vehicle',
  trailer_required: 'Needs a trailer, and something able to tow it',
};

/**
 * The attribute key the platform recognises as an item's weight in kilograms.
 *
 * §8.3: *"Item weight, where captured as an attribute, should drive a suggested
 * default for this field rather than being asked twice."* ADR 0027 is explicit
 * about how: **key off the attribute key, never parse the `unit` string**, which
 * is free text and means nothing to the system. So this one key is a contract
 * between the platform and whoever configures a category, and a category without
 * it simply gets no suggestion — which is what "where captured as an attribute"
 * allows.
 *
 * The admin editor says so where the thresholds are typed, because renaming this
 * key stops the suggestion silently and correctly: nothing is wrong, the category
 * just no longer has a weight anything recognises.
 */
export const WEIGHT_ATTRIBUTE_KEY = 'weight_kg';

/**
 * Bounds on a suggestion threshold, in whole kilograms.
 *
 * Whole kilograms because this is a band boundary rather than a measurement — a
 * threshold of 15.5 kg implies a precision the suggestion does not have. The
 * upper bound is a sanity limit in the spirit of the replacement-value bounds: it
 * is not a policy about how heavy a rentable item may be, it is what stops a
 * mistyped threshold sitting in configuration unnoticed.
 */
export const MIN_TRANSPORT_SUGGESTION_KG = 1;
export const MAX_TRANSPORT_SUGGESTION_KG = 2_000;

/**
 * One option a category offers, and optionally the weight it is suggested up to.
 *
 * **The threshold is absent rather than null when there is none.** One
 * representation of "not configured", for the reason `attribute-values.ts` gives
 * about unanswered attributes: two spellings of absence is two cases every later
 * reader has to remember to treat alike, and one of them eventually is not.
 *
 * A category that sets no thresholds at all suggests nothing. That is a no-op
 * rather than a wrong nudge, which is the right way for this to degrade.
 */
export const transportOptionSchema = z.object({
  requirement: transportRequirementSchema,
  suggestedUpToKg: z
    .number()
    .int('must be a whole number of kilograms')
    .min(
      MIN_TRANSPORT_SUGGESTION_KG,
      `must be at least ${MIN_TRANSPORT_SUGGESTION_KG} kg`,
    )
    .max(
      MAX_TRANSPORT_SUGGESTION_KG,
      `must be at most ${MAX_TRANSPORT_SUGGESTION_KG} kg`,
    )
    .optional(),
});
export type CategoryTransportOption = z.infer<typeof transportOptionSchema>;

/** Where each value sits in display order, for sorting and for the checks below. */
const DISPLAY_RANK = new Map<TransportRequirement, number>(
  TRANSPORT_REQUIREMENTS.map((requirement, index) => [requirement, index]),
);

function rankOf(requirement: TransportRequirement): number {
  // Every member of the union is in the map by construction, so the fallback is
  // unreachable — it exists because `Map.get` cannot know that.
  /* c8 ignore next */
  return DISPLAY_RANK.get(requirement) ?? TRANSPORT_REQUIREMENTS.length;
}

/**
 * The set of options a category offers, normalised into display order.
 *
 * **Sorted on the way in rather than on the way out.** The stored value is
 * therefore canonical, which matters for the audit digest: two administrators
 * ticking the same boxes in a different order must produce the same
 * configuration, or every reconfiguration looks like a change (ADR 0017). It is
 * the same reason `choice-many` answers are stored in their definition's order
 * rather than the order they were sent.
 *
 * **Thresholds must increase down the display order.** A configuration where the
 * van threshold sits below the car boot's is a mistake somebody made rather than
 * a policy — it would make one of the two options unreachable by any weight —
 * and it is exactly the kind of thing that is invisible once saved. Options
 * without a threshold do not constrain their neighbours.
 *
 * **Neither issue carries a `path`, and that is deliberate.** `parseWith`
 * prefixes a message with its path, which reads well when the path is a field
 * somebody typed into — `slug: must be lowercase…`. Here it produced
 * *"3.suggestedUpToKg: "Van or large vehicle" suggests up to 20 kg…"*: an index
 * into the posted array, which is not even the row number on screen, in front of
 * a sentence that already names both options. That is 2.4b's mistake exactly —
 * see `describeAttributeIssue` — and the fix is the same one: the message names
 * its own subject, in the words the administrator saw.
 */
export const categoryTransportOptionsSchema = z
  .array(transportOptionSchema)
  .max(
    TRANSPORT_REQUIREMENTS.length,
    `must be at most ${String(TRANSPORT_REQUIREMENTS.length)} options`,
  )
  .superRefine((options, ctx) => {
    const seen = new Set<TransportRequirement>();
    for (const option of options) {
      if (seen.has(option.requirement)) {
        // Two entries for one requirement means the category offers the same
        // option twice, and a listing choosing it could not say which was meant
        // — including which threshold applied to it.
        ctx.addIssue({
          code: 'custom',
          message: `"${TRANSPORT_REQUIREMENT_LABELS[option.requirement]}" is offered twice`,
        });
      }
      seen.add(option.requirement);
    }

    const ordered = [...options].sort(
      (a, b) => rankOf(a.requirement) - rankOf(b.requirement),
    );

    let previous: { readonly label: string; readonly kg: number } | null = null;
    for (const option of ordered) {
      const kg = option.suggestedUpToKg;
      if (kg === undefined) continue;

      if (previous !== null && kg <= previous.kg) {
        ctx.addIssue({
          code: 'custom',
          message:
            `"${TRANSPORT_REQUIREMENT_LABELS[option.requirement]}" suggests up to ` +
            `${String(kg)} kg, which is not more than "${previous.label}" at ` +
            `${String(previous.kg)} kg — each option must cover heavier items than ` +
            'the one above it, or one of them can never be suggested',
        });
      }
      previous = { label: TRANSPORT_REQUIREMENT_LABELS[option.requirement], kg };
    }
  })
  .transform((options) =>
    [...options].sort((a, b) => rankOf(a.requirement) - rankOf(b.requirement)),
  );

export function parseCategoryTransportOptions(
  raw: unknown,
): readonly CategoryTransportOption[] {
  return parseWith(categoryTransportOptionsSchema, 'The transport options', raw);
}

/**
 * Whether a category offers a given requirement.
 *
 * One function rather than `options.some(...)` written at each call site, for the
 * reason `activatesSellerReporting` exists: the rule is trivial today, and the
 * day it is not — an option withdrawn but still honoured for existing listings,
 * say — every caller has to change together or one keeps the old meaning.
 */
export function offersTransportRequirement(
  options: readonly CategoryTransportOption[],
  requirement: string,
): boolean {
  return options.some((option) => option.requirement === requirement);
}
