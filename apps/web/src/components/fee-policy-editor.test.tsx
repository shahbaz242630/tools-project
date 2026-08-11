import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CategoryFeePolicy } from '@platform/contracts';
import { FeePolicyEditor } from './fee-policy-editor';

/**
 * What an administrator is told before they change a percentage (slice 2.7c,
 * ADR 0042).
 *
 * **This file exists because the copy here was true and misleading**, which is
 * the harder failure to notice. It said a change never re-prices an existing
 * *booking* — correct, and it left the obvious inference about listings
 * unstated. Since 0042 a rate change re-prices **every existing listing in the
 * category, immediately, with nobody notified**, and this help text is the only
 * place the person doing it will learn that.
 *
 * The component had no test at all until now, which is how the sentence went
 * stale without anything failing.
 */

const POLICY: CategoryFeePolicy = {
  ownerCommissionBasisPoints: 1_500,
  renterFeeBasisPoints: 800,
  minimumBookingTotal: { amount: 1_000, currency: 'GBP' },
  minimumPlatformFee: { amount: 100, currency: 'GBP' },
};

describe('what the editor warns about', () => {
  it('says a rate change re-prices existing listings straight away', () => {
    render(<FeePolicyEditor idPrefix="t" initial={POLICY} />);

    expect(document.body.textContent).toContain('re-prices every listing');
    expect(document.body.textContent).toContain('straight away');
  });

  it('says owners are not told', () => {
    // The gap ADR 0042 knowingly creates, stated to the one person who can
    // choose not to trigger it. Softening this to "may affect" would be the
    // original defect in a different tense.
    render(<FeePolicyEditor idPrefix="t" initial={POLICY} />);

    expect(document.body.textContent).toContain('Owners are not told');
  });

  it('still says bookings already made are unaffected', () => {
    // The half of the old sentence that was always true, and it is *more*
    // important now rather than less: with listings re-pricing, an administrator
    // needs to know the line is drawn at the booking. §8.2's guarantee lives
    // there from Phase 5.
    render(<FeePolicyEditor idPrefix="t" initial={POLICY} />);

    expect(document.body.textContent).toContain(
      'Bookings already made are not affected',
    );
  });

  it('never claims a change re-prices nothing', () => {
    // The exact shape of the old copy, asserted as absent. A future edit that
    // reinstates the reassurance would have to delete this line to do it.
    render(<FeePolicyEditor idPrefix="t" initial={POLICY} />);

    expect(document.body.textContent).not.toContain(
      'never re-prices an existing booking',
    );
  });

  it('warns on an unpriced category too, where the first rate is being set', () => {
    // No `initial`, which is a category that has never been priced. The fields
    // seed blank there, and the warning must not be conditional on them — the
    // first time a rate is set is a re-price of every listing already written
    // against the category's zero default.
    render(<FeePolicyEditor idPrefix="t" />);

    expect(document.body.textContent).toContain('re-prices every listing');
  });
});
