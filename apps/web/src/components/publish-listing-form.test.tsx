import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PublicationActionState } from '../app/listings/[id]/publication-state';

/**
 * The publish control and its refusal (§8.3, slice 2.8a).
 *
 * The server action is mocked, as in every form test here — it imports
 * `next/headers` and Clerk. What is asserted is the component's contract with
 * the owner reading it: that a refusal names every unmet requirement, that it
 * does not promise an edit route that does not exist, and that the control
 * disappears once there is nothing left to do.
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
   * No dead controls. A button that would always be refused — or worse, would
   * silently succeed and change nothing — is worse than no button.
   */
  it('offers no control, because there is nothing left to do', () => {
    given({ status: 'idle', message: null, blockers: [] });
    render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="PUBLISHED"
        publicationAvailable
      />,
    );

    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull();
  });

  /**
   * **It does not repeat "this is published".** The status line at the top of
   * the page owns that and says it first; this said it again in different words,
   * which made the page state one fact twice as though they were two. Found by
   * publishing a listing and reading the whole page rather than the part that
   * had just changed.
   */
  it('says only what the status line cannot — that there is no way back yet', () => {
    given({ status: 'idle', message: null, blockers: [] });
    const { container } = render(
      <PublishListingForm
        listingId={LISTING_ID}
        status="PUBLISHED"
        publicationAvailable
      />,
    );

    expect(container.textContent).toMatch(/pausing and archiving/i);
    expect(container.textContent).not.toMatch(/^Published\./);
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
   * **The copy must not promise an edit route that does not exist.** A listing
   * is immutable once created — there is no PUT on the API and no form that
   * would call one — and "edit the listing and try again" is advice nobody can
   * follow. Found by reading the refusal rather than by checking it appeared.
   */
  it('does not tell somebody to edit a listing that cannot be edited', () => {
    given({ status: 'not-ready', message: 'Not ready.', blockers });
    const { container } = render(
      <PublishListingForm listingId={LISTING_ID} status="DRAFT" publicationAvailable />,
    );

    expect(container.textContent).not.toMatch(/edit the listing/i);
    expect(container.textContent).toMatch(/cannot be edited yet/i);
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
      message: 'Your session has expired. Sign in again.',
      blockers: [],
    });
    render(
      <PublishListingForm listingId={LISTING_ID} status="DRAFT" publicationAvailable />,
    );

    expect(screen.getByRole('alert').textContent).toMatch(/session has expired/i);
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
