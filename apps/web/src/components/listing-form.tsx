'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  LISTING_DESCRIPTION_MAX_LENGTH,
  LISTING_TITLE_MAX_LENGTH,
  LISTING_TITLE_MIN_LENGTH,
} from '@platform/contracts';
import { readItemWeight } from '@platform/contracts';
import type { CategoryOption, TransportRequirement } from '@platform/contracts';
import { createListingAction } from '../app/listings/new/actions';
import { INITIAL_LISTING_STATE } from '../app/listings/new/state';
import { AttributeFields, toSubmittedAttributes } from './attribute-fields';
import type { AttributeAnswers } from './attribute-fields';
import { TransportField } from './transport-field';

/**
 * Creating a draft listing.
 *
 * The form deliberately asks for very little of its own. §8.3 says owners
 * "create draft listings and save progress", and everything else a listing
 * eventually needs — location, prices, photographs, availability — arrives in
 * later slices. A form that asked for all of it at once is the form people
 * abandon.
 *
 * What it asks for **on behalf of the category** is not fixed at all: the fields
 * under `AttributeFields` come from configuration, which is the Phase 2 exit
 * gate. Nothing in this file knows what a category contains.
 */
export function ListingForm({
  categories,
}: {
  readonly categories: readonly CategoryOption[];
}) {
  const [state, action, pending] = useActionState(
    createListingAction,
    INITIAL_LISTING_STATE,
  );

  const [slug, setSlug] = useState(state.categorySlug);
  const [answers, setAnswers] = useState<AttributeAnswers>({});
  /**
   * What the owner has *chosen*, which is not the same as what the field shows.
   *
   * Null means they have not decided, and the transport field then follows the
   * weight as it is typed. Once they choose, this holds it and the suggestion
   * stops moving underneath them — the alternative is a control that fights its
   * own user every time they correct the weight.
   */
  const [transport, setTransport] = useState<TransportRequirement | null>(null);
  const [twoPersonLift, setTwoPersonLift] = useState(false);

  const chosen = categories.find((category) => category.slug === slug);
  // The weight the category captured, if it captured one. Keyed off the
  // attribute key rather than the unit string (ADR 0027), and null for every
  // half-typed state on the way to a number.
  const weight =
    chosen === undefined ? null : readItemWeight(chosen.attributes, answers);

  /**
   * Put the failure where the person is looking.
   *
   * The message renders at the top of the form and the button is at the bottom,
   * and the category's own fields made that gap much longer. Pressing Save and
   * seeing the page not move reads as a form that does nothing — which is what
   * it looked like when this was first opened in a browser, convincingly enough
   * to be reported as a broken feature.
   *
   * **Both, and in this order, because focus alone is not enough.** Focusing
   * moves the screen reader to the message; scrolling is what a sighted person
   * needs. `focus()` normally scrolls too — but on a *second* consecutive
   * failure React reuses the same node, which is already focused, so the call
   * does nothing and the page sits still exactly when somebody is most likely
   * to think it is stuck. Found that way, on the second failure in a row.
   *
   * **The dependency is the whole state object, not `state.message`**, and that
   * is the half slice 2.4b missed. Two identical failures produce the same
   * string, so a dependency on the string compares equal and the effect never
   * runs again — the `focus()` and `scrollIntoView()` above are not merely
   * ineffective on the second press, they are never called. Confirmed in a
   * browser: press Save twice with the same bad value and the alert is not
   * focused the second time. `useActionState` returns a fresh object per
   * settled action, so this fires on every attempt including an identical
   * repeat.
   */
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.message === null) return;
    alert.current?.focus({ preventScroll: true });
    // Optional call: jsdom does not implement `scrollIntoView`, and a component
    // test asserting the message should not fail on a browser affordance.
    alert.current?.scrollIntoView?.({ block: 'center' });
  }, [state]);

  return (
    <form action={action}>
      {state.message === null ? null : (
        // `tabIndex={-1}` makes it focusable without putting it in the tab
        // order — it is a message, not a control.
        <p role="alert" ref={alert} tabIndex={-1}>
          {state.message}
        </p>
      )}

      <p>
        <label htmlFor="listing-category">Category</label>
        <select
          id="listing-category"
          name="categorySlug"
          required
          value={slug}
          aria-describedby="listing-category-help"
          onChange={(event) => {
            setSlug(event.target.value);
            // Answers are keyed by attribute key, and two categories that share
            // a key rarely mean the same thing by it — one category's "petrol"
            // is not necessarily on another's list. Carrying them across would
            // submit answers to questions that were never asked, so switching
            // category starts the category's own fields empty.
            setAnswers({});
            // Cleared for a sharper reason than the answers: two categories
            // offer different transport options, so a choice carried across
            // could be one the new category does not offer — which the API
            // would refuse, about a field the owner never touched.
            setTransport(null);
          }}
        >
          <option value="">Choose a category</option>
          {categories.map((category) => (
            <option key={category.slug} value={category.slug}>
              {category.name}
            </option>
          ))}
        </select>
      </p>
      <p id="listing-category-help">
        The category decides which details you are asked for and which rules apply. It
        is recorded as it stands today, so changing the category later is a new listing
        rather than an edit.
      </p>

      <p>
        <label htmlFor="listing-title">Title</label>
        <input
          id="listing-title"
          name="title"
          type="text"
          required
          minLength={LISTING_TITLE_MIN_LENGTH}
          maxLength={LISTING_TITLE_MAX_LENGTH}
          defaultValue={state.title}
          placeholder="Petrol hedge trimmer"
        />
      </p>

      <p>
        <label htmlFor="listing-description">Description</label>
        <textarea
          id="listing-description"
          name="description"
          rows={5}
          maxLength={LISTING_DESCRIPTION_MAX_LENGTH}
          defaultValue={state.description}
          aria-describedby="listing-description-help"
        />
      </p>
      <p id="listing-description-help">
        Optional while this is a draft — you can come back to it. It has to say
        something before the listing can be published.
      </p>

      <p>
        <label htmlFor="listing-value">Replacement value (£)</label>
        {/*
          `type="text"` with a numeric input mode, not `type="number"`.
          A number input hands back a JavaScript number, and a float is exactly
          what must never touch money (ADR 0002) — the string goes to
          `Money.fromMajor`, which is the only conversion allowed to see it.
        */}
        <input
          id="listing-value"
          name="replacementValue"
          type="text"
          inputMode="decimal"
          required
          defaultValue={state.replacementValue}
          placeholder="249.99"
          aria-describedby="listing-value-help"
        />
      </p>
      <p id="listing-value-help">
        What it would cost you to replace this item today, in pounds. It is not the
        rental price — it is what a damage claim would be measured against, so an
        inflated figure is not in your interest either.
      </p>

      {chosen === undefined ? (
        // No dead controls: until a category is chosen there are no
        // category-specific fields to show, and inventing empty ones would ask
        // questions nobody has posed.
        <p>Choose a category above to see the details it asks for.</p>
      ) : (
        <>
          {/*
            One hidden JSON value, not indexed field names. `attributes[0][options][1]`
            needs a server-side reassembler that duplicates the shape the contract
            already describes, and the two drift the moment a type is added — the
            same reasoning the attribute schema editor gives for the admin side.

            Rendered whatever the state, including empty, so an unanswered form
            posts `{}` rather than an absent field. The server refuses an absent
            one rather than guessing it meant nothing.
          */}
          <input
            type="hidden"
            name="attributes"
            value={JSON.stringify(toSubmittedAttributes(chosen.attributes, answers))}
          />
          {/*
            Which version these answers were given against. Not a choice of
            which version to pin — the server still pins whatever is current
            when it writes — but a statement of what was on screen, so a
            reconfiguration that lands while this page is open is noticed rather
            than silently dropping an answer.
          */}
          <input
            type="hidden"
            name="categoryVersionNumber"
            value={String(chosen.versionNumber)}
          />

          <AttributeFields
            attributes={chosen.attributes}
            answers={answers}
            onChange={(key, value) => {
              setAnswers((current) => ({ ...current, [key]: value }));
            }}
          />

          {/*
            After the attributes, deliberately: the weight is one of them, and a
            field that suggests an answer should appear below the thing it read
            rather than above it. Renders nothing at all when the category offers
            no options.
          */}
          <TransportField
            options={chosen.transportOptions}
            weight={weight}
            chosen={transport}
            onChange={setTransport}
            requiresTwoPersonLift={twoPersonLift}
            onLiftChange={setTwoPersonLift}
          />
        </>
      )}

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save draft'}
        </button>
      </p>
    </form>
  );
}
