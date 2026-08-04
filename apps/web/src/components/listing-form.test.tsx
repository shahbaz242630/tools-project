import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CategoryOption } from '@platform/contracts';

/**
 * The listing form.
 *
 * The server action is mocked, as in every other form test here — it imports
 * `@clerk/nextjs/server` and `next/headers`. What is asserted is the form's
 * contract with the owner using it, and one property that is not cosmetic at
 * all: the replacement value must not be a `type="number"` input.
 */
const state = vi.hoisted(() => ({
  current: {
    status: 'idle' as 'idle' | 'error',
    message: null as string | null,
    categorySlug: '',
    title: '',
    description: '',
    replacementValue: '',
  },
}));

vi.mock('../app/listings/new/actions', () => ({ createListingAction: vi.fn() }));

// The initial state lives outside the `'use server'` file — see `state.ts`.
vi.mock('../app/listings/new/state', () => ({ INITIAL_LISTING_STATE: state.current }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { ListingForm } = await import('./listing-form');

const CATEGORIES: readonly CategoryOption[] = [
  { slug: 'outdoor-gardening', name: 'Outdoor and gardening' },
  { slug: 'cleaning-floorcare', name: 'Cleaning and floorcare' },
];

function withState(next: Partial<typeof state.current>) {
  state.current = { ...state.current, ...next };
}

describe('ListingForm', () => {
  it('offers every category it was given', () => {
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);

    expect(screen.getByRole('option', { name: 'Outdoor and gardening' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Cleaning and floorcare' })).toBeTruthy();
  });

  it('starts with no category chosen, so nothing is picked by accident', () => {
    render(<ListingForm categories={CATEGORIES} />);

    const select = screen.getByLabelText('Category') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.required).toBe(true);
  });

  it('does not use a number input for money', () => {
    // **The assertion that matters most in this file.** `type="number"` hands
    // back a JavaScript number, and a float is exactly what must never touch
    // money (ADR 0002). The value has to reach `Money.fromMajor` as the string
    // the owner typed.
    render(<ListingForm categories={CATEGORIES} />);

    const value = screen.getByLabelText('Replacement value (£)') as HTMLInputElement;
    expect(value.type).toBe('text');
    expect(value.getAttribute('inputMode')).toBe('decimal');
  });

  it('says what the replacement value is for, and what it is not', () => {
    // An owner who thinks this is the rental price will enter something absurd,
    // and §8.7.1 turns it into a damage excess held on a renter's card.
    render(<ListingForm categories={CATEGORIES} />);

    const help = screen.getByText(/what it would cost you to replace/i);
    expect(help.textContent).toMatch(/not the rental price/i);
  });

  it('does not demand a description, and says why', () => {
    // §8.3: a draft holds progress. Requiring prose before saving is what makes
    // people abandon the form.
    render(<ListingForm categories={CATEGORIES} />);

    const description = screen.getByLabelText('Description') as HTMLTextAreaElement;
    expect(description.required).toBe(false);
    expect(screen.getByText(/optional while this is a draft/i)).toBeTruthy();
  });

  it('tells the owner the category is recorded as it stands today', () => {
    // The pin, in words somebody who has never heard of a version can use.
    render(<ListingForm categories={CATEGORIES} />);

    expect(screen.getByText(/recorded as it stands today/i)).toBeTruthy();
  });

  it('shows a failure without clearing what was typed', () => {
    withState({
      status: 'error',
      message: 'Replacement value must be an amount in pounds, such as 249.99.',
      title: 'Petrol hedge trimmer',
      replacementValue: '£249.99',
    });
    render(<ListingForm categories={CATEGORIES} />);

    expect(screen.getByRole('alert').textContent).toMatch(/amount in pounds/i);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
      'Petrol hedge trimmer',
    );
    expect(
      (screen.getByLabelText('Replacement value (£)') as HTMLInputElement).value,
    ).toBe('£249.99');
  });

  it('says the button saves a draft rather than publishing', () => {
    withState({ status: 'idle', message: null, title: '', replacementValue: '' });
    render(<ListingForm categories={CATEGORIES} />);

    expect(screen.getByRole('button', { name: /save draft/i })).toBeTruthy();
  });
});
