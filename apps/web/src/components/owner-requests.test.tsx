import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Money, Time } from '@platform/core';
import type { ListingRequest } from '@platform/contracts';
import type { RequestDecisionState } from '../app/listings/[id]/request-state';

/**
 * The requests waiting on an owner, as an owner meets them (slice 4.6b).
 *
 * The server actions are mocked, as in every other form test here — they import
 * `@clerk/nextjs/server` and `next/headers`. What is asserted is what the panel
 * *says*: §7.1's disclosure that accepting declines the competition, the
 * irreversibility warning on the control that causes it, that no renter is named
 * and no payout claimed, and that a deadline is rendered in a stated timezone.
 *
 * **That is the standing lesson from the Phase 0–3 audit**: a green suite cannot
 * see a false sentence, so the sentences are what these assert.
 */

const state = vi.hoisted(() => ({
  current: { status: 'idle', message: '' } as RequestDecisionState,
}));

vi.mock('../app/listings/[id]/request-decisions', () => ({
  answerRequestAction: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { OwnerRequests } = await import('./owner-requests');

const LISTING = '11111111-1111-4111-8111-111111111111';

function aRequest(over: Partial<ListingRequest> = {}): ListingRequest {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    startDate: '2026-09-15',
    endDate: '2026-09-17',
    days: 3,
    itemCharge: { amount: 5_400, currency: 'GBP' },
    appliedExcess: { amount: { amount: 7_500, currency: 'GBP' }, boundBy: 'floor' },
    // 10:00 in Europe/London, because September is BST. An expiry rendered in
    // UTC would read 09:00 — which is the point of the assertion below.
    requestExpiresAt: '2026-09-13T09:00:00.000Z',
    conflictCount: 0,
    ...over,
  };
}

function at(requests: readonly ListingRequest[], outcome?: RequestDecisionState) {
  state.current = outcome ?? { status: 'idle', message: '' };
  render(<OwnerRequests listingId={LISTING} requests={requests} />);
}

const text = () => document.body.textContent ?? '';

/** Session 44's lesson: pay the one-off Luxon cost here, not in the first test. */
beforeAll(() => {
  Money.format({ amount: 1, currency: 'GBP' });
  Time.formatLocalDate('2026-09-15');
  Time.formatLocal(Time.fromIsoUtc('2026-09-13T09:00:00.000Z'));
});

describe('when nothing is waiting', () => {
  it('says what is true whether or not anybody has ever asked', () => {
    /*
     * **This asserted the opposite until the page was read.** The wording was
     * *"Nobody has asked to hire this yet"*, and an owner who accepts one request
     * and watches the other auto-decline is shown it **immediately after two
     * people asked** — a false sentence, in the same class as the three the Phase
     * 0—3 audit found.
     *
     * This panel only ever knows what is *pending*. It cannot tell "never any"
     * from "all answered", so its empty state must not claim to.
     */
    at([]);

    expect(text()).toContain('No requests are waiting');
    expect(text()).not.toContain('Nobody has asked');
    expect(text()).toContain('48 hours');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('still shows the outcome of the answer that emptied it', () => {
    /*
     * **The second thing pressing the button found.** An answered request leaves
     * the list, so a confirmation rendered *inside* it unmounts before anybody
     * reads it — including the sentence saying the acceptance is permanent. The
     * outcome lives on the panel for exactly this case.
     */
    at([], { status: 'accepted', message: 'Accepted. Those dates are now held.' });

    expect(screen.getByRole('status')).toHaveTextContent('Accepted.');
    expect(text()).toContain('No requests are waiting');
  });
});

describe('a request waiting', () => {
  it('shows the period, the days, and what it earns at the owner’s rates', () => {
    at([aRequest()]);

    expect(text()).toContain('15 Sept 2026 to 17 Sept 2026');
    expect(text()).toContain('3 days');
    expect(text()).toContain('£54.00');
    expect(text()).toContain('at your rates');
  });

  it('claims no payout, because the commission arithmetic does not exist', () => {
    /*
     * §3.4 deducts the owner's commission from a payout, and neither exists until
     * Phase 5. A figure labelled as what they *receive* would be a false sentence
     * about money — the exact class of defect the Phase 0–3 audit found three of.
     */
    at([aRequest()]);

    expect(text()).toContain('before our commission');
    expect(text()).not.toContain('you will receive');
    expect(text()).not.toContain('your payout');
    // The renter's inclusive total is not the owner's business here either.
    expect(text()).not.toContain('£58.32');
  });

  it('names no renter', () => {
    // §8.4.1's posture: identity arrives with commitment, not before it. An
    // owner is deciding about dates and a price.
    at([aRequest()]);

    expect(text()).not.toMatch(/Dale|Priya|renter's name/i);
  });

  it('says when it expires, and in which timezone', () => {
    // 10:00 BST from a 09:00Z instant. Rendered in the platform's timezone with
    // the timezone said out loud, never the device's.
    at([aRequest()]);

    expect(text()).toContain('10:00');
    expect(text()).toContain('UK time');
  });

  it('offers both answers', () => {
    at([aRequest()]);

    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });

  it('warns that accepting cannot be undone, on the control that does it', () => {
    /*
     * **The most important assertion in this file.** §7 gives `ACCEPTED` no
     * cancel edge until `RESERVED`, which is Phase 5 — so accepting is genuinely
     * permanent and no control in this product can reverse it. The product owner
     * chose to ship that *with the sentence attached* (18 August 2026), and a
     * test is what stops the sentence being tidied away as clutter.
     */
    at([aRequest()]);

    expect(text()).toContain('It cannot be undone yet');
  });
});

describe('§7.1’s disclosure', () => {
  it('says how many other requests accepting this one would decline', () => {
    // §7.1: *"Owners must be shown, before accepting, that competing requests
    // exist and will be declined."* Before, in the same box as the button.
    at([aRequest({ conflictCount: 1 })]);

    expect(text()).toContain('decline 1 other request');
    expect(text()).toContain('overlapping dates');
  });

  it('pluralises, because "1 other requests" reads as a bug', () => {
    at([aRequest({ conflictCount: 3 })]);

    expect(text()).toContain('decline 3 other requests');
  });

  it('says nothing at all when there is no competition', () => {
    // A count of nought on every request forever is noise, and noise is what
    // makes the real warning invisible.
    at([aRequest({ conflictCount: 0 })]);

    expect(text()).not.toContain('other request');
  });
});

describe('after answering', () => {
  it('confirms an acceptance, and names the irreversibility again', () => {
    at([aRequest()], {
      status: 'accepted',
      message:
        'Accepted. Those dates are now held for this renter and cannot be freed ' +
        'again yet — cancelling arrives with payments.',
    });

    const done = screen.getByRole('status');
    expect(done).toHaveTextContent('Accepted.');
    expect(done).toHaveTextContent('cannot be freed again yet');
  });

  it('confirms a decline, and says what it did not do', () => {
    // A decline frees nothing and locks nothing (§7.1), so the other requests
    // are untouched. Saying so is what stops an owner assuming otherwise.
    at([aRequest()], {
      status: 'declined',
      message: 'Declined. The dates stay open, and other requests are unaffected.',
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      'other requests are unaffected',
    );
  });

  it('shows a refusal as an alert, in the API’s own words', () => {
    const taken =
      'Those dates have just been taken by another booking, so this request can no ' +
      'longer be accepted. The renter has not been charged, and the request has been ' +
      'left as it was.';

    at([aRequest()], { status: 'error', message: taken });

    expect(screen.getByRole('alert')).toHaveTextContent(taken);
  });

  it('moves focus to the outcome rather than to an empty box', () => {
    // 4.5b's finding: the focus anchor must wrap whatever changed, or a
    // keyboard user gets a `:focus-visible` ring painted around nothing.
    at([aRequest()], { status: 'error', message: 'Something went wrong.' });

    expect(document.activeElement?.textContent ?? '').toContain(
      'Something went wrong.',
    );
  });
});

describe('several requests', () => {
  it('lists each with its own pair of controls', () => {
    at([
      aRequest({ id: 'booking-1', conflictCount: 1 }),
      aRequest({ id: 'booking-2', conflictCount: 1, startDate: '2026-09-17' }),
    ]);

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row).getByRole('button', { name: 'Accept' })).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    }
  });

  it('counts them in the heading', () => {
    at([aRequest({ id: 'booking-1' }), aRequest({ id: 'booking-2' })]);

    expect(screen.getByRole('heading', { name: /Requests/ })).toHaveTextContent('(2)');
  });
});

/**
 * The damage security an owner sees before accepting (§8.7.2, slice 5.5b-ii).
 *
 * §8.7.2 requires the values *"shown to both parties before booking"*. The
 * owner's commitment is the acceptance, so this is the surface that discharges
 * their half — and `DamageHold` owns the wording, so these prove it is *here*
 * and about the right person, not what it says.
 */
describe('the damage security on a request', () => {
  it('tells the owner what stands behind the item', () => {
    render(<OwnerRequests listingId={LISTING} requests={[aRequest()]} />);

    expect(document.body.textContent).toContain('£75.00 held at collection');
    expect(document.body.textContent).toContain('sits on the renter’s own card');
  });

  /**
   * **It is not money the owner receives**, and the row above it is. §3.4 pays
   * an owner their charge less commission; an owner who read the hold as theirs
   * would be expecting £75 that is never theirs.
   */
  it('does not read as part of what the owner is paid', () => {
    render(<OwnerRequests listingId={LISTING} requests={[aRequest()]} />);

    expect(document.body.textContent).toContain('not part of what you are paid');
    // The owner's own figure is still the one labelled as theirs.
    expect(document.body.textContent).toContain('at your rates');
  });

  /**
   * **An unsecured handover is a decision the owner is told about**, not a
   * silence. §8.7.2 permits a category configured to require no security, and an
   * owner who is not told will assume something is held.
   */
  it('says plainly when nothing will be held', () => {
    render(
      <OwnerRequests
        listingId={LISTING}
        requests={[aRequest({ appliedExcess: null })]}
      />,
    );

    expect(document.body.textContent).toContain('No hold for this item');
    expect(document.body.textContent).not.toContain('held at collection');
  });
});
