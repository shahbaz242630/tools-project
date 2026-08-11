import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  LISTING_STATUSES,
  MODERATION_STATES,
  isPubliclyVisible,
} from '@platform/contracts';
import type { ListingStatus, ModerationState, OwnerListing } from '@platform/contracts';
import { ModerationNotice, StatusLine } from './listing-visibility';

/**
 * What an owner is told about who can see their listing.
 *
 * **This file exists because one sentence has produced the same defect three
 * times** — 2.8a rendered "Draft" unconditionally, 2.8b's binary conditional
 * reinstated it for `PAUSED`, and before 2.8c-ii a moderated listing told its
 * owner it was published and bookable. Each time the line was derived from *one*
 * authority when the truth takes two, and each time a green suite said nothing.
 */

const REASON = 'Reported for a missing guard on the drum — checking with the owner';

function listing(over: Partial<OwnerListing>): OwnerListing {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    categorySlug: 'outdoor-gardening',
    categoryName: 'Outdoor and gardening',
    categoryVersionNumber: 1,
    categoryAttributes: [],
    title: 'Petrol lawn scarifier',
    description: 'Serviced last spring.',
    replacementValue: { amount: 24_999, currency: 'GBP' },
    attributes: {},
    transportRequirement: null,
    requiresTwoPersonLift: false,
    collectionLocation: null,
    isLocated: false,
    rates: { daily: null, weekend: null, weekly: null },
    inclusiveDailyPrice: null,
    status: 'PUBLISHED',
    moderationState: 'APPROVED',
    moderationReason: null,
    publicationAvailable: true,
    createdAt: '2026-08-04T09:00:00.000Z',
    updatedAt: '2026-08-04T09:00:00.000Z',
    ...over,
  };
}

describe('the status line', () => {
  it('tells a published, permitted listing that people can find it', () => {
    render(<StatusLine status="PUBLISHED" visible />);

    expect(screen.getByText(/Published\./)).toBeTruthy();
    expect(document.body.textContent).toContain('People can find this and book it');
  });

  it('does not claim anybody can find a published listing the platform is hiding', () => {
    /*
     * **The defect this slice fixed, held in place.** Before 2.8c-ii this
     * rendered "Published. People can find this and book it." for a listing the
     * platform had refused — the single most misleading sentence the product could
     * show, because the owner's own page confirmed a state that was false and
     * offered no clue anything was wrong.
     */
    render(<StatusLine status="PUBLISHED" visible={false} />);

    expect(document.body.textContent).not.toContain('People can find this and book it');
    expect(document.body.textContent).toContain('Published, but not visible');
  });

  it('still says the owner has it published, because that part is true', () => {
    // The two claims are separable and only one of them is wrong. Telling an
    // owner their listing is *not published* would be a different lie, and it
    // would invite them to press Publish on something already published.
    render(<StatusLine status="PUBLISHED" visible={false} />);

    expect(document.body.textContent).toContain('nothing you set has changed');
  });

  it('says a paused listing is paused and can be put back', () => {
    render(<StatusLine status="PAUSED" visible={false} />);

    expect(screen.getByText(/Paused\./)).toBeTruthy();
    expect(document.body.textContent).toContain('put it back');
  });

  it('says a draft is nobody else’s business yet', () => {
    render(<StatusLine status="DRAFT" visible={false} />);

    expect(screen.getByText(/Draft\./)).toBeTruthy();
  });

  it('renders a sentence for every status in the vocabulary', () => {
    // The compiler enforces exhaustiveness; this asserts that each case produces
    // real copy rather than an empty fragment, which type-checking cannot see.
    for (const status of LISTING_STATUSES) {
      const { unmount } = render(
        <StatusLine status={status} visible={isPubliclyVisible(status, 'APPROVED')} />,
      );
      expect((document.body.textContent ?? '').length).toBeGreaterThan(20);
      unmount();
    }
  });
});

describe('the moderation notice', () => {
  it('says nothing at all when nothing is holding the listing back', () => {
    /*
     * `APPROVED` is the absence of a decision, not the result of one: §8.3 makes
     * moderation something that flags rather than a gate every listing waits at.
     * A notice saying "approved" would tell every owner their listing had been
     * reviewed, which is false for all but a handful.
     */
    const { container } = render(
      <ModerationNotice listing={listing({ moderationState: 'APPROVED' })} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('asks the owner to wait when it is under review, and not to change anything', () => {
    render(
      <ModerationNotice
        listing={listing({ moderationState: 'UNDER_REVIEW', moderationReason: REASON })}
      />,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(document.body.textContent).toContain('being reviewed');
    expect(document.body.textContent).toContain('You do not need to change anything');
  });

  it('tells the owner a refusal is a refusal', () => {
    // The two hiding states ask opposite things — wait, or fix it — which is the
    // whole argument for their being two states. Copy that did not differ would
    // make the distinction decorative.
    render(
      <ModerationNotice
        listing={listing({ moderationState: 'REJECTED', moderationReason: REASON })}
      />,
    );

    expect(document.body.textContent).toContain('not allowed');
    expect(document.body.textContent).not.toContain(
      'You do not need to change anything',
    );
  });

  it('shows the moderator’s reason verbatim', () => {
    // ADR 0024's rule for suspension, and the promise the moderation form makes
    // to whoever types it: "write what you would say to them". Paraphrasing here
    // would make that promise false.
    render(
      <ModerationNotice
        listing={listing({ moderationState: 'REJECTED', moderationReason: REASON })}
      />,
    );

    expect(screen.getByText(REASON)).toBeTruthy();
  });

  it('never names the moderator, because only the reason is owed', () => {
    // The same line `/admin/users` draws for a suspended account: the subject
    // reads the reason and never the administrator behind it. There is no field
    // here that could carry it, which is the stronger guarantee — this asserts
    // the projection stays that way.
    const shown = listing({ moderationState: 'REJECTED', moderationReason: REASON });

    expect(Object.keys(shown)).not.toContain('moderatedById');
    expect(Object.keys(shown)).not.toContain('moderatedAt');
  });

  it('does not promise an email it cannot send', () => {
    // Notifications are Phase 6. Until they exist this page is the whole channel,
    // so the copy tells the owner to check back rather than to expect a message.
    render(
      <ModerationNotice
        listing={listing({ moderationState: 'UNDER_REVIEW', moderationReason: REASON })}
      />,
    );

    expect(document.body.textContent).toContain('do not send an email');
  });

  it('says something honest when a hiding state somehow has no reason', () => {
    /*
     * Unreachable in practice — the service refuses a hiding state without a
     * reason and `moderation_hidden_has_a_reason` refuses it again in the
     * database. The branch exists because a page must never render "why: null",
     * and because the honest sentence for a state that arrived without one is
     * that we cannot show what we were not given.
     */
    render(
      <ModerationNotice
        listing={listing({ moderationState: 'REJECTED', moderationReason: null })}
      />,
    );

    expect(document.body.textContent).toContain('No reason was recorded');
  });

  it('renders for every state that hides a listing', () => {
    // Swept rather than listed, so a fourth hiding state cannot arrive in the
    // vocabulary and silently render nothing — which would put a listing out of
    // sight with no explanation, the exact failure this slice exists to end.
    const hiding: readonly ModerationState[] = MODERATION_STATES.filter(
      (state) => state !== 'APPROVED',
    );

    for (const state of hiding) {
      const { unmount, container } = render(
        <ModerationNotice
          listing={listing({ moderationState: state, moderationReason: REASON })}
        />,
      );
      expect(container.firstChild).not.toBeNull();
      expect(screen.getByText(REASON)).toBeTruthy();
      unmount();
    }
  });
});

describe('the two authorities together', () => {
  it('is visible only when the owner published it and the platform permits it', () => {
    // The table, so the whole rule is readable in one place and a change to
    // either authority has to be considered against every combination.
    const cases: ReadonlyArray<[ListingStatus, ModerationState, boolean]> = [
      ['PUBLISHED', 'APPROVED', true],
      ['PUBLISHED', 'UNDER_REVIEW', false],
      ['PUBLISHED', 'REJECTED', false],
      ['PAUSED', 'APPROVED', false],
      ['PAUSED', 'UNDER_REVIEW', false],
      ['PAUSED', 'REJECTED', false],
      ['DRAFT', 'APPROVED', false],
      ['DRAFT', 'UNDER_REVIEW', false],
      ['DRAFT', 'REJECTED', false],
    ];

    for (const [status, moderation, expected] of cases) {
      expect(isPubliclyVisible(status, moderation)).toBe(expected);
    }

    /*
     * **The table is asserted complete against the vocabularies themselves**, not
     * against a hard-coded count.
     *
     * The first version of this checked `LISTING_STATUSES.length *
     * MODERATION_STATES.length === 9` — which is true, says nothing about the
     * table above, and passed while the table was missing two rows. A count
     * compared to a literal is a test of arithmetic; comparing the *set of pairs
     * covered* to the set that exists is a test of coverage.
     */
    const covered = new Set(
      cases.map(([status, moderation]) => `${status}:${moderation}`),
    );
    const all = LISTING_STATUSES.flatMap((status) =>
      MODERATION_STATES.map((moderation) => `${status}:${moderation}`),
    );

    expect([...all].filter((pair) => !covered.has(pair))).toEqual([]);
    expect(covered.size).toBe(all.length);
  });
});
