import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PublicationActionState } from '../app/listings/[id]/publication-state';

/**
 * The publish control and its refusal (§8.3, slice 2.8a).
 *
 * The server action is mocked, as in every form test here — it imports
 * `next/headers` and Clerk. What is asserted is the component's contract with
 * the owner reading it: that a refusal names every unmet requirement, that it
 * points at the control which fixes them, and that the control disappears once
 * there is nothing left to do.
 */
const state = vi.hoisted(() => ({
  current: {
    status: 'idle',
    message: null,
    blockers: [],
  } as PublicationActionState,
}));

vi.mock('../app/listings/[id]/actions', () => ({
  publishListingAction: vi.fn(),
  pauseListingAction: vi.fn(),
}));

vi.mock('../app/listings/[id]/publication-state', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, INITIAL_PUBLICATION_STATE: state.current };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useActionState: () => [state.current, vi.fn(), false] };
});

const { PublishListingForm } = await import('./publish-listing-form');

const LISTING_ID = '11111111-1111-4111-8111-111111111111';

function given(next: PublicationActionState) {
  state.current = next;
}

describe('a draft', () => {
  it('offers the control', () => {
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm listingId={LISTING_ID} status="DRAFT" publicationAvailable />,
    );

    expect(screen.getByRole('button', { name: /publish this listing/i })).toBeTruthy();
  });

  it('carries the listing id, so the action knows what to publish', () => {
    given({ status: 'idle', message: null, blockers: [] });
    const { container } = render(
      <PublishListingForm listingId={LISTING_ID} status="DRAFT" publicationAvailable />,
    );

    const hidden = container.querySelector('input[name="listingId"]');
    expect((hidden as HTMLInputElement | null)?.value).toBe(LISTING_ID);
  });
});

describe('a published listing', () => {
  /**
   * **This block asserted the absence of a control until 2.8b.** It said "offers
   * no control, because there is nothing left to do" and checked that the copy
   * read "pausing and archiving arrive in a later slice". Both were correct and
   * both are now wrong, which is what closing a gap looks like from the test
   * side.
   */
  it('offers the pause control', () => {
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="PUBLISHED"
        publicationAvailable
      />,
    );

    expect(screen.getByRole('button', { name: /pause this listing/i })).toBeTruthy();
  });

  it('does not offer publish, which would be a control that changes nothing', () => {
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="PUBLISHED"
        publicationAvailable
      />,
    );

    expect(screen.queryByRole('button', { name: /publish this listing/i })).toBeNull();
  });

  it('says pausing is reversible, before the button rather than after it', () => {
    given({ status: 'idle', message: null, blockers: [] });
    const { container } = render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="PUBLISHED"
        publicationAvailable
      />,
    );

    // The fear that stops somebody pressing a control like this is that it
    // cannot be undone. Saying so is the whole job of that sentence.
    expect(container.textContent).toMatch(/nothing is deleted/i);
    expect(container.textContent).toMatch(/put it back/i);
  });

  /**
   * The kill switch stops listings going public and has no business stopping one
   * being taken down — an incident is when somebody most needs to.
   */
  it('stays live while publishing is switched off platform-wide', () => {
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="PUBLISHED"
        publicationAvailable={false}
      />,
    );

    const button = screen.getByRole('button', { name: /pause this listing/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('a paused listing', () => {
  it('offers the way back, worded as resuming rather than publishing', () => {
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="PAUSED"
        publicationAvailable
      />,
    );

    expect(
      screen.getByRole('button', { name: /put this listing back up/i }),
    ).toBeTruthy();
  });

  /**
   * Resuming *is* publishing, so the kill switch reaches it. A resume button
   * that stayed live during an incident would be a second door into public view
   * past the switch that closed the first.
   */
  it('is disabled and explained when publishing is switched off', () => {
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="PAUSED"
        publicationAvailable={false}
      />,
    );

    const button = screen.getByRole('button', { name: /put this listing back up/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/paused across the whole/i);
  });

  it('tells a refused owner their listing is still paused, not still a draft', () => {
    given({
      status: 'not-ready',
      message: 'This listing is not ready to be published yet.',
      blockers: [{ field: 'description', message: 'A description is needed.' }],
    });
    const { container } = render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="PAUSED"
        publicationAvailable
      />,
    );

    // The reassurance after a refusal has to describe the state the listing is
    // actually in. "It is still a draft" to somebody looking at a paused listing
    // is the 2.8a status-line bug wearing different clothes.
    expect(container.textContent).toMatch(/still paused/i);
    expect(container.textContent).not.toMatch(/still a draft/i);
  });
});

describe('a refusal', () => {
  const blockers = [
    {
      field: 'description',
      message: 'A description is needed before this listing can be published.',
    },
    {
      field: 'rates.daily',
      message: 'A daily rate is needed before this listing can be published.',
    },
    {
      field: 'collectionLocation',
      message:
        'Where the item is collected from is needed before this listing can be published.',
    },
  ];

  it('lists every unmet requirement, not the first', () => {
    given({
      status: 'not-ready',
      message: 'This listing is not ready to be published yet.',
      blockers,
    });
    render(
      <PublishListingForm listingId={LISTING_ID} status="DRAFT" publicationAvailable />,
    );

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent)).toEqual(
      blockers.map((b) => b.message),
    );
  });

  it('announces itself, so a screen reader is told without moving', () => {
    given({
      status: 'not-ready',
      message: 'This listing is not ready to be published yet.',
      blockers,
    });
    render(
      <PublishListingForm listingId={LISTING_ID} status="DRAFT" publicationAvailable />,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
  });

  /**
   * **The copy must point at the control that fixes it, and this assertion used
   * to say the reverse.** Until the Phase 0–3 audit it read *"does not tell
   * somebody to edit a listing that cannot be edited"* and pinned the sentence
   * *"listings cannot be edited yet"* — correct when 2.8a wrote it, and turned
   * false by 2.9b, which shipped `@Put(LISTING_ROUTE)`, the edit form, and an
   * "Edit this listing" link on this very page. The test then held the refusal
   * in place: it told an owner to throw the listing away and re-key it, which
   * the audit rated the worst single finding across four phases.
   *
   * **So both halves are asserted.** The new advice has to be present, and the
   * old advice has to be gone — a component that says both would pass an
   * assertion written only one way round, and "list it again" is the more
   * destructive of the two instructions to leave lying about.
   */
  it('points at the edit form rather than telling somebody to start again', () => {
    given({ status: 'not-ready', message: 'Not ready.', blockers });
    const { container } = render(
      <PublishListingForm listingId={LISTING_ID} status="DRAFT" publicationAvailable />,
    );

    expect(container.textContent).toMatch(/edit this listing/i);
    expect(container.textContent).not.toMatch(/cannot be edited/i);
    expect(container.textContent).not.toMatch(/list the item again/i);
  });

  it('keeps the control, because the whole point is trying again', () => {
    given({ status: 'not-ready', message: 'Not ready.', blockers });
    render(
      <PublishListingForm listingId={LISTING_ID} status="DRAFT" publicationAvailable />,
    );

    expect(screen.getByRole('button', { name: /publish this listing/i })).toBeTruthy();
  });
});

describe('a failure that is not a refusal', () => {
  it('shows the message without a checklist', () => {
    given({
      status: 'error',
      message: 'You are not signed in. Your session may have expired — sign in again.',
      blockers: [],
    });
    render(
      <PublishListingForm listingId={LISTING_ID} status="DRAFT" publicationAvailable />,
    );

    expect(screen.getByRole('alert').textContent).toMatch(/you are not signed in/i);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});

/**
 * The platform-wide kill switch, as an owner meets it (slice H3b).
 *
 * H3a made the API refuse; this is the same fact offered *before* the button is
 * pressed rather than after. The button is disabled and explained, never hidden.
 */
describe('when publishing is switched off across the platform', () => {
  it('disables the button', () => {
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="DRAFT"
        publicationAvailable={false}
      />,
    );

    const button = screen.getByRole('button', { name: /publish this listing/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the button on the page rather than removing it', () => {
    // A control that vanishes leaves somebody looking for something that was
    // there yesterday, with nothing on the page accounting for it — which reads
    // as broken rather than as a deliberate pause.
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="DRAFT"
        publicationAvailable={false}
      />,
    );

    expect(
      screen.queryByRole('button', { name: /publish this listing/i }),
    ).toBeTruthy();
  });

  it('says it is the platform and not their listing', () => {
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="DRAFT"
        publicationAvailable={false}
      />,
    );

    const notice = screen.getByRole('status');
    expect(notice.textContent).toMatch(/paused across the whole platform/i);
    // The half that stops somebody hunting for a field to fix.
    expect(notice.textContent).toMatch(/nothing to do with your listing/i);
    expect(notice.textContent).toMatch(/saved, it is unchanged/i);
  });

  it('enables the button and says nothing while the switch is on', () => {
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm listingId={LISTING_ID} status="DRAFT" publicationAvailable />,
    );

    expect(
      (
        screen.getByRole('button', {
          name: /publish this listing/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('still shows the completeness blockers, because the owner can still work on it', () => {
    // Publishing being paused does not stop somebody getting their listing
    // ready. Hiding what is still missing would waste the pause.
    given({
      status: 'not-ready',
      message: 'Not ready.',
      blockers: [
        {
          field: 'description',
          message: 'A description is needed before this listing can be published.',
        },
      ],
    });
    render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="DRAFT"
        publicationAvailable={false}
      />,
    );

    expect(screen.queryAllByRole('listitem').length).toBeGreaterThan(0);
  });
});
