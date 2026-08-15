'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  ADDRESS_LINE_MAX_LENGTH,
  LISTING_DESCRIPTION_MAX_LENGTH,
  LISTING_TITLE_MAX_LENGTH,
  LISTING_TITLE_MIN_LENGTH,
  TOWN_MAX_LENGTH,
} from '@platform/contracts';
import { readItemWeight } from '@platform/contracts';
import type { CategoryOption, TransportRequirement } from '@platform/contracts';
import { createListingAction } from '../app/listings/new/actions';
import { INITIAL_LISTING_STATE } from '../app/listings/new/state';
import { AttributeFields, toSubmittedAttributes } from './attribute-fields';
import type { AttributeAnswers } from './attribute-fields';
import { OutwardCodePreview } from './outward-code-preview';
import { ResetSafeSelect } from './reset-safe-select';
import { TransportField } from './transport-field';
import group from './form-card.module.css';

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
  // Only so the district under the field can be the one they typed. The input
  // stays uncontrolled — the server action reads the form, not this.
  const [postcode, setPostcode] = useState(state.postcode);

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
        <p role="alert" ref={alert} tabIndex={-1} className={group.problem}>
          {state.message}
        </p>
      )}

      <fieldset className={group.card}>
        <legend className={group.legend}>
          <span className={group.badge}>The item</span>
        </legend>

        <div className={group.field}>
          <label htmlFor="listing-category">Category</label>
          {/*
          `ResetSafeSelect`, not a bare `<select value=…>`. React's post-action
          form reset leaves a controlled select showing its first option while
          React still holds the real one — and here that meant "Choose a
          category" above a fieldset of that category's own fields, with the
          hidden version number still set. Read that component before changing
          this back.
        */}
          <ResetSafeSelect
            id="listing-category"
            name="categorySlug"
            required
            value={slug}
            describedBy="listing-category-help"
            onChange={(next) => {
              setSlug(next);
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
          </ResetSafeSelect>
          <p id="listing-category-help" className={group.help}>
            The category decides which details you are asked for and which rules apply.
            It is recorded as it stands today, so changing the category later is a new
            listing rather than an edit.
          </p>
        </div>

        <div className={group.field}>
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
        </div>

        <div className={group.field}>
          <label htmlFor="listing-description">Description</label>
          <textarea
            id="listing-description"
            name="description"
            rows={5}
            maxLength={LISTING_DESCRIPTION_MAX_LENGTH}
            defaultValue={state.description}
            aria-describedby="listing-description-help"
          />
          <p id="listing-description-help" className={group.help}>
            Optional while this is a draft — you can come back to it. It has to say
            something before the listing can be published.
          </p>
        </div>

        <div className={group.field}>
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
          <p id="listing-value-help" className={group.help}>
            What it would cost you to replace this item today, in pounds. It is not the
            rental price — it is what a damage claim would be measured against, so an
            inflated figure is not in your interest either.
          </p>
        </div>
      </fieldset>

      <fieldset className={group.card}>
        <legend className={group.legend}>
          <span className={group.badge}>What it costs to rent</span>
        </legend>

        <p className={group.intro}>
          Leave any of these blank for now — a draft does not have to be priced. You
          will need a <strong>daily rate</strong> before you can publish.
        </p>

        <p>
          <label htmlFor="listing-daily-rate">Daily rate (£)</label>
          {/*
            `type="text"` with a numeric input mode, for the replacement value's
            reason: a number input hands back a JavaScript number, and a float
            must never touch money (ADR 0002).
          */}
          <input
            id="listing-daily-rate"
            name="dailyRate"
            type="text"
            inputMode="decimal"
            defaultValue={state.dailyRate}
            placeholder="18.00"
            aria-describedby="listing-daily-rate-help"
          />
        </p>
        <p id="listing-daily-rate-help" className={group.help}>
          What one day costs. Renters see this with our fee already added, because the
          law requires the price shown to be the price paid — you will see both figures
          once you save.
        </p>

        <p>
          <label htmlFor="listing-weekend-rate">Weekend rate (£)</label>
          <input
            id="listing-weekend-rate"
            name="weekendRate"
            type="text"
            inputMode="decimal"
            defaultValue={state.weekendRate}
            placeholder="30.00"
            aria-describedby="listing-weekend-rate-help"
          />
        </p>
        <p id="listing-weekend-rate-help" className={group.help}>
          Friday to Sunday as one charge. Optional, and it needs a daily rate beside it.
        </p>

        <p>
          <label htmlFor="listing-weekly-rate">Weekly rate (£)</label>
          <input
            id="listing-weekly-rate"
            name="weeklyRate"
            type="text"
            inputMode="decimal"
            defaultValue={state.weeklyRate}
            placeholder="90.00"
            aria-describedby="listing-weekly-rate-help"
          />
        </p>
        <p id="listing-weekly-rate-help" className={group.help}>
          Seven days as one charge. Optional, and it needs a daily rate beside it.
        </p>
      </fieldset>

      {chosen === undefined ? (
        // No dead controls: until a category is chosen there are no
        // category-specific fields to show, and inventing empty ones would ask
        // questions nobody has posed.
        <p className={group.placeholder}>
          Choose a category above to see the details it asks for.
        </p>
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

      {/*
        The collection address, outside the category block on purpose: every
        item is somewhere, whatever category it is in, and nothing here comes
        from configuration.

        Below the category's own fields rather than above them because it is the
        one part of this form that asks about the owner rather than the item, and
        the explanation of what gets published needs to be read before it is
        filled in — not scrolled past on the way to the title.
      */}
      <fieldset className={group.card}>
        <legend className={group.legend}>
          <span className={group.badge}>Where it is collected from</span>
        </legend>

        <p id="listing-location-help" className={group.help}>
          Renters only ever see the <strong>district and town</strong> — “BS7, Bristol”
          — which covers thousands of homes. Your full postcode and street are never
          shown publicly and are given to a renter only once a booking reaches the point
          of collection. You can leave this blank for now, but a listing needs it before
          it can be published.
        </p>

        <p>
          <label htmlFor="listing-line1">Address line 1</label>
          <input
            id="listing-line1"
            name="line1"
            type="text"
            maxLength={ADDRESS_LINE_MAX_LENGTH}
            autoComplete="address-line1"
            defaultValue={state.line1}
            aria-describedby="listing-location-help"
          />
        </p>

        <p>
          <label htmlFor="listing-line2">Address line 2</label>
          <input
            id="listing-line2"
            name="line2"
            type="text"
            maxLength={ADDRESS_LINE_MAX_LENGTH}
            autoComplete="address-line2"
            defaultValue={state.line2}
          />
        </p>

        <p>
          <label htmlFor="listing-town">Town or city</label>
          <input
            id="listing-town"
            name="town"
            type="text"
            maxLength={TOWN_MAX_LENGTH}
            autoComplete="address-level2"
            defaultValue={state.town}
            aria-describedby="listing-town-help"
          />
        </p>
        <p id="listing-town-help" className={group.help}>
          This one is public, beside the postcode district.
        </p>

        <p>
          <label htmlFor="listing-postcode">Postcode</label>
          <input
            id="listing-postcode"
            name="postcode"
            type="text"
            autoComplete="postal-code"
            defaultValue={state.postcode}
            onChange={(event) => setPostcode(event.target.value)}
            placeholder="BS7 8AA"
            aria-describedby="listing-postcode-help"
          />
        </p>
        <p id="listing-postcode-help" className={group.help}>
          <OutwardCodePreview postcode={postcode} />
        </p>
      </fieldset>

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save draft'}
        </button>
      </p>
    </form>
  );
}
