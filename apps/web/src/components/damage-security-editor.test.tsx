import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { DamageSecurityPolicy } from '@platform/contracts';
import { DamageSecurityEditor } from './damage-security-editor';

/**
 * The administrative half of ADR 0052.
 *
 * The database cannot tell "nobody configured a band" from "we chose to require
 * none" — both are five nulls — so the deliberateness lives here, in a required
 * choice with no default. These tests pin that, because a `defaultChecked` added
 * later to make the form feel tidier would remove the whole protection and
 * nothing else would fail.
 */

const BAND: DamageSecurityPolicy = {
  excessFloor: { amount: 7_500, currency: 'GBP' },
  excessPercentageBasisPoints: 1_500,
  recoveryCeiling: { amount: 50_000, currency: 'GBP' },
};

describe('the choice', () => {
  it('offers both answers with neither pre-selected on a new category', () => {
    render(<DamageSecurityEditor idPrefix="t" />);

    expect(screen.getByRole('radio', { name: /^Yes/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /^No/ })).not.toBeChecked();
  });

  /**
   * The case the migration created and ADR 0052 accepted: a category written
   * before 5.5a carries no band, and we cannot vouch that anybody chose that. So
   * it is asked again rather than answered on their behalf.
   */
  it('seeds no answer for an existing category that has no band', () => {
    render(<DamageSecurityEditor idPrefix="t" initial={null} />);

    expect(screen.getByRole('radio', { name: /^Yes/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /^No/ })).not.toBeChecked();
  });

  it('seeds the answer and the values for a category that has a band', () => {
    render(<DamageSecurityEditor idPrefix="t" initial={BAND} />);

    expect(screen.getByRole('radio', { name: /^Yes/ })).toBeChecked();
    expect(screen.getByLabelText('Excess floor (£)')).toHaveValue('75.00');
    expect(screen.getByLabelText('Excess percentage (%)')).toHaveValue('15');
    expect(screen.getByLabelText('Recovery ceiling (£)')).toHaveValue('500.00');
  });

  it('makes the choice required, so a browser refuses an unanswered form', () => {
    render(<DamageSecurityEditor idPrefix="t" />);

    expect(screen.getByRole('radio', { name: /^Yes/ })).toBeRequired();
    expect(screen.getByRole('radio', { name: /^No/ })).toBeRequired();
  });
});

describe('the band fields', () => {
  it('are absent until security is required', () => {
    render(<DamageSecurityEditor idPrefix="t" />);

    expect(screen.queryByLabelText('Recovery ceiling (£)')).toBeNull();
  });

  it('appear when security is chosen', async () => {
    render(<DamageSecurityEditor idPrefix="t" />);

    await userEvent.click(screen.getByRole('radio', { name: /^Yes/ }));

    expect(screen.getByLabelText('Recovery ceiling (£)')).toBeInTheDocument();
  });

  /**
   * **Unmounted rather than hidden, and that is the point of this test.** A
   * hidden `required` input blocks submission with a message pointing at a field
   * nobody can see, and it would also post an empty ceiling that
   * `readDamageSecurity` would refuse — making "requires no security"
   * unreachable through the form while the API happily accepted it.
   */
  it('are removed again when the category is switched to no security', async () => {
    render(<DamageSecurityEditor idPrefix="t" initial={BAND} />);
    expect(screen.getByLabelText('Recovery ceiling (£)')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /^No/ }));

    expect(screen.queryByLabelText('Recovery ceiling (£)')).toBeNull();
    expect(screen.queryByLabelText('Excess percentage (%)')).toBeNull();
  });

  it('keeps what was typed when the choice is toggled back', async () => {
    /*
     * Controlled state rather than `defaultValue`, so an administrator who
     * changes their mind twice does not silently lose three numbers — the React
     * 19 form-reset defect 2.4c-i and 2.5a each paid for once.
     */
    render(<DamageSecurityEditor idPrefix="t" initial={BAND} />);

    await userEvent.click(screen.getByRole('radio', { name: /^No/ }));
    await userEvent.click(screen.getByRole('radio', { name: /^Yes/ }));

    expect(screen.getByLabelText('Recovery ceiling (£)')).toHaveValue('500.00');
  });

  it('leaves the floor optional and the other two required', async () => {
    render(<DamageSecurityEditor idPrefix="t" initial={BAND} />);

    // §8.7.2 permits a band sized entirely from the percentage.
    expect(screen.getByLabelText('Excess floor (£)')).not.toBeRequired();
    expect(screen.getByLabelText('Excess percentage (%)')).toBeRequired();
    expect(screen.getByLabelText('Recovery ceiling (£)')).toBeRequired();
  });
});

describe('what the editor tells an administrator', () => {
  it('says nothing is held when the booking is made', () => {
    /*
     * §8.7.2's timing rule, stated where the person configuring it will read it.
     * The commonest wrong mental model is that a deposit is taken at booking,
     * and it is the one that makes a five-day hold look sufficient.
     */
    render(<DamageSecurityEditor idPrefix="t" initial={BAND} />);

    expect(document.body.textContent).toContain(
      'Nothing is held when a booking is made',
    );
    expect(document.body.textContent).toContain('collection window opens');
  });

  it('says the amount held is a hard ceiling', () => {
    // §8.7.1. Overcapture is unavailable to this platform, so a band set too low
    // is unrecoverable rather than merely awkward.
    render(<DamageSecurityEditor idPrefix="t" initial={BAND} />);

    expect(document.body.textContent).toContain('hard ceiling');
  });

  it('says the renter bears the larger of the floor and the percentage', () => {
    render(<DamageSecurityEditor idPrefix="t" initial={BAND} />);

    expect(document.body.textContent).toContain('whichever is larger');
  });

  it('says the ceiling caps both figures and the rest falls on the owner', () => {
    // ADR 0052's cap, and the consequence §8.7.2 requires an owner be told.
    render(<DamageSecurityEditor idPrefix="t" initial={BAND} />);

    expect(document.body.textContent).toContain('it caps the two figures above');
    expect(document.body.textContent).toContain('falls on the owner');
  });

  it('says bookings already made are unaffected', () => {
    // §8.7.2: "Bookings retain the values current at creation."
    render(<DamageSecurityEditor idPrefix="t" initial={BAND} />);

    expect(document.body.textContent).toContain(
      'Bookings already made are not affected',
    );
  });
});
