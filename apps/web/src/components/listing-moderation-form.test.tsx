import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MIN_ADMIN_REASON_LENGTH } from '@platform/contracts';
import type { ModerationState } from '@platform/contracts';

/**
 * The moderation form, as an administrator meets it.
 *
 * The server action is mocked, as in every other form test here — it imports
 * `@clerk/nextjs/server` and `next/headers`. What is asserted is the form's
 * contract with the person using it: that nothing is chosen for them, that the
 * reason box states which rule it is under *before* the button is pressed, and
 * that a refusal does not eat what they typed.
 */
const state = vi.hoisted(() => ({
  current: {
    status: 'idle' as 'idle' | 'done' | 'error',
    message: null as string | null,
    recorded: null as ModerationState | null,
    listingId: '',
    reason: '',
  },
}));

vi.mock('../app/admin/listings/actions', () => ({
  moderateListingAction: vi.fn(),
}));

vi.mock('../app/admin/listings/state', () => ({
  INITIAL_MODERATION_STATE: {
    status: 'idle',
    message: null,
    recorded: null,
    listingId: '',
    reason: '',
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { ListingModerationForm } = await import('./listing-moderation-form');

function idle() {
  state.current = {
    status: 'idle',
    message: null,
    recorded: null,
    listingId: '',
    reason: '',
  };
}

function reasonBox(): HTMLTextAreaElement {
  return screen.getByLabelText(/^Why/) as HTMLTextAreaElement;
}

function choose(label: RegExp) {
  fireEvent.click(screen.getByLabelText(label));
}

describe('the decision', () => {
  it('offers every state in the vocabulary', () => {
    idle();
    render(<ListingModerationForm />);

    // Three radios, one per state, derived from `MODERATION_STATES` — so a
    // fourth state cannot arrive in the contract and be unreachable by the only
    // control that sets it.
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('pre-selects nothing', () => {
    idle();
    render(<ListingModerationForm />);

    // The safety property. Any default is one somebody can submit without having
    // read the options, and two of the three take a stranger's listing out of
    // public view.
    expect(
      screen.getAllByRole('radio').some((radio) => (radio as HTMLInputElement).checked),
    ).toBe(false);
  });

  it('will not submit with nothing chosen', () => {
    idle();
    render(<ListingModerationForm />);

    // Found by pressing the button on the real page: the action refuses this
    // and has to, but the refusal came back from the server for something the
    // browser already knew. With nothing pre-selected, `required` is what makes
    // the choice deliberate rather than merely uncontradicted.
    for (const radio of screen.getAllByRole('radio')) {
      expect((radio as HTMLInputElement).required).toBe(true);
    }
  });

  it('says what each state does to a listing', () => {
    idle();
    render(<ListingModerationForm />);

    // Each option explains its consequence, because "rejected" alone does not
    // say whether the owner is meant to wait or to fix something.
    expect(screen.getByText(/asked to wait/)).toBeTruthy();
    expect(screen.getByText(/fix it or take it down/)).toBeTruthy();
    expect(screen.getByText(/if they paused it, it stays paused/)).toBeTruthy();
  });
});

describe('the reason box', () => {
  it('is not required until a state that hides a listing is chosen', () => {
    idle();
    render(<ListingModerationForm />);

    // Nothing chosen yet, so the rule is not yet knowable — and the help text
    // says which way it will go rather than asserting one of them.
    expect(reasonBox().required).toBe(false);
    expect(
      screen.getByText(/Whether this is required depends on what you choose/),
    ).toBeTruthy();
  });

  it('becomes required when hiding a listing, before the button is pressed', () => {
    idle();
    render(<ListingModerationForm />);

    choose(/Refused/);

    // The H3b rule: a control must not let somebody submit into a refusal it
    // could have shown them. The API answers 400 without a reason; the form says
    // so first.
    expect(reasonBox().required).toBe(true);
    expect(reasonBox().minLength).toBe(MIN_ADMIN_REASON_LENGTH);
  });

  it('is required for review as well as refusal', () => {
    idle();
    render(<ListingModerationForm />);

    choose(/Under review/);

    expect(reasonBox().required).toBe(true);
  });

  it('is optional when putting a listing back, and still holds the floor', () => {
    idle();
    render(<ListingModerationForm />);

    choose(/Nothing is holding it back/);

    /*
     * Both halves matter, and they are the contract's own rule rather than a
     * convenience: reinstating owes no explanation, so an empty box must be
     * allowed — and `minLength` in HTML applies only to a *non-empty* value, so
     * a reason actually typed still has to clear the administrative floor. The
     * API refuses `"no"`, and so does this.
     */
    expect(reasonBox().required).toBe(false);
    expect(reasonBox().minLength).toBe(MIN_ADMIN_REASON_LENGTH);
  });

  it('tells the moderator who reads what they write', () => {
    idle();
    render(<ListingModerationForm />);

    choose(/Refused/);

    expect(screen.getByText(/write what you would say to them/)).toBeTruthy();
  });
});

describe('what it does with what was typed', () => {
  it('keeps the id and the reason after a refusal', () => {
    idle();
    render(<ListingModerationForm />);

    const id = screen.getByLabelText(/Listing id/) as HTMLInputElement;
    fireEvent.change(id, { target: { value: 'abc-123' } });
    fireEvent.change(reasonBox(), {
      target: { value: 'Reported as a prohibited item' },
    });

    // React 19 resets the form once an action settles, which is what emptied
    // these fields in 2.7a and 2.4c-i. Controlled values survive it.
    expect(id.value).toBe('abc-123');
    expect(reasonBox().value).toBe('Reported as a prohibited item');
  });

  it('clears the chosen state once a decision is recorded, so the mark and the help text cannot disagree', () => {
    /*
     * Found by using the page, and it is the fifth control this defect has been
     * found on (2.4b text, 2.4c-i checkboxes, 2.5a selects, 2.7a text, now
     * radios). React 19 resets the form when the action settles, which unchecked
     * the radio in the DOM — and because `chosen` had not changed, nothing
     * re-rendered and the mark never came back. The form then showed no
     * selection while the help text still read "optional when reinstating",
     * which is the same state disagreeing with itself in two places.
     */
    idle();
    const { rerender } = render(<ListingModerationForm />);

    // Choose a state first, so the assertion is about the *transition* rather
    // than about a form that was never touched — which is what makes this fail
    // without the fix instead of passing for the wrong reason.
    choose(/Nothing is holding it back/);
    expect(screen.getByLabelText(/^Why/)).toBeTruthy();

    state.current = {
      status: 'done',
      message: 'Recorded — nothing is holding it back.',
      recorded: 'APPROVED',
      listingId: 'abc-123',
      reason: '',
    };
    rerender(<ListingModerationForm />);

    expect(
      screen.getAllByRole('radio').some((radio) => (radio as HTMLInputElement).checked),
    ).toBe(false);
    // The other half of the pair: the text driven by React state agrees with the
    // marks driven by the DOM. This is the assertion that was false on the real
    // page — no radio marked, and the help text still describing a chosen state.
    expect(
      screen.getByText(/Whether this is required depends on what you choose/),
    ).toBeTruthy();
  });

  it('clears the reason once a decision is recorded, and keeps the id', () => {
    state.current = {
      status: 'done',
      message: 'Recorded — refused, and out of public view.',
      recorded: 'REJECTED',
      listingId: 'abc-123',
      reason: '',
    };
    render(<ListingModerationForm />);

    // The next decision needs its own reason — one carried over would be a lie
    // in the audit trail. The id stays, because a moderator working through a
    // report needs to see which listing they have just decided.
    expect(reasonBox().value).toBe('');
    expect(screen.getByRole('status').textContent).toContain('abc-123');
  });
});

describe('the outcome', () => {
  it('clears the chosen state after a refusal too, since the DOM has already forgotten it', () => {
    // The same defect, second path — found on the 404 after being fixed on the
    // success path. React's form reset runs whether the action succeeded or not,
    // so keeping `chosen` through a refusal would leave the help text describing
    // a selection the moderator cannot see and `required` would refuse to submit
    // anyway. The typed reason is kept, because text is expensive and a radio is
    // one click.
    idle();
    const { rerender } = render(<ListingModerationForm />);

    choose(/Refused/);
    fireEvent.change(reasonBox(), {
      target: { value: 'Reported as a prohibited item' },
    });

    state.current = {
      status: 'error',
      message: 'No listing with that id.',
      recorded: null,
      listingId: 'nope',
      reason: 'Reported as a prohibited item',
    };
    rerender(<ListingModerationForm />);

    expect(
      screen.getAllByRole('radio').some((radio) => (radio as HTMLInputElement).checked),
    ).toBe(false);
    expect(reasonBox().value).toBe('Reported as a prohibited item');
  });

  it('announces a refusal as an alert', () => {
    state.current = {
      status: 'error',
      message: 'No listing with that id.',
      recorded: null,
      listingId: 'nope',
      reason: '',
    };
    render(<ListingModerationForm />);

    expect(screen.getByRole('alert').textContent).toContain('No listing with that id.');
  });

  it('announces a recorded decision as a status', () => {
    state.current = {
      status: 'done',
      message: 'Recorded — nothing is holding it back.',
      recorded: 'APPROVED',
      listingId: 'abc-123',
      reason: '',
    };
    render(<ListingModerationForm />);

    expect(screen.getByRole('status').textContent).toContain('Recorded');
  });

  it('names the listing and the state the API recorded, not the one submitted', () => {
    // The radio selection survives a success, so the next submit could apply the
    // same decision to a different id. Naming both is what makes that visible —
    // and the state shown is the API's answer, so a decision it stored
    // differently does not read as the one that was asked for.
    state.current = {
      status: 'done',
      message: 'Recorded — refused, and out of public view.',
      recorded: 'REJECTED',
      listingId: 'abc-123',
      reason: '',
    };
    render(<ListingModerationForm />);

    const announced = screen.getByRole('status').textContent ?? '';
    expect(announced).toContain('abc-123');
    expect(announced).toContain('REJECTED');
  });

  it('says nothing at all before anything has happened', () => {
    idle();
    render(<ListingModerationForm />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
