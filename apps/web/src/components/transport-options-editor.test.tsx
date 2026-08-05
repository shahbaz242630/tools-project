import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TRANSPORT_REQUIREMENTS, WEIGHT_ATTRIBUTE_KEY } from '@platform/contracts';
import type { CategoryTransportOption } from '@platform/contracts';
import { TransportOptionsEditor } from './transport-options-editor';

/**
 * As with the attribute editor, the tests read what the component **posts**
 * rather than what it displays: the hidden value is the whole contract between
 * this control and the server action, and everything else is presentation.
 */

function posted(): unknown {
  const field = document.querySelector('input[name="transportOptions"]');
  return JSON.parse((field as HTMLInputElement).value);
}

function editor(initial?: readonly CategoryTransportOption[]) {
  // Spread rather than `initial={initial}` — `exactOptionalPropertyTypes` makes
  // "absent" and "present but undefined" different types.
  return render(
    <TransportOptionsEditor
      name="transportOptions"
      idPrefix="test"
      {...(initial === undefined ? {} : { initial })}
    />,
  );
}

const tick = (label: string | RegExp) => {
  fireEvent.click(screen.getByLabelText(label));
};

describe('an empty editor', () => {
  it('posts an empty array rather than nothing at all', () => {
    // The server refuses an absent field rather than guessing it meant none.
    editor();

    expect(posted()).toEqual([]);
  });

  it('offers every requirement in the vocabulary', () => {
    // The control shows all five because the decision is *which apply*, not
    // what they are called. A missing one is an option no category can ever
    // offer, with nothing on screen to say so.
    editor();

    for (const requirement of TRANSPORT_REQUIREMENTS) {
      expect(document.querySelector(`#test-transport-${requirement}-offered`)).not.toBe(
        null,
      );
    }
  });

  it('says plainly that nothing will be asked', () => {
    // Not an error — a category of hand tools may legitimately offer nothing.
    // But an administrator should not have to infer it from empty checkboxes.
    editor();

    expect(screen.getByRole('status').textContent).toMatch(/will not be asked/i);
  });

  it('shows no weight box for an option that is not offered', () => {
    // The dead control slice 2.1 found on this very page: a box that cannot
    // affect anything, sitting there inviting somebody to fill it in.
    editor();

    expect(document.querySelector('#test-transport-car_boot-upto')).toBe(null);
  });
});

describe('choosing options', () => {
  it('posts a ticked option with no threshold', () => {
    editor();
    tick(/Car boot/);

    expect(posted()).toEqual([{ requirement: 'car_boot' }]);
  });

  it('omits the threshold key entirely rather than sending null', () => {
    // One representation of "not configured". `JSON.stringify` writes NaN as
    // null, which is how slice 2.2 nearly shipped "expected number, received
    // null" about a field somebody had just cleared.
    editor();
    tick(/Car boot/);

    expect(posted()).not.toHaveProperty('0.suggestedUpToKg');
  });

  it('posts a threshold once one is typed', () => {
    editor();
    tick(/Car boot/);
    fireEvent.change(screen.getByLabelText(/Suggest this up to/), {
      target: { value: '25' },
    });

    expect(posted()).toEqual([{ requirement: 'car_boot', suggestedUpToKg: 25 }]);
  });

  it('drops the threshold again when the box is cleared', () => {
    editor();
    tick(/Car boot/);
    const box = screen.getByLabelText(/Suggest this up to/);
    fireEvent.change(box, { target: { value: '25' } });
    fireEvent.change(box, { target: { value: '' } });

    // Back to "never suggest it", not to zero — clearing a box says the
    // threshold is gone, and zero would fail the contract instead.
    expect(posted()).toEqual([{ requirement: 'car_boot' }]);
  });

  it('posts in the vocabulary’s order however they were ticked', () => {
    // Canonical before it leaves the browser, so the contract's own sort has
    // nothing left to do and two administrators ticking the same boxes in a
    // different order produce the same configuration.
    editor();
    tick(/Trailer/);
    tick(/Carried by hand/);
    tick(/Van or large vehicle/);

    expect(posted()).toEqual([
      { requirement: 'hand_carryable' },
      { requirement: 'van_required' },
      { requirement: 'trailer_required' },
    ]);
  });

  it('drops an option when it is unticked', () => {
    editor();
    tick(/Car boot/);
    tick(/Car boot/);

    expect(posted()).toEqual([]);
  });

  it('explains which attribute key drives the suggestions', () => {
    // The one thing about this control that fails silently: rename the weight
    // attribute and nothing suggests anything, with no error, because nothing
    // is wrong. So it is said where the thresholds are typed.
    editor();
    tick(/Car boot/);

    expect(document.body.textContent).toContain(WEIGHT_ATTRIBUTE_KEY);
  });
});

describe('an existing selection', () => {
  const EXISTING: readonly CategoryTransportOption[] = [
    { requirement: 'car_boot', suggestedUpToKg: 25 },
    { requirement: 'van_required' },
  ];

  it('opens with what the category already offers', () => {
    // `PUT` replaces the whole configuration, so an editor that started empty
    // would look like "choose some" and mean "withdraw the ones you have".
    editor(EXISTING);

    expect(posted()).toEqual(EXISTING);
  });

  it('shows an existing threshold in its box', () => {
    editor(EXISTING);

    expect(
      (document.querySelector('#test-transport-car_boot-upto') as HTMLInputElement)
        .value,
    ).toBe('25');
  });

  it('leaves an option without a threshold with an empty box', () => {
    editor(EXISTING);

    expect(
      (document.querySelector('#test-transport-van_required-upto') as HTMLInputElement)
        .value,
    ).toBe('');
  });

  it('withdraws an option without touching the other', () => {
    editor(EXISTING);
    tick(/Van or large vehicle/);

    expect(posted()).toEqual([{ requirement: 'car_boot', suggestedUpToKg: 25 }]);
  });

  it('posts a selection the contract will refuse, rather than second-guessing it', () => {
    // Deliberate: this component validates nothing. The contract in the server
    // action and again in the API is what decides, and a third opinion here
    // would be the copy with no test proving it agrees with the other two.
    editor(EXISTING);
    // By id rather than by label: two options are offered, so both carry the
    // same "Suggest this up to" label and only the id says which is which.
    fireEvent.change(
      document.querySelector('#test-transport-car_boot-upto') as HTMLInputElement,
      { target: { value: '900' } },
    );
    fireEvent.change(
      document.querySelector('#test-transport-van_required-upto') as HTMLInputElement,
      { target: { value: '20' } },
    );

    expect(posted()).toEqual([
      { requirement: 'car_boot', suggestedUpToKg: 900 },
      { requirement: 'van_required', suggestedUpToKg: 20 },
    ]);
  });
});

describe('surviving the form reset React 19 does after an action', () => {
  /**
   * The bug this whole block exists for, found by using the page.
   *
   * Four boxes were ticked, a save was refused, and every tick vanished while
   * the hidden field still carried all four options. React 19 resets the form
   * once a server action settles; a reset restores each input from its default,
   * and a checkbox rendered `checked={…}` with no default goes back to false —
   * while React's state still says otherwise and React writes nothing back,
   * because the prop did not change.
   *
   * A form that shows nothing ticked and posts four options is the worst kind of
   * wrong: silent, and confidently displayed. Controlled `value` inputs do not
   * have this problem — React re-applies those — so this is checkboxes only.
   */
  function inAForm(initial?: readonly CategoryTransportOption[]) {
    const view = render(
      <form>
        <TransportOptionsEditor
          name="transportOptions"
          idPrefix="test"
          {...(initial === undefined ? {} : { initial })}
        />
      </form>,
    );
    return { ...view, form: document.querySelector('form') as HTMLFormElement };
  }

  it('keeps a tick that came from a click', () => {
    const { form } = inAForm();
    tick(/Car boot/);

    form.reset();

    expect(
      (document.querySelector('#test-transport-car_boot-offered') as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('still posts what the ticks say after a reset', () => {
    // The half that actually bit: what is displayed and what is posted must not
    // be allowed to disagree.
    const { form } = inAForm();
    tick(/Car boot/);
    tick(/Van or large vehicle/);

    form.reset();

    expect(posted()).toEqual([
      { requirement: 'car_boot' },
      { requirement: 'van_required' },
    ]);
  });

  it('keeps a withdrawal that came from a click', () => {
    // The other direction, which a `defaultChecked` that ignored state would
    // get wrong: unticking an option the category already offers must survive
    // too, or a refused save would quietly restore it.
    const { form } = inAForm([{ requirement: 'car_boot', suggestedUpToKg: 25 }]);
    tick(/Car boot/);

    form.reset();

    expect(
      (document.querySelector('#test-transport-car_boot-offered') as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(posted()).toEqual([]);
  });

  it('keeps a typed threshold', () => {
    // Controlled `value` inputs are restored by React, so this already passed —
    // it is here so that a future change to how the box is rendered cannot
    // reintroduce the same class of bug on the other half of the control.
    const { form } = inAForm();
    tick(/Car boot/);
    fireEvent.change(screen.getByLabelText(/Suggest this up to/), {
      target: { value: '25' },
    });

    form.reset();

    expect(posted()).toEqual([{ requirement: 'car_boot', suggestedUpToKg: 25 }]);
  });
});
