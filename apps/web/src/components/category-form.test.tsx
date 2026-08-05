import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminCategory } from '@platform/contracts';

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
