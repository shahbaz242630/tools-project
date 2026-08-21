import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UNCONFIGURED_FEE_POLICY } from '@platform/contracts';
import type { AdminCategory } from '@platform/contracts';
import {
  DEFAULT_MAXIMUM_RENTAL_DAYS,
  DEFAULT_REQUEST_EXPIRY_HOURS,
  MAXIMUM_RENTAL_DAYS_WARNING,
  MAX_MAXIMUM_RENTAL_DAYS,
} from '@platform/contracts';

/** A priced category (BRD §8.2, §3.4, slice 2.7a). */
const FEE_POLICY = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' as const },
  minimumPlatformFee: { amount: 100, currency: 'GBP' as const },
};
/**
 * A real band rather than `null`, for `FEE_POLICY`'s reason applied to §8.7.2:
 * `null` is what a category carries when nobody has configured damage security,
 * so a suite where every fixture is null would never notice a path that silently
 * dropped the band. Tests that mean "no security" say so locally.
 */
const DAMAGE_SECURITY = {
  excessFloor: { amount: 7_500, currency: 'GBP' },
  excessPercentageBasisPoints: 1_500,
  recoveryCeiling: { amount: 50_000, currency: 'GBP' },
} as const;

/**
 * The reportable-activity control, which is the only part of these forms that
 * can change what the platform owes HMRC (§8.14.2).
 *
 * The server action is mocked, as in every other form test here — it imports
 * `@clerk/nextjs/server` and `next/headers`. What is being asserted is the
 * form's contract with the administrator using it: that the choice is
 * explained, that choosing a reportable head warns before the submit rather
 * than after it, and that the confirmation cannot be skipped.
 *
 * **The confirmation is a control on the server, not here.** These tests pin
 * that the person is told, not that they are stopped — the API is what stops
 * them, and `categories.integration.test.ts` is where that is proven.
 */
const state = vi.hoisted(() => ({
  current: {
    status: 'idle' as 'idle' | 'done' | 'error',
    message: null as string | null,
    slug: '',
    name: '',
    reason: '',
    reportableActivity: 'none' as AdminCategory['reportableActivity'],
  },
}));

vi.mock('../app/admin/categories/actions', () => ({
  INITIAL_CATEGORY_STATE: state.current,
  createCategoryAction: vi.fn(),
  reconfigureCategoryAction: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { CreateCategoryForm, ReconfigureCategoryForm } = await import('./category-form');

const CATEGORY: AdminCategory = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'outdoor-gardening',
  name: 'Outdoor and gardening',
  riskLevel: 'low',
  reportableActivity: 'none',
  attributes: [],
  feePolicy: FEE_POLICY,
  damageSecurity: DAMAGE_SECURITY,
  maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
  requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
  transportOptions: [],
  versionNumber: 1,
  versionCreatedAt: '2026-08-04T09:00:00.000Z',
  createdAt: '2026-08-04T09:00:00.000Z',
};

const select = () => screen.getByLabelText('Reportable activity');

const confirmation = () =>
  screen.queryByRole('checkbox', { name: /counsel has determined the scope/i });

describe('the reportable-activity field', () => {
  it('offers the choice on a new category', () => {
    render(<CreateCategoryForm />);
    expect(select()).toBeTruthy();
  });

  it('starts at none, because that is what renting out goods is', () => {
    render(<CreateCategoryForm />);
    expect((select() as HTMLSelectElement).value).toBe('none');
  });

  it('asks for no confirmation while the answer is none', () => {
    // The common case, and it must stay quiet. A tick box on every category —
    // almost all of which are `none` forever — is one an administrator learns
    // to tick without reading, and then it is worth nothing on the occasion it
    // matters.
    render(<CreateCategoryForm />);
    expect(confirmation()).toBeNull();
  });

  it('warns as soon as a reportable head is chosen', () => {
    render(<CreateCategoryForm />);

    fireEvent.change(select(), { target: { value: 'means_of_transport' } });

    const warning = screen.getByRole('alert');
    expect(warning.textContent).toMatch(/reporting platform operator/i);
    expect(warning.textContent).toMatch(/annual return/i);
    expect(warning.textContent).toMatch(/register/i);
  });

  it('demands the confirmation before the submit, not after it', () => {
    render(<CreateCategoryForm />);
    fireEvent.change(select(), { target: { value: 'personal_service' } });

    const box = confirmation();
    expect(box).toBeTruthy();
    // `required` so the browser refuses. The server action parses the same
    // contract schema and the API enforces it again — this is the layer that
    // stops somebody learning the rule from a round trip.
    expect((box as HTMLInputElement).required).toBe(true);
  });

  it('names counsel rather than asking only for understanding', () => {
    // §8.14.2 requires scope determination to be confirmed by counsel *before*
    // a non-none category is enabled. A box saying "I understand" is one
    // somebody can honestly tick without that having happened.
    render(<CreateCategoryForm />);
    fireEvent.change(select(), { target: { value: 'sale_of_goods' } });

    expect(screen.getByRole('alert').textContent).toBeTruthy();
    expect(confirmation()).toBeTruthy();
  });

  it('takes the warning away again if the answer goes back to none', () => {
    render(<CreateCategoryForm />);
    fireEvent.change(select(), { target: { value: 'means_of_transport' } });
    fireEvent.change(select(), { target: { value: 'none' } });

    expect(confirmation()).toBeNull();
  });

  it('posts the chosen head under the name the contract expects', () => {
    render(<CreateCategoryForm />);
    fireEvent.change(select(), { target: { value: 'means_of_transport' } });

    const field = document.querySelector('select[name="reportableActivity"]');
    expect((field as HTMLSelectElement).value).toBe('means_of_transport');
  });

  it('explains what the setting is for, in the words of what a category holds', () => {
    // "Means of transport" is the legislation's phrase, not an administrator's.
    // Naming trailers and e-bikes is what makes the choice answerable by the
    // person making it.
    render(<CreateCategoryForm />);
    expect(screen.getByText(/trailers, vans, e-bikes/i)).toBeTruthy();
  });
});

describe('the reportable-activity field when reconfiguring', () => {
  it('shows what the category is now, because PUT replaces everything', () => {
    render(<ReconfigureCategoryForm category={CATEGORY} />);
    expect((select() as HTMLSelectElement).value).toBe('none');
  });

  it('seeds a category that is already reportable with its own value', () => {
    render(
      <ReconfigureCategoryForm
        category={{ ...CATEGORY, reportableActivity: 'means_of_transport' }}
      />,
    );

    expect((select() as HTMLSelectElement).value).toBe('means_of_transport');
    // Already reportable, so the confirmation is present from the first render:
    // the rule is about the value being saved, not about the transition.
    expect(confirmation()).toBeTruthy();
  });

  it('warns on a switch, which is the change §17 calls the real risk', () => {
    // §8.14.2 words the warning as being "on category creation". Obeying only
    // the letter would leave the dangerous case — an existing category quietly
    // becoming reportable — with no warning at all.
    render(<ReconfigureCategoryForm category={CATEGORY} />);
    expect(confirmation()).toBeNull();

    fireEvent.change(select(), { target: { value: 'means_of_transport' } });

    expect(screen.getByRole('alert').textContent).toMatch(
      /reporting platform operator/i,
    );
    expect(confirmation()).toBeTruthy();
  });

  it('says the flag is not undone by unticking it later', () => {
    render(<ReconfigureCategoryForm category={CATEGORY} />);
    fireEvent.change(select(), { target: { value: 'means_of_transport' } });

    expect(screen.getByRole('alert').textContent).toMatch(/not reversible/i);
  });
});

describe('the feedback message', () => {
  /**
   * Where the message goes, and whether anybody sees it.
   *
   * This form renders its outcome at the top and its button at the bottom, and
   * slice 2.4c-i made the gap much longer by adding the transport fieldset. That
   * is session 25's failure on the listing form: press Save, the page does not
   * move, and a refusal well above the fold reads as a form that does nothing.
   *
   * The second case is the one that matters and the one a naive fix misses. Two
   * identical failures produce the same string, so an effect keyed on the
   * *message* compares equal and never runs again — the page sits perfectly
   * still on the second press, which is precisely when somebody decides it is
   * broken.
   */
  const refused = () => ({
    status: 'error' as const,
    message: 'Transport options: that selection was refused.',
    slug: '',
    name: '',
    reason: '',
    reportableActivity: 'none' as AdminCategory['reportableActivity'],
  });

  it('takes focus so the refusal is announced and scrolled to', () => {
    state.current = refused();
    render(<CreateCategoryForm />);

    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });

  it('takes focus again on a second, identical refusal', () => {
    state.current = refused();
    const { rerender } = render(<CreateCategoryForm />);
    (document.activeElement as HTMLElement).blur();

    // A fresh state object carrying the same words — what `useActionState` hands
    // back when the same save is refused twice.
    state.current = refused();
    rerender(<CreateCategoryForm />);

    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });

  it('does the same for a success, which is equally far from the button', () => {
    state.current = {
      ...refused(),
      status: 'done',
      message: 'Saved as a new version.',
    };
    render(<CreateCategoryForm />);

    // By its words, not by its role: the transport editor also carries a
    // `status` for its empty state, and `getByRole` would match both.
    expect(document.activeElement).toBe(screen.getByText('Saved as a new version.'));
  });
});

/**
 * The fee fields, and the refused save that used to empty them.
 *
 * React 19 resets the form once a server action settles. Before slice 2.7a's
 * fix these four were `defaultValue`, and a reset restores an input from its
 * *attribute* — so an unpriced category, whose attribute is `''`, lost every
 * value the administrator had typed the moment one of them was refused. They
 * would then have been told the required rates were missing, which is a second
 * and misleading error about fields they had filled in correctly.
 *
 * The same React 19 defect 2.4c-i found on checkboxes and 2.5a on selects. This
 * is the text-input case, which 2.4c-i's note said was safe — true only when the
 * value round-trips through the action state, as `slug` and `reason` do.
 */
describe('the fee fields', () => {
  const fee = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

  it('seeds blank for a category nobody has priced', () => {
    render(
      <ReconfigureCategoryForm
        category={{ ...CATEGORY, feePolicy: UNCONFIGURED_FEE_POLICY }}
      />,
    );

    // Not "0". A default shown as an answer is how a category ends up earning
    // the platform nothing because somebody pressed Save.
    expect(fee(/owner commission/i).value).toBe('');
    expect(fee(/renter fee/i).value).toBe('');
  });

  it('seeds the rates a priced category already has', () => {
    render(<ReconfigureCategoryForm category={CATEGORY} />);

    expect(fee(/owner commission/i).value).toBe('15');
    expect(fee(/renter fee/i).value).toBe('8');
    expect(fee(/minimum booking total/i).value).toBe('10.00');
    expect(fee(/minimum platform fee/i).value).toBe('1.00');
  });

  /**
   * The regression, and it must be the *reset* that is exercised rather than a
   * re-render — `form.reset()` is what React 19 actually does after an action
   * settles, and it is what `defaultValue` cannot survive.
   */
  it('keeps what was typed when the form is reset after a refused save', () => {
    render(
      <ReconfigureCategoryForm
        category={{ ...CATEGORY, feePolicy: UNCONFIGURED_FEE_POLICY }}
      />,
    );

    fireEvent.change(fee(/owner commission/i), { target: { value: '15' } });
    fireEvent.change(fee(/renter fee/i), { target: { value: '8' } });
    fireEvent.change(fee(/minimum booking total/i), { target: { value: '10.00' } });
    fireEvent.change(fee(/minimum platform fee/i), { target: { value: '20.00' } });

    // **`form.reset()`, not `fireEvent.reset(form)`.** The latter dispatches a
    // reset *event* without performing the reset algorithm, so the values never
    // move and the test passes against the bug it exists to catch — verified by
    // reintroducing `defaultValue` and watching it still pass. Calling the real
    // method does what React 19 does after an action settles.
    const form = fee(/owner commission/i).closest('form');
    if (form === null) throw new Error('the fee fields are not inside a form');
    form.reset();

    // All four, not only the one that was wrong. Losing the other three is what
    // made the refusal punishing rather than merely unhelpful.
    expect(fee(/owner commission/i).value).toBe('15');
    expect(fee(/renter fee/i).value).toBe('8');
    expect(fee(/minimum booking total/i).value).toBe('10.00');
    expect(fee(/minimum platform fee/i).value).toBe('20.00');
  });

  it('keeps a priced category’s edits through the same reset', () => {
    render(<ReconfigureCategoryForm category={CATEGORY} />);

    fireEvent.change(fee(/renter fee/i), { target: { value: '12.5' } });

    const form = fee(/renter fee/i).closest('form');
    if (form === null) throw new Error('the fee fields are not inside a form');
    form.reset();

    // Not back to the stored 8. A reset restoring the *stored* value would
    // silently discard an edit and look like the save had been applied.
    expect(fee(/renter fee/i).value).toBe('12.5');
  });

  it('states the recommended bands as guidance rather than limits', () => {
    render(<ReconfigureCategoryForm category={CATEGORY} />);

    expect(screen.getByText(/Recommended 12–20%/)).toBeTruthy();
    expect(screen.getByText(/Recommended 5–12%/)).toBeTruthy();
  });
});

/**
 * The maximum rental duration (§8.5.3, slice 4.4a).
 *
 * **The warning is asserted, not just the input.** §8.5.3 requires the admin
 * interface to warn on change, and a required sentence that no test names is one
 * a later tidy-up removes without anything going red — which is exactly how the
 * three false sentences in the Phase 0–3 audit survived.
 */
describe('the maximum rental duration', () => {
  it('seeds 88 when creating, because the specification names it', () => {
    render(<CreateCategoryForm />);

    const field = screen.getByLabelText(/longest hire/i) as HTMLInputElement;
    expect(field.value).toBe(String(DEFAULT_MAXIMUM_RENTAL_DAYS));
    // Bounded in the markup as well as in the schema: the browser refuses 89
    // before a round trip, and the API refuses it again.
    expect(field.max).toBe(String(MAX_MAXIMUM_RENTAL_DAYS));
    expect(field.min).toBe('1');
  });

  it('seeds what the category currently permits when reconfiguring', () => {
    // Not the default. Reconfiguring the fees must not silently reset a category
    // that was deliberately capped shorter.
    render(
      <ReconfigureCategoryForm category={{ ...CATEGORY, maximumRentalDays: 30 }} />,
    );

    expect((screen.getByLabelText(/longest hire/i) as HTMLInputElement).value).toBe(
      '30',
    );
  });

  describe('the time an owner has to answer (§8.6, slice 4.5a)', () => {
    it('seeds 48 hours when creating, bounded in the markup', () => {
      render(<CreateCategoryForm />);

      const field = screen.getByLabelText(/time to answer/i) as HTMLInputElement;
      expect(field.value).toBe(String(DEFAULT_REQUEST_EXPIRY_HOURS));
      expect(field.min).toBe('1');
      expect(field.max).toBe('336');
    });

    it('seeds what the category allows now when reconfiguring', () => {
      // Not the default. Reconfiguring the fees must not silently reset a deadline
      // somebody chose.
      render(
        <ReconfigureCategoryForm category={{ ...CATEGORY, requestExpiryHours: 6 }} />,
      );

      expect((screen.getByLabelText(/time to answer/i) as HTMLInputElement).value).toBe(
        '6',
      );
    });

    it('carries no warning, unlike the cap beside it', () => {
      // §8.5.3 requires a warning on the cap; this is an operational choice with a
      // trade-off rather than a legal boundary, and a warning nobody needs is how
      // the ones that matter stop being read.
      render(<CreateCategoryForm />);

      const help = screen
        .getByLabelText(/time to answer/i)
        .getAttribute('aria-describedby');
      expect(help).toBeTruthy();
      expect(screen.getAllByRole('note')).toHaveLength(1);
    });
  });

  it('warns, in the words §8.5.3 requires, on both forms', () => {
    const { unmount } = render(<CreateCategoryForm />);
    expect(
      screen.getByText(new RegExp(MAXIMUM_RENTAL_DAYS_WARNING.slice(0, 40))),
    ).toBeTruthy();
    unmount();

    render(<ReconfigureCategoryForm category={CATEGORY} />);
    expect(
      screen.getByText(new RegExp(MAXIMUM_RENTAL_DAYS_WARNING.slice(0, 40))),
    ).toBeTruthy();
  });

  it('says whose rule it is, rather than reading as our own caution', () => {
    // An administrator who thinks this is a policy setting will ask for it to be
    // raised. One who knows it is the Consumer Credit Act will not.
    render(<CreateCategoryForm />);

    const warning = screen.getByRole('note');
    expect(warning.textContent).toMatch(/Consumer Credit Act 1974/);
    expect(warning.textContent).toMatch(/FCA authorisation/);
  });
});
