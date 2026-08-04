import { fireEvent, render, screen } from '@testing-library/react';
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

/**
 * Two categories with deliberately different shapes.
 *
 * The first exercises all four types; the second has one attribute and shares no
 * key with it. Nothing in the component knows either of them exists, which is
 * the property under test — BRD §14's Phase 2 exit gate.
 */
const CATEGORIES: readonly CategoryOption[] = [
  {
    slug: 'outdoor-gardening',
    name: 'Outdoor and gardening',
    versionNumber: 3,
    attributes: [
      {
        key: 'power_source',
        label: 'Power source',
        required: true,
        type: 'choice',
        options: [
          { value: 'petrol', label: 'Petrol' },
          { value: 'cordless', label: 'Cordless battery' },
        ],
      },
      {
        key: 'weight_kg',
        label: 'Weight',
        required: true,
        type: 'number',
        unit: 'kg',
        decimalPlaces: 1,
      },
      {
        key: 'condition_notes',
        label: 'Condition notes',
        required: false,
        type: 'text',
        maxLength: 200,
      },
      {
        key: 'accessories',
        label: 'Accessories',
        required: false,
        type: 'choice-many',
        options: [
          { value: 'case', label: 'Carry case' },
          { value: 'blade', label: 'Spare blade' },
        ],
      },
    ],
  },
  {
    slug: 'cleaning-floorcare',
    name: 'Cleaning and floorcare',
    versionNumber: 1,
    attributes: [
      {
        key: 'tank_litres',
        label: 'Tank size',
        required: false,
        type: 'number',
        unit: 'l',
        decimalPlaces: 0,
      },
    ],
  },
];

function withState(next: Partial<typeof state.current>) {
  state.current = { ...state.current, ...next };
}

/** Choose a category, which is what makes its fields appear. */
function choose(slug: string) {
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: slug } });
}

function hidden(name: string): HTMLInputElement | null {
  return document.querySelector(`input[name="${name}"]`);
}

function submitted(): unknown {
  return JSON.parse(hidden('attributes')?.value ?? 'null');
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

  it('takes the reader to the failure rather than leaving them at the button', () => {
    // The message is at the top of the form and the button is at the bottom,
    // and the category's own fields made that gap long. Pressing Save and
    // seeing nothing move reads as a form that does nothing — which is exactly
    // how this looked the first time it was opened in a browser.
    withState({ status: 'error', message: 'That did not save.' });
    render(<ListingForm categories={CATEGORIES} />);

    const alert = screen.getByRole('alert');
    expect(document.activeElement).toBe(alert);
    // Focusable, but not in the tab order — it is a message, not a control.
    expect(alert.getAttribute('tabindex')).toBe('-1');
  });

  it('scrolls as well as focuses, so a second failure in a row still moves', () => {
    // `focus()` scrolls only when the element is not already focused, and React
    // reuses the node between two failures — so the second one left the page
    // completely still. Found by failing twice in a browser.
    const scrolled: unknown[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(options?: unknown) {
      scrolled.push(options);
    };

    withState({ status: 'error', message: 'That did not save either.' });
    render(<ListingForm categories={CATEGORIES} />);

    expect(scrolled).toEqual([{ block: 'center' }]);
  });

  it('says the button saves a draft rather than publishing', () => {
    withState({ status: 'idle', message: null, title: '', replacementValue: '' });
    render(<ListingForm categories={CATEGORIES} />);

    expect(screen.getByRole('button', { name: /save draft/i })).toBeTruthy();
  });
});

/**
 * The Phase 2 exit gate, asserted.
 *
 * *"A new category can be added by configuration, and a listing renders its
 * category-specific fields without frontend code changes for every field."*
 * Every test below drives fields this file's component has never heard of.
 */
describe('the fields a category asks for', () => {
  it('shows none until a category is chosen, and says so', () => {
    withState({ status: 'idle', message: null, categorySlug: '' });
    render(<ListingForm categories={CATEGORIES} />);

    expect(screen.queryByLabelText(/Power source/)).toBeNull();
    expect(screen.getByText(/choose a category above/i)).toBeTruthy();
  });

  it('renders one control per type, drawn from configuration alone', () => {
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    // choice → a select offering the configured options
    const choice = screen.getByLabelText(/Power source/) as HTMLSelectElement;
    expect(choice.tagName).toBe('SELECT');
    expect(screen.getByRole('option', { name: 'Cordless battery' })).toBeTruthy();

    // number → text with a numeric input mode, never type="number"
    const number = screen.getByLabelText(/Weight/) as HTMLInputElement;
    expect(number.type).toBe('text');
    expect(number.getAttribute('inputMode')).toBe('decimal');

    // text → an input capped at the configured length
    const text = screen.getByLabelText(/Condition notes/) as HTMLInputElement;
    expect(text.maxLength).toBe(200);

    // choice-many → one checkbox per option
    expect((screen.getByLabelText('Carry case') as HTMLInputElement).type).toBe(
      'checkbox',
    );
    expect(screen.getByLabelText('Spare blade')).toBeTruthy();
  });

  it('offers no answer as the starting point of a single choice', () => {
    // Without an empty option a select silently answers the question with
    // whichever option happens to be first.
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    expect((screen.getByLabelText(/Power source/) as HTMLSelectElement).value).toBe('');
  });

  it('does not make a required attribute stop the draft saving', () => {
    // §8.3: a draft holds progress. `required` means required to *publish*, and
    // the wording says so rather than contradicting the button.
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    expect((screen.getByLabelText(/Weight/) as HTMLInputElement).required).toBe(false);
    expect(screen.getAllByText(/needed before you can publish/i).length).toBe(2);
  });

  it('posts the answers as one JSON value, keyed by attribute key', () => {
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    fireEvent.change(screen.getByLabelText(/Power source/), {
      target: { value: 'petrol' },
    });
    fireEvent.change(screen.getByLabelText(/Weight/), { target: { value: '5.2' } });
    fireEvent.click(screen.getByLabelText('Spare blade'));

    expect(submitted()).toEqual({
      power_source: 'petrol',
      weight_kg: '5.2',
      accessories: ['blade'],
    });
  });

  it('sends a number as the text that was typed, not as a number', () => {
    // The scale is category configuration, so the conversion belongs on the
    // server — a client sending an already-scaled integer would be supplying
    // both the value and what the value means.
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    fireEvent.change(screen.getByLabelText(/Weight/), { target: { value: '5.2' } });

    expect((submitted() as { weight_kg: unknown }).weight_kg).toBe('5.2');
  });

  it('leaves an unanswered field out rather than sending an empty answer', () => {
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    fireEvent.change(screen.getByLabelText(/Condition notes/), {
      target: { value: '   ' },
    });

    // One representation of "not answered", and blank is not an answer.
    expect(submitted()).toEqual({});
  });

  it('keeps ticked choices in the schema order, whatever order they were ticked', () => {
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    fireEvent.click(screen.getByLabelText('Spare blade'));
    fireEvent.click(screen.getByLabelText('Carry case'));

    expect((submitted() as { accessories: string[] }).accessories).toEqual([
      'case',
      'blade',
    ]);
  });

  it('unticks', () => {
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    fireEvent.click(screen.getByLabelText('Carry case'));
    fireEvent.click(screen.getByLabelText('Carry case'));

    expect(submitted()).toEqual({});
  });

  it('states the version the fields came from', () => {
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    expect(hidden('categoryVersionNumber')?.value).toBe('3');
  });

  it('swaps the whole field set when the category changes, and keeps nothing', () => {
    // Answers are keyed by attribute key and two categories rarely mean the
    // same thing by one — carrying them across would submit answers to
    // questions that were never asked.
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    fireEvent.change(screen.getByLabelText(/Weight/), { target: { value: '5.2' } });

    choose('cleaning-floorcare');

    expect(screen.queryByLabelText(/Power source/)).toBeNull();
    expect(screen.getByLabelText(/Tank size/)).toBeTruthy();
    expect(submitted()).toEqual({});
    expect(hidden('categoryVersionNumber')?.value).toBe('1');
  });

  it('says a category with no attributes asks for nothing, rather than showing an empty box', () => {
    render(
      <ListingForm
        categories={[
          { slug: 'plain', name: 'Plain', versionNumber: 1, attributes: [] },
        ]}
      />,
    );
    choose('plain');

    expect(screen.getByText(/asks for no extra details/i)).toBeTruthy();
    expect(submitted()).toEqual({});
  });
});
