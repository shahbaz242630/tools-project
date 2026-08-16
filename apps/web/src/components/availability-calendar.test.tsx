import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Time } from '@platform/core';
import type { ListingAvailability } from '@platform/contracts';

/**
 * The owner's calendar, as an owner meets it (slice 4.3b).
 *
 * The server actions are mocked, as in every other form test here — they import
 * `@clerk/nextjs/server` and `next/headers`. What is asserted is what the page
 * *says*: which days it draws as unavailable, that the state of a day is
 * readable without seeing a colour, that a period spanning in from last month
 * shades the right days, and that the private note is described as private on
 * the control where somebody decides whether to write one.
 *
 * **The last of those is the standing lesson from the Phase 0–3 audit**: a green
 * suite cannot see a false sentence, so the sentences are what these assert.
 */

const NOTHING_TYPED = { startDate: '', endDate: '', reason: '' };

const state = vi.hoisted(() => ({
  current: {
    status: 'idle' as 'idle' | 'error',
    message: '',
    submitted: { startDate: '', endDate: '', reason: '' },
  },
}));

vi.mock('../app/listings/[id]/calendar/actions', () => ({
  blockPeriodAction: vi.fn(),
  unblockPeriodAction: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { AvailabilityCalendar } = await import('./availability-calendar');

const LISTING = '11111111-1111-4111-8111-111111111111';

const AUGUST: ListingAvailability = {
  month: '2026-08',
  blocks: [
    // Runs in from July, which is the case a calendar drawing only contained
    // periods gets wrong.
    { id: 'b1', startDate: '2026-07-28', endDate: '2026-08-03', reason: 'Away' },
    { id: 'b2', startDate: '2026-08-20', endDate: '2026-08-22', reason: null },
  ],
};

function idle() {
  state.current = { status: 'idle', message: '', submitted: NOTHING_TYPED };
}

const dayCell = (date: string) => screen.getByLabelText(new RegExp(`^${date}`));

describe('the month grid', () => {
  it('draws every day of the month and no more', () => {
    idle();
    render(<AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />);

    // August has 31 days. A grid built by adding days until the month changes
    // gets February and a leap year right for free; a hard-coded 30 does not.
    expect(screen.getAllByRole('gridcell')).toHaveLength(31 + offsetOfAugust2026());
    expect(dayCell('1 Aug 2026')).toBeInTheDocument();
    expect(dayCell('31 Aug 2026')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^1 Sep 2026/)).not.toBeInTheDocument();
  });

  it('says whether a day is available in words, not only in a colour', () => {
    /*
     * **The accessibility of the whole page turns on this.** A grid where
     * "unavailable" is a shade of grey says nothing to a screen reader and
     * little to anybody who cannot separate the two shades — and this is the
     * only rendering of the calendar that a sighted owner scans.
     */
    idle();
    render(<AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />);

    expect(dayCell('20 Aug 2026')).toHaveAccessibleName('20 Aug 2026: unavailable');
    expect(dayCell('19 Aug 2026')).toHaveAccessibleName('19 Aug 2026: available');
  });

  it('shades a period that began in the previous month', () => {
    idle();
    render(<AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />);

    // The 1st to the 3rd are covered by a block that starts on 28 July. Drawing
    // them as free would tell an owner dates are bookable that the API refuses.
    expect(dayCell('1 Aug 2026')).toHaveAccessibleName('1 Aug 2026: unavailable');
    expect(dayCell('3 Aug 2026')).toHaveAccessibleName('3 Aug 2026: unavailable');
    expect(dayCell('4 Aug 2026')).toHaveAccessibleName('4 Aug 2026: available');
  });

  it('blocks the last day named and frees the one after it', () => {
    // The inclusive end, from the outside. Off by one here loses a day of every
    // back-to-back hire, or blocks one the owner never named.
    idle();
    render(<AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />);

    expect(dayCell('22 Aug 2026')).toHaveAccessibleName('22 Aug 2026: unavailable');
    expect(dayCell('23 Aug 2026')).toHaveAccessibleName('23 Aug 2026: available');
  });
});

describe('moving between months', () => {
  it('links to the month either side, by name', () => {
    idle();
    render(<AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />);

    expect(screen.getByRole('link', { name: /July 2026/ })).toHaveAttribute(
      'href',
      `/listings/${LISTING}/calendar?month=2026-07`,
    );
    expect(screen.getByRole('link', { name: /September 2026/ })).toHaveAttribute(
      'href',
      `/listings/${LISTING}/calendar?month=2026-09`,
    );
  });

  it('crosses a year end without arithmetic of its own', () => {
    idle();
    render(
      <AvailabilityCalendar
        listingId={LISTING}
        calendar={{ month: '2026-12', blocks: [] }}
      />,
    );

    expect(screen.getByRole('link', { name: /January 2027/ })).toHaveAttribute(
      'href',
      `/listings/${LISTING}/calendar?month=2027-01`,
    );
  });
});

describe('the list of periods', () => {
  it('describes a period in words and offers to remove it', () => {
    idle();
    render(<AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />);

    expect(screen.getByText('20 Aug 2026 to 22 Aug 2026')).toBeInTheDocument();
    // Named by its dates, because "Remove" five times down a page tells a
    // screen-reader user nothing about which period they are on.
    expect(
      screen.getByRole('button', { name: /Remove 20 Aug 2026 to 22 Aug 2026/ }),
    ).toBeInTheDocument();
  });

  it('renders a single-day period as one date, not as a range', () => {
    idle();
    render(
      <AvailabilityCalendar
        listingId={LISTING}
        calendar={{
          month: '2026-08',
          blocks: [
            { id: 'b3', startDate: '2026-08-20', endDate: '2026-08-20', reason: null },
          ],
        }}
      />,
    );

    expect(screen.getByText('20 Aug 2026')).toBeInTheDocument();
    expect(screen.queryByText(/20 Aug 2026 to/)).not.toBeInTheDocument();
  });

  it('shows the owner’s own note back to them', () => {
    idle();
    render(<AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />);

    expect(screen.getByText('Away')).toBeInTheDocument();
  });

  it('says a quiet month is bookable rather than showing nothing', () => {
    // An empty region reads as a page that failed to load. It is a real answer:
    // every date is available.
    idle();
    render(
      <AvailabilityCalendar
        listingId={LISTING}
        calendar={{ month: '2026-11', blocks: [] }}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain('every date is available');
  });
});

describe('the form', () => {
  it('labels the last day as inclusive and the note as private', () => {
    /*
     * **Both sentences are load-bearing.** "End date" is the word that makes
     * somebody wonder whether the last day is included, and the note promise is
     * a real guarantee — nothing serves `reason` to anybody but its author — so
     * it is said where the decision to write one is made rather than afterwards.
     */
    idle();
    render(<AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />);

    expect(screen.getByLabelText('First day')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Last day')).toHaveAttribute('type', 'date');

    const note = screen.getByLabelText(/A note, just for you/);
    expect(note).toBeInTheDocument();
    expect(screen.getByText(/Only you ever see this/).textContent).toContain(
      'never why',
    );
  });

  it('carries the listing id, so the action knows what it is blocking', () => {
    idle();
    const { container } = render(
      <AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />,
    );

    expect(container.querySelector('input[name="listingId"]')).toHaveValue(LISTING);
  });

  it('shows a refusal where somebody will see it', () => {
    state.current = {
      status: 'error',
      message: 'That period has already finished, so blocking it would change nothing.',
      submitted: NOTHING_TYPED,
    };
    render(<AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />);

    const [alert] = screen.getAllByRole('alert');
    expect(within(alert!).getByText(/already finished/)).toBeInTheDocument();
  });

  it('keeps what was typed when the dates are refused', () => {
    /*
     * **Found by pressing the button, not by a test.** React 19 resets an
     * uncontrolled form once its action completes, so the first version of this
     * page emptied both date fields behind the explanation of why they were
     * refused — leaving somebody to retype dates that were nearly right. It is
     * the fourth time this codebase has met that reset (2.4c-i, 2.5a, 2.7a).
     */
    state.current = {
      status: 'error',
      message: 'That period has already finished.',
      submitted: { startDate: '2026-08-01', endDate: '2026-08-10', reason: 'Away' },
    };
    render(<AvailabilityCalendar listingId={LISTING} calendar={AUGUST} />);

    expect(screen.getByLabelText('First day')).toHaveValue('2026-08-01');
    expect(screen.getByLabelText('Last day')).toHaveValue('2026-08-10');
    expect(screen.getByLabelText(/A note, just for you/)).toHaveValue('Away');
  });
});

/**
 * How many blank cells precede 1 August 2026.
 *
 * **Derived from the same primitive the grid uses**, rather than written as a
 * number, so this asserts *"31 days plus however many blanks the offset needs"*
 * — the count of `gridcell`s — without restating the layout of one particular
 * month. 1 August 2026 is a Saturday, so it is five in a Monday-first week.
 */
function offsetOfAugust2026(): number {
  return Time.weekdayOf('2026-08-01') - 1;
}
