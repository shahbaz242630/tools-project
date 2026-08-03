import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAX_CATEGORY_ATTRIBUTES } from '@platform/contracts';
import type { CategoryAttribute } from '@platform/contracts';
import { AttributeSchemaEditor } from './attribute-schema-editor';

/**
 * The editor is the one control in this slice that has to be general, so the
 * tests read what it *posts* rather than what it displays. That hidden value is
 * the whole contract between this component and the server action — everything
 * else on screen is presentation.
 */

const SCHEMA: readonly CategoryAttribute[] = [
  {
    key: 'power_source',
    label: 'Power source',
    required: true,
    type: 'choice',
    options: [
      { value: 'petrol', label: 'Petrol' },
      { value: 'cordless', label: 'Cordless' },
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
];

function posted(): unknown {
  const field = document.querySelector('input[name="attributes"]');
  return JSON.parse((field as HTMLInputElement).value);
}

function editor(initial?: readonly CategoryAttribute[]) {
  // Spread rather than `initial={initial}` — `exactOptionalPropertyTypes` makes
  // "absent" and "present but undefined" different types, and the prop is
  // optional rather than nullable.
  return render(
    <AttributeSchemaEditor
      name="attributes"
      idPrefix="test"
      {...(initial === undefined ? {} : { initial })}
    />,
  );
}

describe('an empty editor', () => {
  it('posts an empty array rather than nothing at all', () => {
    // The server refuses an absent field rather than guessing it meant none,
    // so a category with no attributes still has to post something.
    editor();

    expect(posted()).toEqual([]);
  });

  it('says a category may legitimately have none', () => {
    editor();

    expect(screen.getByText(/A category can have none/i)).toBeInTheDocument();
  });
});

describe('adding an attribute', () => {
  it('starts as text, the type with no further decisions', () => {
    editor();
    fireEvent.click(screen.getByRole('button', { name: /add an attribute/i }));

    expect(posted()).toEqual([
      { key: '', label: '', required: false, type: 'text', maxLength: 60 },
    ]);
  });

  it('posts what was typed', () => {
    editor();
    fireEvent.click(screen.getByRole('button', { name: /add an attribute/i }));

    fireEvent.change(screen.getByLabelText('Label'), {
      target: { value: 'Engine or motor' },
    });
    fireEvent.change(screen.getByLabelText('Stored name'), {
      target: { value: 'motor_spec' },
    });

    expect(posted()).toEqual([
      {
        key: 'motor_spec',
        label: 'Engine or motor',
        required: false,
        type: 'text',
        maxLength: 60,
      },
    ]);
  });

  it('trims what was typed, so a stray space is not stored as part of a key', () => {
    editor();
    fireEvent.click(screen.getByRole('button', { name: /add an attribute/i }));
    fireEvent.change(screen.getByLabelText('Stored name'), {
      target: { value: '  motor_spec  ' },
    });

    expect((posted() as { key: string }[])[0]?.key).toBe('motor_spec');
  });

  it('stops at the cap and says why', () => {
    editor();
    const add = screen.getByRole('button', { name: /add an attribute/i });
    for (let count = 0; count < MAX_CATEGORY_ATTRIBUTES; count++) fireEvent.click(add);

    expect(add).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      String(MAX_CATEGORY_ATTRIBUTES),
    );
  });
});

describe('changing an attribute type', () => {
  it('reveals only that type’s settings', () => {
    editor();
    fireEvent.click(screen.getByRole('button', { name: /add an attribute/i }));

    // Text: a length, and nothing else.
    expect(screen.getByLabelText(/longest answer/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Unit')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'number' } });

    // Number: a unit and a scale, and the length is gone rather than hidden.
    expect(screen.getByLabelText('Unit')).toBeInTheDocument();
    expect(screen.getByLabelText(/decimal places/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/longest answer/i)).not.toBeInTheDocument();
  });

  it('posts the shape the new type has, not the old one', () => {
    editor();
    fireEvent.click(screen.getByRole('button', { name: /add an attribute/i }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'number' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'kg' } });
    fireEvent.change(screen.getByLabelText(/decimal places/i), {
      target: { value: '1' },
    });

    // No `maxLength` left over from when it was text. A leftover field would be
    // stripped by the contract, but it would also mean this component and the
    // vocabulary disagree about what a number is.
    expect(posted()).toEqual([
      {
        key: '',
        label: '',
        required: false,
        type: 'number',
        unit: 'kg',
        decimalPlaces: 1,
      },
    ]);
  });

  it('survives the length field being cleared', () => {
    // `valueAsNumber` is NaN for an empty number input, and `JSON.stringify`
    // writes NaN as null — so an administrator who selects the number and
    // deletes it would post `"maxLength": null` and be told "expected number,
    // received null", which names no field they can see.
    editor();
    fireEvent.click(screen.getByRole('button', { name: /add an attribute/i }));
    fireEvent.change(screen.getByLabelText(/longest answer/i), {
      target: { value: '' },
    });

    expect((posted() as { maxLength: unknown }[])[0]?.maxLength).toBe(0);
  });

  it('offers two options when a choice is picked, because one is refused', () => {
    editor();
    fireEvent.click(screen.getByRole('button', { name: /add an attribute/i }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'choice' } });

    expect(screen.getAllByLabelText('Stored as')).toHaveLength(2);
  });
});

describe('options', () => {
  function withChoice() {
    editor();
    fireEvent.click(screen.getByRole('button', { name: /add an attribute/i }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'choice' } });
  }

  it('will not let a single-answer question drop below two', () => {
    withChoice();

    expect(screen.getByRole('button', { name: /remove option 1/i })).toBeDisabled();
  });

  it('lets a multi-answer question have one, which is the honest boolean', () => {
    editor();
    fireEvent.click(screen.getByRole('button', { name: /add an attribute/i }));
    fireEvent.change(screen.getByLabelText('Type'), {
      target: { value: 'choice-many' },
    });
    fireEvent.click(screen.getByRole('button', { name: /remove option 2/i }));

    expect(screen.getAllByLabelText('Stored as')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /remove option 1/i })).toBeDisabled();
  });

  it('posts the values and labels separately', () => {
    withChoice();
    const values = screen.getAllByLabelText('Stored as');
    const labels = screen.getAllByLabelText('Shown as');

    fireEvent.change(labels[0] as HTMLElement, { target: { value: 'Petrol' } });
    fireEvent.change(values[0] as HTMLElement, { target: { value: 'petrol' } });
    fireEvent.change(labels[1] as HTMLElement, { target: { value: 'Cordless' } });
    fireEvent.change(values[1] as HTMLElement, { target: { value: 'cordless' } });

    expect((posted() as { options: unknown }[])[0]?.options).toEqual([
      { value: 'petrol', label: 'Petrol' },
      { value: 'cordless', label: 'Cordless' },
    ]);
  });
});

describe('an existing schema', () => {
  it('opens with what the category already has', () => {
    // `PUT` replaces the whole configuration. An editor that started empty would
    // look like "add some attributes" and mean "delete the ones that exist".
    editor(SCHEMA);

    expect(posted()).toEqual(SCHEMA);
  });

  it('shows each attribute in the order it is stored', () => {
    editor(SCHEMA);
    const rows = screen.getAllByRole('group', { name: /attribute \d of \d/i });

    expect(within(rows[0] as HTMLElement).getByLabelText('Label')).toHaveValue(
      'Power source',
    );
    expect(within(rows[1] as HTMLElement).getByLabelText('Label')).toHaveValue(
      'Weight',
    );
  });

  it('reorders, and the posted order changes with it', () => {
    // Order is the render order (ADR 0027), so this is a real configuration
    // change rather than a cosmetic one — the audit digest records it as such.
    editor(SCHEMA);
    fireEvent.click(
      screen.getAllByRole('button', { name: /move up/i })[1] as HTMLElement,
    );

    expect((posted() as { key: string }[]).map((one) => one.key)).toEqual([
      'weight_kg',
      'power_source',
    ]);
  });

  it('cannot move the first one up or the last one down', () => {
    editor(SCHEMA);

    expect(screen.getAllByRole('button', { name: /move up/i })[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /move down/i })[1]).toBeDisabled();
  });

  it('removes one by name, so the button says what it will destroy', () => {
    editor(SCHEMA);
    fireEvent.click(screen.getByRole('button', { name: /remove weight/i }));

    expect((posted() as { key: string }[]).map((one) => one.key)).toEqual([
      'power_source',
    ]);
  });

  it('warns that the stored name is effectively permanent', () => {
    // Renaming a key orphans every value already stored under the old one, and
    // the failure looks like a field that silently went blank.
    editor(SCHEMA);

    expect(screen.getAllByText(/Permanent in practice/i)[0]).toBeInTheDocument();
  });
});
