import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Money, Time } from '@platform/core';
import type { Booking, RentalQuote } from '@platform/contracts';
import type { RequestPanelState } from '../app/hire/[id]/request-state';

/**
 * The renter's request panel, as a renter meets it (slice 4.5b).
 *
 * The server action is mocked, as in every other form test here — it imports
 * `@clerk/nextjs/server` and `next/headers`. What is asserted is what the panel
 * *says*: which figure is the headline, what the postcode is for, that a refusal
 * keeps what was typed, that the expiry names a timezone, and — the one that
 * matters most — that the confirmation promises no notification, because there
 * is no notification channel and will not be until Phase 6.
 *
 * **That last group is the standing lesson from the Phase 0–3 audit**: a green
 * suite cannot see a false sentence, so the sentences are what these assert.
 */

const state = vi.hoisted(() => ({
  current: {
    status: 'idle',
    submitted: { startDate: '', endDate: '', postcode: '' },
  } as
    | RequestPanelState
    | {
        status: 'idle';
        submitted: { startDate: string; endDate: string; postcode: string };
      },
}));

vi.mock('../app/hire/[id]/actions', () => ({ requestPanelAction: vi.fn() }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { RequestPanel, SignInToBook } = await import('./request-panel');

const LISTING = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-08-18';

const A_QUOTE: RentalQuote = {
  id: '33333333-3333-4333-8333-333333333333',
  listingId: LISTING,
  startDate: '2026-08-20',
  endDate: '2026-08-22',
  days: 3,
  postcode: 'BS7 8AA',
  lineItems: [
    {
      unit: 'day',
      count: 3,
      unitPrice: { amount: 1_800, currency: 'GBP' },
      subtotal: { amount: 5_400, currency: 'GBP' },
    },
  ],
  itemCharge: { amount: 5_400, currency: 'GBP' },
  renterFee: { amount: 432, currency: 'GBP' },
  minimumFeeApplied: false,
  total: { amount: 5_832, currency: 'GBP' },
  appliedExcess: { amount: { amount: 7_500, currency: 'GBP' }, boundBy: 'floor' },
  // 11:30 in Europe/London, because August is BST. That is the point of the
  // assertion below: an expiry rendered in UTC would read 10:30.
  expiresAt: '2026-08-18T10:30:00.000Z',
};

const A_BOOKING: Booking = {
  id: '44444444-4444-4444-8444-444444444444',
  listingId: LISTING,
  state: 'REQUESTED',
  startDate: '2026-08-20',
  endDate: '2026-08-22',
  days: 3,
  itemTitle: 'Petrol hedge trimmer, 60cm blade',
  categoryName: 'Outdoor & gardening',
  itemCharge: { amount: 5_400, currency: 'GBP' },
  renterFee: { amount: 432, currency: 'GBP' },
  total: { amount: 5_832, currency: 'GBP' },
  appliedExcess: A_QUOTE.appliedExcess,
  lineItems: A_QUOTE.lineItems,
  requestExpiresAt: '2026-08-20T09:00:00.000Z',
  events: [
    {
      type: 'requested',
      fromState: null,
      toState: 'REQUESTED',
      at: '2026-08-18T09:00:00.000Z',
    },
  ],
};

function at(next: RequestPanelState) {
  state.current = next;
  render(<RequestPanel listingId={LISTING} today={TODAY} />);
}

const text = () => document.body.textContent ?? '';

/**
 * Pay the one-off cost here, so no test is billed for it.
 *
 * **Session 44's lesson, applied before being bitten by it.** A file's first
 * test is charged for the whole file's setup, and with sixteen workers on
 * sixteen cores that crossed five seconds about one run in ten — always
 * reported as *"Test timed out in 5000ms"*, which reads as a hang. Here the cost
 * is Luxon building an `Intl` formatter the first time a date is rendered: the
 * first quote assertion measured **4985 ms against a 5000 ms budget** before
 * this hook existed, which is a flake that had not happened yet.
 *
 * **No timeout was raised.** A longer one would have buried the diagnosis rather
 * than fixed it — the same call the fix in #121 made.
 */
beforeAll(() => {
  Money.format({ amount: 1, currency: 'GBP' });
  Time.formatLocalDate('2026-08-20');
  Time.formatLocal(Time.fromIsoUtc('2026-08-18T10:30:00.000Z'));
});

describe('a stranger with no session', () => {
  it('is offered a way in rather than a form that would fail', () => {
    /*
     * **The Phase 0–3 audit's worst defect, on the page with the largest
     * audience.** `/hire/…` is the one route a signed-out visitor is meant to
     * reach and both routes behind the panel need a session, so the choice is
     * made before anything is submitted.
     */
    render(<SignInToBook listingId={LISTING} />);

    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('First day')).toBeNull();
  });

  it('comes back to this listing after signing in', () => {
    // Clerk preserves `redirect_url` through its whole flow. Without it the
    // fallback sends them to the home page, having lost the item they were
    // looking at.
    render(<SignInToBook listingId={LISTING} />);

    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `/sign-in?redirect_url=${encodeURIComponent(`/hire/${LISTING}`)}`,
    );
  });

  it('never claims a session expired', () => {
    // Nobody reading this ever had one. Saying so was the exact sentence the
    // audit found on the header's primary call to action.
    render(<SignInToBook listingId={LISTING} />);

    expect(text()).not.toContain('expired');
  });
});

describe('asking for a price', () => {
  it('asks for both dates and a postcode', () => {
    // §8.5.2: "a listing page must collect both before displaying a committed
    // price". A quote produced without a postcode is incomplete and must not be
    // presented as a firm total.
    at({ status: 'idle', submitted: { startDate: '', endDate: '', postcode: '' } });

    expect(screen.getByLabelText('First day')).toBeInTheDocument();
    expect(screen.getByLabelText('Last day')).toBeInTheDocument();
    expect(screen.getByLabelText('Your postcode')).toBeInTheDocument();
  });

  it('says what the postcode is for, where it is asked for', () => {
    // A postcode is personal data and the reason it is required is not obvious
    // from a price that does not yet depend on it.
    at({ status: 'idle', submitted: { startDate: '', endDate: '', postcode: '' } });

    expect(text()).toContain('never shown to the owner before you book');
  });

  it('bounds the date controls at the platform’s today, not the browser’s', () => {
    // The prop is computed on the server in `Europe/London`. A browser deriving
    // it would derive it in the device's zone.
    at({ status: 'idle', submitted: { startDate: '', endDate: '', postcode: '' } });

    expect(screen.getByLabelText('First day')).toHaveAttribute('min', TODAY);
    expect(screen.getByLabelText('Last day')).toHaveAttribute('min', TODAY);
  });

  it('says a price commits nobody to anything', () => {
    at({ status: 'idle', submitted: { startDate: '', endDate: '', postcode: '' } });

    expect(text()).toContain('books nothing and costs nothing');
  });
});

describe('a refusal', () => {
  const REFUSED =
    'This hire is longer than this category allows. The longest is 30 days.';
  const TYPED = { startDate: '2026-08-20', endDate: '2026-11-20', postcode: 'BS7 8AA' };

  it('shows the API’s own sentence, verbatim and as an alert', () => {
    // The refusal is decided where the rule is, and written for the person who
    // chose the dates. This layer has nothing to add to it.
    at({ status: 'error', message: REFUSED, submitted: TYPED });

    expect(screen.getByRole('alert')).toHaveTextContent(REFUSED);
  });

  it('keeps every value that was typed', () => {
    /*
     * **React 19 resets an uncontrolled form when its action completes**, which
     * is right for one that succeeded and is how 2.4c-i, 2.5a, 2.7a and 4.3b
     * each lost somebody's typing. Three fields here, and a refusal that emptied
     * them would leave somebody retyping dates that were nearly right.
     */
    at({ status: 'error', message: REFUSED, submitted: TYPED });

    expect(screen.getByLabelText('First day')).toHaveValue(TYPED.startDate);
    expect(screen.getByLabelText('Last day')).toHaveValue(TYPED.endDate);
    expect(screen.getByLabelText('Your postcode')).toHaveValue(TYPED.postcode);
  });
});

describe('the quote', () => {
  it('shows the inclusive total as the headline', () => {
    // §3.4.4: the total inclusive of mandatory fees is the headline, and the
    // bare item charge may never be shown as the price.
    at({ status: 'quoted', quote: A_QUOTE });

    expect(text()).toContain('£58.32');
    expect(text()).toContain('in total, fees included');
  });

  it('shows the arithmetic in the owner’s own rate units', () => {
    // §6.2's line items are what turn a total into a sentence somebody can be
    // told. The unit price is named so a renter can check it against the
    // listing's own rates.
    at({ status: 'quoted', quote: A_QUOTE });

    expect(text()).toContain('3 days at £18.00 each');
    expect(text()).toContain('£54.00');
    expect(text()).toContain('£4.32');
  });

  it('does not repeat the damage-hold disclosure the listing card already makes', () => {
    /*
     * **This asserted the opposite until the page was read.** §3.4.4 requires the
     * refundable security shown separately from the headline, and the panel said
     * so — but the listing's own price block says it directly above, in the same
     * card, visible at the same time. The result was one sentence twice about
     * fifteen lines apart, which reads as carelessness rather than emphasis.
     *
     * The rule is still kept once, and pinned where it is made:
     * `public-listing.test.tsx`'s *"says a refundable hold may apply"*. This is
     * the guard against somebody helpfully adding it back.
     */
    at({ status: 'quoted', quote: A_QUOTE });

    expect(text()).not.toContain('refundable damage hold');
  });

  it('moves focus to the price rather than to an empty box beside it', () => {
    /*
     * **Found by reading the page, and invisible to every other assertion here.**
     * The panel focuses whatever just changed so a keyboard user is taken to it.
     * That anchor used to be one fixed wrapper that only ever *contained* the
     * refusal — so a successful quote focused an empty div and Chrome painted a
     * `:focus-visible` ring around nothing: a stray blue bar between the heading
     * and the price. The ring was right; it was framing the wrong element.
     */
    at({ status: 'quoted', quote: A_QUOTE });

    expect(document.activeElement?.textContent ?? '').toContain('£58.32');
  });

  it('moves focus to the refusal when there is one', () => {
    // The other half of the same rule, and the case that always worked.
    at({
      status: 'error',
      message: 'That price has expired.',
      submitted: {
        startDate: '2026-08-20',
        endDate: '2026-08-22',
        postcode: 'BS7 8AA',
      },
    });

    expect(document.activeElement?.textContent ?? '').toContain(
      'That price has expired.',
    );
  });

  it('says when the price stops holding, and in which timezone', () => {
    /*
     * **The one instant on this panel.** Rendered in the platform's timezone
     * with the timezone said out loud — 11:30 BST, not the 10:30 the UTC string
     * carries and not whatever the reader's device thinks.
     */
    at({ status: 'quoted', quote: A_QUOTE });

    expect(text()).toContain('11:30');
    expect(text()).toContain('UK time');
  });

  it('shows the dates as text, with nothing left to edit', () => {
    /*
     * **The reason the two steps are exclusive.** A form still showing editable
     * dates beside a quote is one where somebody changes a date, presses
     * *Request this hire*, and is committed to a price computed from a different
     * period.
     */
    at({ status: 'quoted', quote: A_QUOTE });

    expect(text()).toContain('20 Aug 2026 to 22 Aug 2026');
    expect(screen.queryByLabelText('First day')).toBeNull();
    expect(screen.queryByLabelText('Last day')).toBeNull();
  });

  it('offers both asking for it and going back', () => {
    at({ status: 'quoted', quote: A_QUOTE });

    expect(
      screen.getByRole('button', { name: 'Request this hire' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change dates' })).toBeInTheDocument();
  });

  it('says a request is not a booking and charges nothing', () => {
    // §7.1: a request reserves nothing and the owner has to accept it. A panel
    // that read as a checkout would be describing a platform we have not built.
    at({ status: 'quoted', quote: A_QUOTE });

    expect(text()).toContain('Requesting is not a booking');
    expect(text()).toContain('nothing is charged now');
  });

  it('names the minimum fee when it is the fee that bound', () => {
    // §3.4.2's floor. Saying so is what stops a renter reading our percentage
    // off a short hire and concluding it is wrong.
    at({
      status: 'quoted',
      quote: { ...A_QUOTE, minimumFeeApplied: true },
    });

    expect(text()).toContain('Our fee (our minimum)');
  });
});

describe('once it has been requested', () => {
  it('names what was asked for, for when, and what it would cost', () => {
    at({ status: 'requested', booking: A_BOOKING });

    expect(text()).toContain('Petrol hedge trimmer, 60cm blade');
    expect(text()).toContain('20 Aug 2026');
    expect(text()).toContain('£58.32');
  });

  it('says by when the owner has to answer', () => {
    // §8.6's deadline, computed from the category's configured hours at the
    // moment of the request (4.5a). 10:00 BST from a 09:00Z instant.
    at({ status: 'requested', booking: A_BOOKING });

    expect(text()).toContain('10:00');
    expect(text()).toContain('to accept or decline');
  });

  it('promises no notification, because there is none', () => {
    /*
     * **The most important assertion in this file.** Notifications are Phase 6
     * — no email channel, no verified domain, no templates — and 4.7 only emits
     * the events. A confirmation saying "we'll email you" would be the same
     * class of false sentence the Phase 0–3 audit found three of, on the page
     * most people will read.
     */
    at({ status: 'requested', booking: A_BOOKING });

    expect(text()).toContain('We cannot tell you their answer yet');
    expect(text()).not.toContain('email you');
    expect(text()).not.toContain('notify');
    expect(text()).not.toContain("We'll let you know");
  });

  it('says the confirmation is not saved anywhere they can return to', () => {
    // A renter's own view of their requests is 4.8's dashboard. Until it exists
    // this panel is the only place this booking has been shown, and somebody who
    // reloads loses it. Saying so is the difference between a known gap and a
    // page that quietly forgets.
    at({ status: 'requested', booking: A_BOOKING });

    expect(text()).toContain('not saved anywhere you can return to');
  });

  it('offers no link back to the listing it is already sitting on', () => {
    /*
     * **It had one, and reading the page is what showed it was nonsense.** The
     * panel lives *on* the listing, so "Back to the listing" named a destination
     * the reader was already at — and following it reloaded the page, which threw
     * the confirmation away. A link whose only effect is to lose what it is
     * attached to is worse than no link.
     */
    at({ status: 'requested', booking: A_BOOKING });

    expect(screen.queryByRole('link')).toBeNull();
  });

  it('offers nothing to press that would request it again', () => {
    // The form is replaced rather than left beside the confirmation: a second
    // press would create a second identical request, and `REQUESTED` is
    // deliberately non-blocking (§7.1) so nothing downstream would refuse it.
    at({ status: 'requested', booking: A_BOOKING });

    expect(screen.queryByRole('button')).toBeNull();
  });
});
