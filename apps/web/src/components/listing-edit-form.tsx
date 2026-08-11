'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  LISTING_DESCRIPTION_MAX_LENGTH,
  LISTING_TITLE_MAX_LENGTH,
  LISTING_TITLE_MIN_LENGTH,
  readItemWeight,
} from '@platform/contracts';
import type {
  CategoryOption,
  OwnerListing,
  TransportRequirement,
} from '@platform/contracts';
import { editListingAction } from '../app/listings/[id]/edit/actions';
import { editStateFrom } from '../app/listings/[id]/edit/state';
import { AttributeFields, toSubmittedAttributes } from './attribute-fields';
import type { AttributeAnswers } from './attribute-fields';
import { TransportField } from './transport-field';
import { toStoredAnswers } from '../lib/stored-answers';

/**
 * Editing a listing (slice 2.9b-i, ADR 0042).
 *
 * **A second form rather than `ListingForm` parameterised**, and the reason is
 * that the two collect different things rather than the same things differently.
 * This one has no category picker (a listing's category is fixed at creation, and
 * the create form has said so since 2.4a) and no address fields (2.9b-ii). A
 * shared component would carry two conditionals through every field it renders,
 * and the failure mode of getting one wrong is a control that silently does not
 * post.
 *
 * What they *do* share is shared: `AttributeFields` and `TransportField` are the
 * two pieces where drift would actually cost something, because those are the
 * category-configured ones.
 *
 * **The schema rendered here is the category's current one, not the listing's
 * pinned one** — ADR 0042's fourth point. Saving brings the listing onto that
 * configuration, which is only honest because the current questions are what is
 * on screen. Rendering the pinned schema and then pinning the current one is the
 * silent orphaning ADR 0029 rejected, arriving through a different door.
 */
export function ListingEditForm({
  listing,
  category,
}: {
  readonly listing: OwnerListing;
  /**
   * The category **as it stands now**, which is what the fields are drawn from.
   *
   * Null when the listing's category is no longer offered — see the page, which
   * refuses to render the form at all rather than drawing one from a schema it
   * does not have.
   */
  readonly category: CategoryOption;
}) {
  const [state, action, pending] = useActionState(
    editListingAction.bind(null, listing.id),
    editStateFrom(listing),
  );

  /*
   * **Seeded from what is stored, mapped onto the current schema.**
   * `toStoredAnswers` is the exact inverse of what the API does on the way in,
   * which it has to be: an owner who opens this form and presses Save without
   * touching anything must not change their own data, and nothing would catch it
   * if they did — the value is legal either way.
   */
  const [answers, setAnswers] = useState<AttributeAnswers>(() =>
    toStoredAnswers(category.attributes, listing.attributes),
  );
  const [transport, setTransport] = useState<TransportRequirement | null>(
    listing.transportRequirement,
  );
  const [twoPersonLift, setTwoPersonLift] = useState(listing.requiresTwoPersonLift);

  const weight = readItemWeight(category.attributes, answers);

  /*
   * Put the failure where the person is looking — `ListingForm`'s rule, and the
   * dependency is the **whole state object** rather than `state.message` for the
   * reason recorded there: two identical failures produce the same string, a
   * dependency on the string compares equal, and the effect never runs again.
   */
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.message === null) return;
    alert.current?.focus({ preventScroll: true });
    alert.current?.scrollIntoView?.({ block: 'center' });
  }, [state]);

  return (
    <form action={action}>
      {state.message === null ? null : (
        <p role="alert" ref={alert} tabIndex={-1}>
          {state.message}
        </p>
      )}

      {/*
        The version the form was built from, asserted rather than chosen. The
        server still pins whatever is current when it writes; this says what was
        on screen, so a reconfiguration that landed while this page sat open is
        *noticed* rather than silently accepted (ADR 0029).
      */}
      <input
        type="hidden"
        name="categoryVersionNumber"
        value={category.versionNumber}
      />

      <p>
        <label htmlFor="edit-title">Title</label>
        <input
          id="edit-title"
          name="title"
          type="text"
          required
          minLength={LISTING_TITLE_MIN_LENGTH}
          maxLength={LISTING_TITLE_MAX_LENGTH}
          defaultValue={state.title}
        />
      </p>

      <p>
        <label htmlFor="edit-description">Description</label>
        <textarea
          id="edit-description"
          name="description"
          rows={5}
          maxLength={LISTING_DESCRIPTION_MAX_LENGTH}
          defaultValue={state.description}
          aria-describedby="edit-description-help"
        />
      </p>
      <p id="edit-description-help">
        It has to say something before this listing can be published.
      </p>

      <p>
        <label htmlFor="edit-replacement-value">Replacement value (£)</label>
        <input
          id="edit-replacement-value"
          name="replacementValue"
          type="text"
          inputMode="decimal"
          required
          defaultValue={state.replacementValue}
          aria-describedby="edit-replacement-value-help"
        />
      </p>
      <p id="edit-replacement-value-help">
        What it would cost to replace if it were damaged beyond repair. This is not the
        rental price.
      </p>

      <AttributeFields
        attributes={category.attributes}
        answers={answers}
        onChange={(key, value) => {
          setAnswers((held) => ({ ...held, [key]: value }));
        }}
        idPrefix="edit-attr"
      />
      {/*
        The answers travel as one JSON value rather than as indexed field names,
        matching the create form — the API is what decides which keys are legal,
        reading the schema on the version it is about to pin.
      */}
      <input
        type="hidden"
        name="attributes"
        value={JSON.stringify(toSubmittedAttributes(category.attributes, answers))}
      />

      <TransportField
        options={category.transportOptions}
        weight={weight}
        chosen={transport}
        onChange={setTransport}
        requiresTwoPersonLift={twoPersonLift}
        onLiftChange={setTwoPersonLift}
        idPrefix="edit-transport"
      />

      <fieldset>
        <legend>What it costs to rent</legend>
        <p>
          <label htmlFor="edit-daily-rate">Daily rate (£)</label>
          <input
            id="edit-daily-rate"
            name="dailyRate"
            type="text"
            inputMode="decimal"
            defaultValue={state.dailyRate}
          />
        </p>
        <p>
          <label htmlFor="edit-weekend-rate">Weekend rate (£)</label>
          <input
            id="edit-weekend-rate"
            name="weekendRate"
            type="text"
            inputMode="decimal"
            defaultValue={state.weekendRate}
          />
        </p>
        <p>
          <label htmlFor="edit-weekly-rate">Weekly rate (£)</label>
          <input
            id="edit-weekly-rate"
            name="weeklyRate"
            type="text"
            inputMode="decimal"
            defaultValue={state.weeklyRate}
          />
        </p>
        <p>
          The weekend and weekly rates are alternatives to the daily rate, so they need
          one beside them. Renters always see a total with our fee included.
        </p>
      </fieldset>

      {/*
        **Said plainly rather than left as a missing field.** The create form asks
        where the item is collected from and this one does not, and an owner who
        noticed would reasonably conclude the address had been lost. It has not —
        changing it needs the fuzz offset preserved rather than redrawn (§8.4.1),
        which is its own slice.
      */}
      <p>
        Where this is collected from cannot be changed here yet. Everything you set for
        it is unchanged, and it stays exactly as it is when you save.
      </p>

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </p>
    </form>
  );
}
