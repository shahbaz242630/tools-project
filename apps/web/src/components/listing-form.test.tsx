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
    line1: '',
    line2: '',
    town: '',
    postcode: '',
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
    // The launch category's real bands, and it has a `weight_kg` attribute
    // above — so this fixture is the one that can suggest.
    transportOptions: [
      { requirement: 'car_boot', suggestedUpToKg: 25 },
      { requirement: 'van_required', suggestedUpToKg: 150 },
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
    // Offers none, deliberately: it is the "asks nothing about collection"
    // branch, which every category configured before slice 2.4c-i is in.
    transportOptions: [],
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

  it('takes them there again on a second, identical failure', () => {
    // The half slice 2.4b missed, found by pressing Save twice in a browser with
    // the same bad value. Two identical failures produce the same string, so an
    // effect keyed on the *message* compares equal and never runs again — the
    // page then sits perfectly still on the second press, which is precisely
    // when somebody decides the form is broken.
    withState({ status: 'error', message: 'That did not save.' });
    const { rerender } = render(<ListingForm categories={CATEGORIES} />);
    (document.activeElement as HTMLElement).blur();

    // A fresh state object carrying the same words, which is what
    // `useActionState` hands back when the same save is refused twice.
    state.current = { ...state.current };
    rerender(<ListingForm categories={CATEGORIES} />);

    expect(document.activeElement).toBe(screen.getByRole('alert'));
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
          {
            slug: 'plain',
            name: 'Plain',
            versionNumber: 1,
            attributes: [],
            transportOptions: [],
          },
        ]}
      />,
    );
    choose('plain');

    expect(screen.getByText(/asks for no extra details/i)).toBeTruthy();
    expect(submitted()).toEqual({});
  });
});

describe('the transport requirement', () => {
  /** The select the category's options are rendered into. */
  const field = () => screen.queryByLabelText(/What is needed to collect it/i);

  const weigh = (value: string) => {
    fireEvent.change(screen.getByLabelText(/Weight \(kg\)/i), {
      target: { value },
    });
  };

  it('asks nothing when the category offers no options', () => {
    // No dead control: an empty select would invite an answer that cannot be
    // given, and the API would refuse any value for such a category.
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('cleaning-floorcare');

    expect(field()).toBeNull();
  });

  it('offers only what the category offers', () => {
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    // Two of the platform's five, because that is what this category configured.
    expect(screen.getByRole('option', { name: /Car boot/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Van or large vehicle/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Trailer/ })).toBeNull();
  });

  it('starts unanswered, because a draft may be', () => {
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    expect((field() as HTMLSelectElement).value).toBe('');
  });

  it('suggests a band once a weight is typed', () => {
    // §8.3: the weight drives a suggested default rather than being asked twice.
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    weigh('12.5');

    expect((field() as HTMLSelectElement).value).toBe('car_boot');
  });

  it('moves the suggestion up as the weight grows', () => {
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    weigh('12.5');
    weigh('90');

    expect((field() as HTMLSelectElement).value).toBe('van_required');
  });

  it('says the answer came from the weight rather than from the owner', () => {
    // A field that filled itself in silently is one somebody submits without
    // reading — and this one is a promise to a stranger about what to arrive in.
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    weigh('12.5');

    expect(screen.getByRole('status').textContent).toMatch(
      /suggested from the weight/i,
    );
  });

  it('stops suggesting once the owner chooses for themselves', () => {
    // The important one. A suggestion that kept reasserting itself would drag
    // the answer back every time the weight was corrected.
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    weigh('12.5');

    fireEvent.change(field() as HTMLElement, { target: { value: 'van_required' } });
    weigh('9');

    expect((field() as HTMLSelectElement).value).toBe('van_required');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('lets the owner go back to unanswered', () => {
    // Choosing the empty option must clear the choice rather than hand control
    // back to the suggestion, or "no answer yet" would be unreachable.
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    weigh('12.5');
    fireEvent.change(field() as HTMLElement, { target: { value: 'van_required' } });

    fireEvent.change(field() as HTMLElement, { target: { value: '' } });

    // Back to the suggestion, which is what an unanswered field shows.
    expect((field() as HTMLSelectElement).value).toBe('car_boot');
  });

  it('suggests nothing while the weight is half typed', () => {
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    weigh('12.');

    expect((field() as HTMLSelectElement).value).toBe('');
  });

  it('forgets the choice when the category changes', () => {
    // Two categories offer different options, so a choice carried across could
    // be one the new category does not offer — refused by the API, about a field
    // the owner never touched.
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    weigh('12.5');
    fireEvent.change(field() as HTMLElement, { target: { value: 'van_required' } });

    choose('cleaning-floorcare');
    choose('outdoor-gardening');

    expect((field() as HTMLSelectElement).value).toBe('');
  });

  it('keeps a ticked two-person lift through the form reset React does after an action', () => {
    // The defect slice 2.4c-i found on the admin form, in the place it would
    // have arrived next: a refused save would otherwise discard something the
    // owner stated about their own item.
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    const lift = screen.getByLabelText(/It takes two people to lift/i);
    fireEvent.click(lift);
    (document.querySelector('form') as HTMLFormElement).reset();

    expect((lift as HTMLInputElement).checked).toBe(true);
  });
});

describe('the collection address', () => {
  it('is asked for whatever the category, because every item is somewhere', () => {
    // Outside the category block on purpose: nothing here comes from
    // configuration, so it renders before a category has been chosen.
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);

    expect(screen.getByLabelText(/Address line 1/i)).toBeTruthy();
    expect(screen.getByLabelText(/Postcode/i)).toBeTruthy();
  });

  it('says what a renter will actually see, before it is filled in', () => {
    // BRD §10.1's spirit on the profile page, applied here: this is the moment
    // somebody decides whether to type their home address into a marketplace,
    // and the answer to "who sees this" has to be above the field rather than
    // in a policy.
    withState({ status: 'idle', message: null });
    const { container } = render(<ListingForm categories={CATEGORIES} />);

    // Read through `aria-describedby` rather than by finding the text
    // anywhere on the page: the assertion worth making is that the explanation
    // is *attached to the field*, which is what makes a screen reader announce
    // it when somebody lands there rather than leaving it as decoration.
    const describedBy = screen
      .getByLabelText(/Address line 1/i)
      .getAttribute('aria-describedby');
    const help = container.querySelector(`#${String(describedBy)}`);

    expect(help?.textContent).toMatch(/district and town/i);
    expect(help?.textContent).toMatch(/never shown publicly/i);
  });

  it('does not demand one, because a draft holds progress', () => {
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);

    // No `required`. §8.3 lets an owner save progress, and publication is where
    // completeness is enforced (2.8) — an HTML `required` here would refuse to
    // save a draft.
    expect(screen.getByLabelText(/Address line 1/i).hasAttribute('required')).toBe(
      false,
    );
    expect(screen.getByLabelText(/Postcode/i).hasAttribute('required')).toBe(false);
  });

  it('keeps what was typed when the save is refused', () => {
    // A refusal about a title must not empty an address somebody has just
    // written out. The state carries all four back, and the inputs read them
    // from `defaultValue`.
    withState({
      status: 'error',
      message: 'Title must be at least 3 characters',
      line1: '12 Gloucester Road',
      town: 'Bristol',
      postcode: 'BS7 8AA',
    });
    render(<ListingForm categories={CATEGORIES} />);

    expect((screen.getByLabelText(/Address line 1/i) as HTMLInputElement).value).toBe(
      '12 Gloucester Road',
    );
    expect((screen.getByLabelText(/Postcode/i) as HTMLInputElement).value).toBe(
      'BS7 8AA',
    );
  });
});

/**
 * The form reset React performs after a settled action, applied to every
 * control this form has.
 *
 * 2.4c-i found it on a checkbox and concluded "controlled `value` inputs are
 * unaffected; React re-applies those". These tests exist to find out how far
 * that is actually true, because a `<select value=…>` is a controlled value
 * input and a reset has nothing to restore it to — no `<option>` carries
 * `selected`, so the browser falls back to the first one.
 */
describe('what survives the form reset React does after an action', () => {
  /**
   * A reset, then the microtask that restores the selects.
   *
   * `reset` fires *before* the controls are restored, so `ResetSafeSelect`
   * re-applies in a microtask immediately after. Awaiting one here is what a
   * browser gives for free.
   */
  const reset = async () => {
    (document.querySelector('form') as HTMLFormElement).reset();
    await Promise.resolve();
  };

  it('keeps the chosen category', async () => {
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');

    await reset();

    // The worst version of this defect: the category's own fields stay on
    // screen and the hidden version number stays set, so the form goes on
    // posting a version for a category the select no longer names.
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe(
      'outdoor-gardening',
    );
  });

  it('keeps a chosen transport requirement', async () => {
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    fireEvent.change(screen.getByLabelText(/What is needed to collect it/i), {
      target: { value: 'van_required' },
    });

    await reset();

    expect(
      (screen.getByLabelText(/What is needed to collect it/i) as HTMLSelectElement)
        .value,
    ).toBe('van_required');
  });

  it('keeps an answer to a category’s own choice field', async () => {
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    fireEvent.change(screen.getByLabelText(/Power source/i), {
      target: { value: 'petrol' },
    });

    await reset();

    expect((screen.getByLabelText(/Power source/i) as HTMLSelectElement).value).toBe(
      'petrol',
    );
  });

  it('keeps an answer to a category’s own text field', async () => {
    withState({ status: 'idle', message: null });
    render(<ListingForm categories={CATEGORIES} />);
    choose('outdoor-gardening');
    fireEvent.change(screen.getByLabelText(/Condition notes/i), {
      target: { value: 'Blade recently sharpened' },
    });

    await reset();

    expect((screen.getByLabelText(/Condition notes/i) as HTMLInputElement).value).toBe(
      'Blade recently sharpened',
    );
  });
});
