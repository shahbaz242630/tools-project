import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CategoryAttribute, PublicListing } from '@platform/contracts';
import { PublicListingView } from './public-listing';

/**
 * The public listing page's rendering (slice 2.10).
 *
 * **Two things are under test and they are not the layout.** The first is
 * disclosure: this is the only page in the app a stranger reads, so what it does
 * *not* say matters more than what it does. The second is the price, which
 * §3.4.4 makes a legal question rather than a presentational one — drip pricing
 * is prohibited by the DMCC regime, and the bare rate is on the response one
 * careless line away from being rendered as the headline.
 */

const ATTRIBUTES: readonly CategoryAttribute[] = [
  {
    key: 'power_source',
    label: 'Power source',
    required: true,
    type: 'choice',
    options: [
      { value: 'petrol', label: 'Petrol' },
      { value: 'cordless', label: 'Cordless battery' },
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
  {
    key: 'condition_notes',
    label: 'Condition notes',
    required: false,
    type: 'text',
    maxLength: 200,
  },
];

function listing(over: Partial<PublicListing> = {}): PublicListing {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Petrol hedge trimmer',
    description: 'Serviced last spring.',
    categorySlug: 'outdoor-gardening',
    categoryName: 'Outdoor and gardening',
    categoryAttributes: ATTRIBUTES,
    // `condition_notes` deliberately unanswered — see the disclosure tests.
    attributes: { power_source: 'petrol', weight_kg: 52 },
    transportRequirement: 'car_boot',
    requiresTwoPersonLift: false,
    location: { outwardCode: 'BS7', town: 'Bristol' },
    inclusiveDailyPrice: {
      rate: { amount: 1_800, currency: 'GBP' },
      renterFee: { amount: 144, currency: 'GBP' },
      total: { amount: 1_944, currency: 'GBP' },
      minimumFeeApplied: false,
    },
    rates: {
      daily: { amount: 1_800, currency: 'GBP' },
      weekend: null,
      weekly: null,
    },
    ownerStatus: 'private_owner',
    ...over,
  };
}

/**
 * A stand-in for whatever the page puts in the booking slot (slice 4.5b).
 *
 * **Deliberately not the real panel.** This component's job is to be certain
 * about what a stranger may see, and the panel's is to price a hire; testing
 * them together would mean every disclosure assertion here also depended on a
 * server action. What is worth asserting is that the slot is rendered and that
 * nothing is chosen for it, and a marker proves both.
 */
const A_PANEL = <div data-testid="request-panel">the booking panel</div>;

describe('what the page shows', () => {
  it('renders the category’s own fields without knowing what they are', () => {
    // The exit gate of this phase, on the page a stranger reads. Nothing here
    // knows what `outdoor-gardening` contains.
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(screen.getByText('Power source')).toBeTruthy();
    expect(screen.getByText('Petrol')).toBeTruthy();
  });

  it('reads a scaled number back through its definition', () => {
    // A stored 52 means 5.2 kg, and only the pinned definition says so
    // (ADR 0029). Rendering the raw integer would advertise a 52 kg trimmer.
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(screen.getByText('5.2 kg')).toBeTruthy();
  });

  it('shows the district and the town', () => {
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(document.body.textContent).toContain('BS7, Bristol');
  });

  it('says the exact address comes later, so nobody reads the district as precise', () => {
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(document.body.textContent).toContain('exact address is shared once a');
  });
});

describe('the price', () => {
  it('leads with the total including the fee, not the owner’s rate', () => {
    /*
     * **§3.4.4, and the failure is silent.** £18.00 is the owner's rate and
     * £19.44 is what a renter pays. Showing the first as the headline and the
     * fee at checkout is drip pricing, which the DMCC prohibits — and it would
     * look completely normal on screen.
     */
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    const headline = screen.getByText(/a day, fees included/);
    expect(headline.textContent).toContain('£19.44');
    expect(headline.textContent).not.toContain('£18.00');
  });

  it('discloses what the fee is, which is the other half of the same rule', () => {
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(document.body.textContent).toContain('£18.00');
    expect(document.body.textContent).toContain('£1.44');
  });

  it('says a refundable hold may apply, and that it is not part of the price', () => {
    // §3.4.4 requires the damage security to be shown separately and never
    // folded into the headline. The amount is Phase 5; the disclosure is not.
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(document.body.textContent).toContain('refundable damage hold');
    expect(document.body.textContent).toContain('never part of the price');
  });

  it('explains a bound minimum fee, so “per day” is not misleading', () => {
    render(
      <PublicListingView
        requestPanel={A_PANEL}
        listing={listing({
          inclusiveDailyPrice: {
            rate: { amount: 500, currency: 'GBP' },
            renterFee: { amount: 100, currency: 'GBP' },
            total: { amount: 600, currency: 'GBP' },
            minimumFeeApplied: true,
          },
        })}
      />,
    );

    expect(document.body.textContent).toContain('longer hire costs less per day');
  });

  it('labels a weekly rate as the owner’s, because it carries no fee yet', () => {
    // Not an inclusive total: the fee on a week depends on the dates, which is
    // Phase 4's quote engine. A bare figure *labelled* as the owner's rate is
    // not drip pricing; showing it as the price would be.
    render(
      <PublicListingView
        requestPanel={A_PANEL}
        listing={listing({
          rates: {
            daily: { amount: 1_800, currency: 'GBP' },
            weekend: null,
            weekly: { amount: 9_000, currency: 'GBP' },
          },
        })}
      />,
    );

    expect(document.body.textContent).toContain('£90.00');
    expect(document.body.textContent).toContain('before our fee');
  });

  it('shows no longer-hire section when there is only a daily rate', () => {
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(document.body.textContent).not.toContain('Longer hires');
  });
});

describe('who you would be renting from', () => {
  it('states that the owner is a private individual', () => {
    // BRD §8.3's consumer-law disclosure, in the body of the page rather than
    // in small print: a renter has materially stronger rights against a
    // business, so they are entitled to know before they book.
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(document.body.textContent).toContain('A private individual');
    expect(document.body.textContent).toContain('lending their own item');
  });

  it('says plainly that this is not a business', () => {
    // The useful half. "Private individual" is the legal term and means
    // little to somebody who has not met it; "not a business" is the fact they
    // can act on.
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(document.body.textContent).toContain('Not a business');
    expect(document.body.textContent).toContain('rights differ');
  });

  it('renders from the field rather than a fixed sentence', () => {
    /*
     * Only private owners can publish today, so this case is unreachable
     * through the API — and asserted anyway, because the failure it guards is a
     * hardcoded sentence going on being printed after it stops being true. The
     * day traders are supported the page needs no edit.
     */
    render(
      <PublicListingView
        requestPanel={A_PANEL}
        listing={listing({ ownerStatus: 'professional_trader' })}
      />,
    );

    expect(document.body.textContent).toContain('A business');
    expect(document.body.textContent).not.toContain('A private individual');
  });
});

describe('what the page deliberately does not show', () => {
  it('omits an unanswered attribute rather than listing it as missing', () => {
    /*
     * The owner's page says *"not answered yet — needed before you can
     * publish"*, which is their to-do list. A public page repeating that is a
     * page about our form rather than about the item, and it tells a stranger
     * what somebody has not filled in.
     */
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(screen.queryByText('Condition notes')).toBeNull();
    expect(document.body.textContent).not.toContain('Not answered');
    expect(document.body.textContent).not.toContain('before you can publish');
  });

  it('renders the booking slot it was given, and invents nothing for it', () => {
    /*
     * **This test used to assert the opposite** — that there was no control and
     * a sentence saying booking was not open (2.10). BRD §15 forbids a control
     * that calls no real behaviour, and until 4.5a there was none to call. There
     * is now, so the sentence would be false and the assertion pinning it would
     * have kept it true-looking.
     *
     * What survives is the part that is still a rule: this component **chooses
     * no panel of its own**. Whether a visitor is signed in is the page's to
     * know, and an auth branch in here would put a session check inside the one
     * component whose job is certainty about what a stranger may see.
     */
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(screen.getByTestId('request-panel')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Booking is not open yet');
    // No control of its own — every button on this page comes from the slot.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing that looks like an owner or a status', () => {
    // The projection carries none of it, so this is a guard against somebody
    // widening `PublicListing` and wiring the new field in here without
    // noticing what page they are on.
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('PUBLISHED');
    expect(text).not.toContain('APPROVED');
    expect(text).not.toMatch(/owner’s account|listed by/i);
  });
});

describe('collecting it', () => {
  it('names the vehicle a renter needs, and what it means', () => {
    render(<PublicListingView requestPanel={A_PANEL} listing={listing()} />);

    expect(document.body.textContent).toContain('Car boot');
    expect(document.body.textContent).toContain('boot of an ordinary car');
  });

  it('warns about a two-person lift, because somebody may travel alone', () => {
    render(
      <PublicListingView
        requestPanel={A_PANEL}
        listing={listing({ requiresTwoPersonLift: true })}
      />,
    );

    expect(document.body.textContent).toContain('two people to lift');
    expect(document.body.textContent).toContain('Bring somebody');
  });

  it('says so plainly when the owner has not stated a requirement', () => {
    // A category configured before 2.4c-i offers no options, so its listings
    // cannot state one and publication does not demand it. Silence would read
    // as "anything will do".
    render(
      <PublicListingView
        requestPanel={A_PANEL}
        listing={listing({ transportRequirement: null })}
      />,
    );

    expect(document.body.textContent).toContain('has not said what is needed');
  });
});
