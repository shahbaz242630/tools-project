import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CategoryOption, OwnerListing } from '@platform/contracts';

// The action is a server action; the form only needs it to exist to bind and
// render. What it does is covered where it lives.
vi.mock('../app/listings/[id]/edit/actions', () => ({
  editListingAction: vi.fn(),
}));

const { ListingEditForm } = await import('./listing-edit-form');

/**
 * The edit form (slice 2.9b-i, ADR 0042).
 *
 * **What matters here is what the form opens showing.** An edit form that opened
 * blank would be a way to delete a description by pressing Save, and the failure
 * is silent — every field is legal empty, and the loss only shows on the listing
 * page afterwards.
 */

const CATEGORY: CategoryOption = {
  slug: 'outdoor-gardening',
  name: 'Outdoor and gardening',
  versionNumber: 3,
  transportOptions: [],
  attributes: [
    {
      key: 'weight_kg',
      label: 'Weight',
      required: true,
      type: 'number',
      unit: 'kg',
      decimalPlaces: 1,
    },
  ],
};

function listing(over: Partial<OwnerListing> = {}): OwnerListing {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    categorySlug: 'outdoor-gardening',
    categoryName: 'Outdoor and gardening',
    categoryVersionNumber: 1,
    categoryAttributes: [],
    title: 'Petrol lawn scarifier',
    description: 'Serviced last spring.',
    replacementValue: { amount: 38_900, currency: 'GBP' },
    attributes: { weight_kg: 385 },
    transportRequirement: null,
    requiresTwoPersonLift: true,
    collectionLocation: null,
    isLocated: false,
    rates: {
      daily: { amount: 2_200, currency: 'GBP' },
      weekend: null,
      weekly: { amount: 9_000, currency: 'GBP' },
    },
    inclusiveDailyPrice: null,
    status: 'DRAFT',
    moderationState: 'APPROVED',
    moderationReason: null,
    publicationAvailable: true,
    createdAt: '2026-08-07T09:00:00.000Z',
    updatedAt: '2026-08-07T09:00:00.000Z',
    ...over,
  };
}

function value(label: RegExp): string {
  return (screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).value;
}

describe('what the form opens showing', () => {
  it('fills every field from the listing rather than opening blank', () => {
    render(<ListingEditForm listing={listing()} category={CATEGORY} />);

    expect(value(/Title/)).toBe('Petrol lawn scarifier');
    expect(value(/Description/)).toBe('Serviced last spring.');
  });

  it('shows money in pounds, not the pence it is stored in', () => {
    // £389.00 is stored as 38900. Showing the minor units would be a factor of a
    // hundred, and saving it back would multiply the replacement value — which
    // §8.7.1 turns into a damage excess held on somebody's card.
    render(<ListingEditForm listing={listing()} category={CATEGORY} />);

    expect(value(/Replacement value/)).toBe('389.00');
    expect(value(/Daily rate/)).toBe('22.00');
  });

  it('leaves an unset rate blank rather than showing a zero', () => {
    // Blank is what "not priced" submits as. A `0.00` would be a price somebody
    // never set, offered back to them as though they had.
    render(<ListingEditForm listing={listing()} category={CATEGORY} />);

    expect(value(/Weekend rate/)).toBe('');
    expect(value(/Weekly rate/)).toBe('90.00');
  });

  it('unscales a stored attribute to the decimal that was typed', () => {
    // The round trip `toStoredAnswers` exists for, asserted through the form so
    // that wiring it up wrongly fails here rather than only in the unit test.
    render(<ListingEditForm listing={listing()} category={CATEGORY} />);

    expect(value(/Weight/)).toBe('38.5');
  });

  it('carries the current version, not the one the listing pinned', () => {
    /*
     * **ADR 0042 in one assertion.** The listing is on version 1 and the category
     * is on 3; the form is drawn from 3 and says so, because saving brings the
     * listing onto 3. Posting the listing's own pinned number instead would tell
     * the server the form was built from a schema it was not.
     */
    const { container } = render(
      <ListingEditForm listing={listing()} category={CATEGORY} />,
    );

    const hidden = container.querySelector('input[name="categoryVersionNumber"]');
    expect(hidden?.getAttribute('value')).toBe('3');
  });

  it('says the collection address cannot be changed here', () => {
    // Stated rather than left as a missing field: the create form asks for an
    // address and this one does not, and an owner who noticed would reasonably
    // conclude theirs had been lost.
    render(<ListingEditForm listing={listing()} category={CATEGORY} />);

    expect(document.body.textContent).toContain('cannot be changed here yet');
    expect(document.body.textContent).toContain('unchanged');
  });

  it('renders the category’s current fields, not the listing’s pinned ones', () => {
    // The listing's own `categoryAttributes` is empty in the fixture. If the form
    // read that, there would be no weight field at all — and saving would clear
    // an answer the owner never saw.
    render(<ListingEditForm listing={listing()} category={CATEGORY} />);

    expect(screen.getByLabelText(/Weight/)).toBeTruthy();
  });
});
