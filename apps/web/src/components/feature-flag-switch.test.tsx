import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AdminFeatureFlag } from '@platform/contracts';

/**
 * The switch, as an administrator meets it under pressure.
 *
 * The server action is mocked, as in every other form test here — it imports
 * `@clerk/nextjs/server` and `next/headers`. What is asserted is the form's
 * contract with the person using it: that the button says which way it goes,
 * that a refusal does not eat what they typed, and that one flag's outcome does
 * not appear under another.
 */
const state = vi.hoisted(() => ({
  current: {
    status: 'idle' as 'idle' | 'done' | 'error',
    message: null as string | null,
    key: null as string | null,
    reason: '',
  },
}));

vi.mock('../app/admin/feature-flags/actions', () => ({
  setFeatureFlagAction: vi.fn(),
}));

vi.mock('../app/admin/feature-flags/state', () => ({
  INITIAL_FEATURE_FLAG_STATE: { status: 'idle', message: null, key: null, reason: '' },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { FeatureFlagSwitch } = await import('./feature-flag-switch');

const ON: AdminFeatureFlag = {
  key: 'listing.publication',
  label: 'Publishing listings',
  gates: 'Owners publishing a listing. The emergency stop.',
  enabled: true,
  defaultEnabled: true,
  source: 'default',
  changedAt: null,
  changedById: null,
};

const OFF: AdminFeatureFlag = {
  ...ON,
  enabled: false,
  source: 'override',
  changedAt: '2026-08-08T09:00:00.000Z',
  changedById: '11111111-1111-4111-8111-111111111111',
};

function idle() {
  state.current = { status: 'idle', message: null, key: null, reason: '' };
}

describe('the button', () => {
  it('offers to switch off a flag that is on', () => {
    idle();
    render(<FeatureFlagSwitch flag={ON} />);

    const button = screen.getByRole('button');
    expect(button.textContent).toContain('Switch off');
    // The operation, not the resulting state. A stale page then produces a
    // no-op rather than the opposite of what somebody intended.
    expect((button as HTMLButtonElement).value).toBe('false');
  });

  it('offers to switch on a flag that is off', () => {
    idle();
    render(<FeatureFlagSwitch flag={OFF} />);

    const button = screen.getByRole('button');
    expect(button.textContent).toContain('Switch on');
    expect((button as HTMLButtonElement).value).toBe('true');
  });

  it('names the flag it is about', () => {
    // The page renders one of these per flag, so a button reading only "Switch
    // off" would be ambiguous the moment a second flag exists.
    idle();
    render(<FeatureFlagSwitch flag={ON} />);

    expect(screen.getByRole('button').textContent).toContain('publishing listings');
  });
});

describe('what the row says', () => {
  it('says a flag is at its default, and that nobody has changed it', () => {
    idle();
    render(<FeatureFlagSwitch flag={ON} />);

    expect(screen.getByText(/nobody has changed it/i)).toBeTruthy();
  });

  it('says when a flag was set by a person, and what its default is', () => {
    // "On because nobody touched it" and "on because somebody switched it on"
    // are different facts, and during an incident the difference is the first
    // thing worth knowing.
    idle();
    render(<FeatureFlagSwitch flag={OFF} />);

    expect(screen.getByText(/set by an administrator/i)).toBeTruthy();
    expect(screen.getByText(/its default is on/i)).toBeTruthy();
  });

  it('carries the prose about what stops working', () => {
    idle();
    render(<FeatureFlagSwitch flag={ON} />);

    expect(screen.getByText(/emergency stop/i)).toBeTruthy();
  });
});

describe('the reason', () => {
  it('survives a refusal', () => {
    // The defect this codebase has now shipped four times (2.4c-i, 2.5a, 2.7a).
    // React 19 resets the form once the action settles, and a `defaultValue`
    // restores from the attribute — empty. Type a reason, be refused, lose it,
    // and be told to supply one.
    state.current = {
      status: 'error',
      message: 'Give a reason of at least 10 characters.',
      key: ON.key,
      reason: 'stopping',
    };
    const { container } = render(<FeatureFlagSwitch flag={ON} />);

    const input = screen.getByLabelText('Why') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a report came in' } });
    expect(input.value).toBe('a report came in');

    // `form.reset()` is what React 19 actually performs. `fireEvent.reset`
    // dispatches the event without performing the algorithm, so it would pass
    // against the bug — slice 2.7a's methodological finding.
    const form = container.querySelector('form');
    form?.reset();

    expect((screen.getByLabelText('Why') as HTMLInputElement).value).toBe(
      'a report came in',
    );
  });
});

describe('the outcome', () => {
  it('shows an error as an alert', () => {
    state.current = {
      status: 'error',
      message: 'That did not complete and nothing was changed — API answered 500',
      key: ON.key,
      reason: 'a report came in',
    };
    render(<FeatureFlagSwitch flag={ON} />);

    expect(screen.getByRole('alert').textContent).toContain('nothing was changed');
  });

  it('shows a success as a status', () => {
    state.current = {
      status: 'done',
      message: 'Switched off. It takes effect immediately.',
      key: ON.key,
      reason: '',
    };
    render(<FeatureFlagSwitch flag={ON} />);

    expect(screen.getByRole('status').textContent).toContain(
      'takes effect immediately',
    );
  });

  it('does not show another flag’s outcome under this one', () => {
    // The page renders one form per flag but `useActionState` is per component;
    // without the key check a shared state object would report one switch's
    // result under every other. A switch that claims somebody else's success is
    // worse than one that reports nothing.
    state.current = {
      status: 'done',
      message: 'Switched off. It takes effect immediately.',
      key: 'some.other.flag',
      reason: '',
    };
    render(<FeatureFlagSwitch flag={ON} />);

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
