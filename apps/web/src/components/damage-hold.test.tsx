import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppliedExcess } from '@platform/contracts';
import { DamageHold } from './damage-hold';

/**
 * The damage-security disclosure, said once for three surfaces (§8.7.2,
 * §3.4.4, slice 5.5b-ii).
 *
 * **The wording is the product here.** `appliedExcessFor` is unit tested against
 * the band and the stores are tested against Postgres; what these prove is that
 * the sentence a person reads is true, says whose card the money sits on, and
 * never calls it a deposit.
 */
describe('DamageHold', () => {
  const excess = (over: Partial<AppliedExcess> = {}): AppliedExcess => ({
    amount: { amount: 7_500, currency: 'GBP' },
    boundBy: 'floor',
    ...over,
  });

  describe('for a renter', () => {
    it('states the amount and that it is not part of the price', () => {
      render(
        <DamageHold
          excess={excess()}
          audience="renter"
          className={undefined}
          explainSize
        />,
      );

      expect(document.body.textContent).toContain('£75.00 held at collection');
      expect(document.body.textContent).toContain('never part of the price');
    });

    it('says it sits on their own card', () => {
      render(
        <DamageHold
          excess={excess()}
          audience="renter"
          className={undefined}
          explainSize
        />,
      );

      expect(document.body.textContent).toContain('sits on your own card');
      expect(document.body.textContent).toContain('released when the item comes home');
    });

    it('says plainly when nothing is held', () => {
      render(
        <DamageHold
          excess={null}
          audience="renter"
          className={undefined}
          explainSize
        />,
      );

      expect(document.body.textContent).toContain('No hold for this item');
      expect(document.body.textContent).toContain('Nothing is held against your card');
    });
  });

  /**
   * **The owner's half of *"shown to both parties before booking"*.** Their
   * commitment is the acceptance, and what they need to know is what stands
   * behind the item they are handing over — not that money of theirs is involved,
   * because none is.
   */
  describe('for an owner', () => {
    it('states the amount and whose card it is', () => {
      render(
        <DamageHold
          excess={excess()}
          audience="owner"
          className={undefined}
          explainSize
        />,
      );

      expect(document.body.textContent).toContain('£75.00 held at collection');
      expect(document.body.textContent).toContain('sits on the renter’s own card');
    });

    /**
     * **It must not read as money the owner receives.** §3.4 pays an owner their
     * charge less commission; a hold is neither, and an owner who thought
     * otherwise would be expecting £75 that is never theirs.
     */
    it('never suggests the hold is part of what they are paid', () => {
      render(
        <DamageHold
          excess={excess()}
          audience="owner"
          className={undefined}
          explainSize
        />,
      );

      expect(document.body.textContent).toContain('not part of what you are paid');
    });

    it('says plainly when nothing is held', () => {
      render(
        <DamageHold excess={null} audience="owner" className={undefined} explainSize />,
      );

      expect(document.body.textContent).toContain('No hold for this item');
      expect(document.body.textContent).toContain(
        'Nothing is held against the renter’s card',
      );
    });
  });

  /**
   * **The distinction the whole workstream turns on** (`DESIGN.md` D3): no
   * customer money is ever ours, so this is a hold on somebody's own card and
   * never a deposit we keep. §8.15 is explicit that substance beats labels.
   */
  it.each(['renter', 'owner'] as const)('never says deposit to a %s', (audience) => {
    render(
      <DamageHold
        excess={excess()}
        audience={audience}
        className={undefined}
        explainSize
      />,
    );

    expect(document.body.textContent).not.toMatch(/deposit/i);
  });

  /**
   * **Every bound is accounted for, and none of them names the replacement
   * value** — which is not published (§8.4.1 already puts the location half a
   * kilometre from the truth). A figure a page states, it should be able to
   * explain.
   */
  it.each([
    ['floor', 'our minimum for this kind of item'],
    ['percentage', 'what this item would cost to replace'],
    ['ceiling', 'the most we will ever hold'],
  ] as const)('accounts for a hold bound by the %s', (boundBy, explanation) => {
    render(
      <DamageHold
        excess={excess({ amount: { amount: 13_500, currency: 'GBP' }, boundBy })}
        audience="renter"
        className={undefined}
        explainSize
      />,
    );

    expect(document.body.textContent).toContain('£135.00 held at collection');
    expect(document.body.textContent).toContain(explanation);
  });

  /**
   * **The per-booking rendering states the amount and does not explain it**, so
   * a page showing both — the owner's listing does — reads as two facts rather
   * than as the same paragraph twice. That duplicate is a defect slice 5.5a
   * already found once, and `request-panel.tsx` records it.
   */
  it('omits the reason when the caller says not to explain it', () => {
    render(
      <DamageHold
        excess={excess()}
        audience="owner"
        className={undefined}
        explainSize={false}
      />,
    );

    expect(document.body.textContent).toContain('£75.00 held at collection');
    expect(document.body.textContent).not.toContain(
      'our minimum for this kind of item',
    );
  });

  it('uses the host page’s own style, so it is separate from the price', () => {
    // §3.4.4: shown separately, never folded into the headline. Every page that
    // renders it does so as a bordered aside.
    const { container } = render(
      <DamageHold
        excess={excess()}
        audience="renter"
        className="hold-block"
        explainSize
      />,
    );

    expect(container.querySelector('.hold-block')).not.toBe(null);
    expect(screen.getByText(/held at collection/)).toBeInTheDocument();
  });
});
