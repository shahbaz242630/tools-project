'use client';

import { useActionState } from 'react';
import {
  LISTING_DESCRIPTION_MAX_LENGTH,
  LISTING_TITLE_MAX_LENGTH,
  LISTING_TITLE_MIN_LENGTH,
} from '@platform/contracts';
import type { CategoryOption } from '@platform/contracts';
import { createListingAction } from '../app/listings/new/actions';
import { INITIAL_LISTING_STATE } from '../app/listings/new/state';

/**
 * Creating a draft listing.
 *
 * The form deliberately asks for very little. §8.3 says owners "create draft
 * listings and save progress", and everything else a listing eventually needs —
 * location, prices, photographs, availability — arrives in later slices. A form
 * that asked for all of it at once is the form people abandon.
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

  return (
    <form action={action}>
      {state.message === null ? null : <p role="alert">{state.message}</p>}

      <p>
        <label htmlFor="listing-category">Category</label>
        <select
          id="listing-category"
          name="categorySlug"
          required
          defaultValue={state.categorySlug}
          aria-describedby="listing-category-help"
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

      <p>
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save draft'}
        </button>
      </p>
    </form>
  );
}
