import { describe, expect, it } from 'vitest';
import { ContractViolationError } from './parse.js';
import { MIN_ADMIN_REASON_LENGTH } from './admin.js';
import {
  LISTING_DESCRIPTION_MAX_LENGTH,
  LISTING_STATUSES,
  LISTING_TITLE_MAX_LENGTH,
  MODERATION_STATES,
  MAX_REPLACEMENT_VALUE_MINOR,
  MIN_REPLACEMENT_VALUE_MINOR,
  canTransition,
  isPubliclyVisible,
  moderationRequiresReason,
  parseListingDraft,
  parseModerationDecision,
  parseModerationOutcome,
  parseOwnedListings,
  transitionRefusal,
} from './listings.js';
import type { ListingStatus, ListingTransition } from './listings.js';

const validDraft = {
  categorySlug: 'outdoor-gardening',
  title: 'Petrol hedge trimmer',
  description: 'Serviced last spring. Blade recently sharpened.',
  replacementValue: { amount: 24_999, currency: 'GBP' },
  categoryVersionNumber: 1,
  attributes: { power_source: 'petrol', weight_kg: '5.2' },
  // Present and null: a draft that has not said how it is collected. §8.3 lets
  // owners save progress, and 2.4c-ii made "not said" explicit rather than
  // something a caller could leave to chance.
  transportRequirement: null,
  requiresTwoPersonLift: false,
  // Present and null for the same reason: a draft need not say where the item
  // lives either (slice 2.5a).
  collectionLocation: null,
  // Present and unpriced, for the same reason again (slice 2.7b). A draft need
  // not have a price; a caller that omitted the field has forgotten it.
  rates: { daily: null, weekend: null, weekly: null },
};

/** The draft minus one field, for asserting that its absence is refused. */
function without(field: keyof typeof validDraft): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...validDraft };
  delete copy[field];
  return copy;
}

function issuesOf(read: () => unknown): readonly string[] {
  try {
    read();
  } catch (error) {
    if (error instanceof ContractViolationError) return error.issues;
    throw error;
  }
  throw new Error('Expected the contract to reject this, and it did not');
}

describe('the listing draft', () => {
  it('accepts a complete draft', () => {
    expect(parseListingDraft(validDraft).title).toBe('Petrol hedge trimmer');
  });

  it('does not let the caller choose the category version', () => {
    // The server pins whichever version is current when the row is written. A
    // client-chosen version would let a form left open overnight pin
    // configuration that was replaced while it sat there — the one thing the
    // pin exists to prevent. Zod strips unknown keys, so this asserts the
    // stripping rather than a rejection.
    const parsed = parseListingDraft({ ...validDraft, categoryVersionId: 'anything' });

    expect(parsed).not.toHaveProperty('categoryVersionId');
  });

  it('has no status field, because a draft is the only thing this creates', () => {
    const parsed = parseListingDraft({ ...validDraft, status: 'PUBLISHED' });

    expect(parsed).not.toHaveProperty('status');
  });

  it('refuses a draft with no attributes field, rather than assuming none', () => {
    // ADR 0025's rule: an optional field is a silent default, and a caller that
    // forgot the category's answers should get a 400 rather than a listing that
    // quietly has none.
    expect(issuesOf(() => parseListingDraft(without('attributes'))).join(' ')).toMatch(
      /attributes/,
    );
  });

  it('accepts an empty set of answers, which is what an untouched draft has', () => {
    expect(parseListingDraft({ ...validDraft, attributes: {} }).attributes).toEqual({});
  });

  it('does not judge the answers here, because only the category can', () => {
    // Which keys are legal and what shape each takes is configuration the
    // request does not carry. `validateAttributeValues` decides, against the
    // schema on the version being pinned.
    expect(
      parseListingDraft({ ...validDraft, attributes: { anything: { at: 'all' } } })
        .attributes,
    ).toEqual({ anything: { at: 'all' } });
  });

  it('requires the version the form was built from', () => {
    expect(
      issuesOf(() => parseListingDraft(without('categoryVersionNumber'))).join(' '),
    ).toMatch(/categoryVersionNumber/);
  });

  it('refuses a version number that could never have existed', () => {
    expect(() =>
      parseListingDraft({ ...validDraft, categoryVersionNumber: 0 }),
    ).toThrow(ContractViolationError);
  });
});

describe('the title', () => {
  it('trims before measuring length', () => {
    expect(parseListingDraft({ ...validDraft, title: '  Mower  ' }).title).toBe(
      'Mower',
    );
  });

  it('rejects one too short to say anything', () => {
    expect(() => parseListingDraft({ ...validDraft, title: 'ab' })).toThrow(
      ContractViolationError,
    );
  });

  it('rejects one past the limit', () => {
    expect(() =>
      parseListingDraft({
        ...validDraft,
        title: 'x'.repeat(LISTING_TITLE_MAX_LENGTH + 1),
      }),
    ).toThrow(ContractViolationError);
  });

  it('rejects a direction-changing character', () => {
    // U+202E reverses the rendering of everything after it, which is how a
    // title is made to read as something it is not.
    expect(() => parseListingDraft({ ...validDraft, title: 'Mower ‮gnittuc' })).toThrow(
      ContractViolationError,
    );
  });

  it('rejects a newline, because a title is one line', () => {
    expect(() => parseListingDraft({ ...validDraft, title: 'Mower\nCheap' })).toThrow(
      ContractViolationError,
    );
  });

  it('accepts a name that is not ASCII', () => {
    expect(parseListingDraft({ ...validDraft, title: 'Motosierra — 40cm' }).title).toBe(
      'Motosierra — 40cm',
    );
  });
});

describe('the description', () => {
  it('is required to be present', () => {
    // ADR 0025: an absent field is a silent default, and the silent default
    // here would quietly blank what somebody wrote.
    const withoutDescription = Object.fromEntries(
      Object.entries(validDraft).filter(([key]) => key !== 'description'),
    );

    expect(() => parseListingDraft(withoutDescription)).toThrow(ContractViolationError);
  });

  it('is allowed to be empty, because a draft holds progress', () => {
    // §8.3: "owners create draft listings and save progress". Requiring prose
    // before a draft can be saved is what makes people abandon the form.
    // Publication is where completeness is enforced (2.8).
    expect(parseListingDraft({ ...validDraft, description: '' }).description).toBe('');
  });

  it('allows newlines, because it is a paragraph field', () => {
    const description = 'Serviced last spring.\n\nCollection from the driveway.';

    expect(parseListingDraft({ ...validDraft, description }).description).toBe(
      description,
    );
  });

  it('still rejects a direction-changing character', () => {
    expect(() =>
      parseListingDraft({ ...validDraft, description: 'Good condition ‮' }),
    ).toThrow(ContractViolationError);
  });

  it('rejects a control character that is not a line break', () => {
    expect(() =>
      parseListingDraft({ ...validDraft, description: 'Goodcondition' }),
    ).toThrow(ContractViolationError);
  });

  it('rejects one past the limit', () => {
    expect(() =>
      parseListingDraft({
        ...validDraft,
        description: 'x'.repeat(LISTING_DESCRIPTION_MAX_LENGTH + 1),
      }),
    ).toThrow(ContractViolationError);
  });
});

describe('the replacement value', () => {
  it('is money, not a number', () => {
    // The currency travels with the amount. A bare number is ambiguous the day
    // a second currency exists, with no way to tell which rows were which.
    expect(() =>
      parseListingDraft({ ...validDraft, replacementValue: 24_999 }),
    ).toThrow(ContractViolationError);
  });

  it('rejects fractional pence', () => {
    // What a caller sending pounds where pence were meant looks like. Without
    // this it would be rounded somewhere downstream and found by a ledger that
    // stopped balancing.
    expect(
      issuesOf(() =>
        parseListingDraft({
          ...validDraft,
          replacementValue: { amount: 10.5, currency: 'GBP' },
        }),
      ).join(' '),
    ).toMatch(/whole number of pence/i);
  });

  it('rejects a currency the platform cannot do arithmetic in', () => {
    expect(() =>
      parseListingDraft({
        ...validDraft,
        replacementValue: { amount: 24_999, currency: 'EUR' },
      }),
    ).toThrow(ContractViolationError);
  });

  it('rejects a value below the floor, naming pounds rather than pence', () => {
    // The message is read by an owner in a form. "must be at least 100" would
    // be telling them about a unit they never typed.
    expect(
      issuesOf(() =>
        parseListingDraft({
          ...validDraft,
          replacementValue: {
            amount: MIN_REPLACEMENT_VALUE_MINOR - 1,
            currency: 'GBP',
          },
        }),
      ).join(' '),
    ).toContain('£1');
  });

  it('rejects a value above the ceiling', () => {
    expect(
      issuesOf(() =>
        parseListingDraft({
          ...validDraft,
          replacementValue: {
            amount: MAX_REPLACEMENT_VALUE_MINOR + 1,
            currency: 'GBP',
          },
        }),
      ).join(' '),
    ).toContain('£100,000');
  });

  it('accepts both bounds exactly', () => {
    for (const amount of [MIN_REPLACEMENT_VALUE_MINOR, MAX_REPLACEMENT_VALUE_MINOR]) {
      expect(
        parseListingDraft({
          ...validDraft,
          replacementValue: { amount, currency: 'GBP' },
        }).replacementValue.amount,
      ).toBe(amount);
    }
  });

  it('rejects a negative value', () => {
    // Negative money is legitimate in the ledger and meaningless here — an item
    // cannot cost less than nothing to replace.
    expect(() =>
      parseListingDraft({
        ...validDraft,
        replacementValue: { amount: -24_999, currency: 'GBP' },
      }),
    ).toThrow(ContractViolationError);
  });
});

describe('the transport requirement', () => {
  it('accepts a value from the platform vocabulary', () => {
    expect(
      parseListingDraft({ ...validDraft, transportRequirement: 'van_required' })
        .transportRequirement,
    ).toBe('van_required');
  });

  it('accepts null, because a draft may not have said', () => {
    // §8.3's "save progress". Completeness is publication's rule (2.8), and a
    // draft refused for not answering is the form people abandon.
    expect(parseListingDraft(validDraft).transportRequirement).toBeNull();
  });

  it('refuses a value outside the vocabulary', () => {
    // Whether *this category* offers it is decided in the Catalogue service
    // against the pinned version. This is the narrower check: is it a
    // requirement at all.
    expect(() =>
      parseListingDraft({ ...validDraft, transportRequirement: 'roof_rack' }),
    ).toThrow(ContractViolationError);
  });

  it('refuses an empty string rather than reading it as unanswered', () => {
    // What a select's "no answer yet" option posts. The server action turns it
    // into null before it gets here — deliberately, so that "not said" has one
    // representation rather than two.
    expect(() =>
      parseListingDraft({ ...validDraft, transportRequirement: '' }),
    ).toThrow(ContractViolationError);
  });

  it('demands the field rather than assuming not answered', () => {
    // ADR 0025, sixth application. A caller that forgot must hear so.
    expect(() => parseListingDraft(without('transportRequirement'))).toThrow(
      ContractViolationError,
    );
  });

  it('demands the two-person lift flag too', () => {
    expect(() => parseListingDraft(without('requiresTwoPersonLift'))).toThrow(
      ContractViolationError,
    );
  });

  it('keeps the lift flag separate from the requirement', () => {
    // ADR 0031's split: an item can need a van *and* two people, and a single
    // field would force an owner to discard one of two true facts.
    const draft = parseListingDraft({
      ...validDraft,
      transportRequirement: 'van_required',
      requiresTwoPersonLift: true,
    });

    expect(draft.transportRequirement).toBe('van_required');
    expect(draft.requiresTwoPersonLift).toBe(true);
  });
});

describe('what the public can see', () => {
  it('shows a published listing and nothing else', () => {
    // Written as an exhaustive sweep rather than three assertions, so that a
    // status added in 2.8c fails here until somebody has decided whether
    // strangers may see it. A new state defaulting to invisible would be safe;
    // a new state defaulting to *visible* is a listing shown against its
    // owner's wishes, and the difference must not be settled by whoever adds
    // the enum value.
    const visible = LISTING_STATUSES.filter((status) =>
      isPubliclyVisible(status, 'APPROVED'),
    );

    expect(visible).toEqual(['PUBLISHED']);
  });

  it('hides a paused listing, which is the whole point of pausing', () => {
    expect(isPubliclyVisible('PAUSED', 'APPROVED')).toBe(false);
  });

  it('sweeps the moderation states too, for the same reason', () => {
    const visible = MODERATION_STATES.filter((state) =>
      isPubliclyVisible('PUBLISHED', state),
    );

    expect(visible).toEqual(['APPROVED']);
  });

  it('needs both authorities to agree, and neither can override the other', () => {
    // The `&&`, asserted as a truth table rather than trusted. Each of the
    // three ways to be invisible is a different bug if it ever returns true:
    // showing a draft, showing something an owner hid, showing something we
    // rejected.
    expect(isPubliclyVisible('PUBLISHED', 'APPROVED')).toBe(true);
    expect(isPubliclyVisible('PUBLISHED', 'REJECTED')).toBe(false);
    expect(isPubliclyVisible('PAUSED', 'APPROVED')).toBe(false);
    expect(isPubliclyVisible('DRAFT', 'APPROVED')).toBe(false);
  });

  it('hides a listing under review as well as one rejected', () => {
    // Both hide it. They are separate states because they ask opposite things
    // of the owner — wait, or fix it — not because they differ here.
    expect(isPubliclyVisible('PUBLISHED', 'UNDER_REVIEW')).toBe(false);
  });
});

describe('when a moderation decision owes a reason', () => {
  it('demands one for every state that hides a listing', () => {
    const hiding = MODERATION_STATES.filter((state) => moderationRequiresReason(state));

    // Swept rather than listed, so a fourth state added later has to be
    // considered here instead of silently defaulting to needing no reason —
    // which is the direction that lets a listing vanish with no explanation.
    expect(hiding).toEqual(['UNDER_REVIEW', 'REJECTED']);
  });

  it('asks for none when reinstating', () => {
    // Not an oversight: putting somebody's listing back is not a decision that
    // needs defending to them.
    expect(moderationRequiresReason('APPROVED')).toBe(false);
  });
});

describe('the moderation decision a caller submits', () => {
  it('accepts a state with a reason', () => {
    expect(
      parseModerationDecision({ state: 'REJECTED', reason: 'Prohibited item' }),
    ).toEqual({ state: 'REJECTED', reason: 'Prohibited item' });
  });

  it('turns a blank reason into no reason at all', () => {
    // `"   "` satisfies "a string is present" and satisfies nobody reading it.
    // One representation of absent, matching the database's own `btrim` check —
    // two spellings is how a later query misses half the rows.
    expect(
      parseModerationDecision({ state: 'APPROVED', reason: '   ' }).reason,
    ).toBeNull();
  });

  it('refuses a state outside the vocabulary', () => {
    expect(() => parseModerationDecision({ state: 'BANNED' })).toThrow(
      ContractViolationError,
    );
  });

  it('does not enforce the reason rule here, deliberately', () => {
    // The shape check cannot express "required unless APPROVED" without becoming
    // a discriminated union with two unrelated error shapes for one form. The
    // rule lives in `moderationRequiresReason`, and the service raises on it.
    expect(parseModerationDecision({ state: 'REJECTED' }).state).toBe('REJECTED');
  });

  it('refuses a reason too short to be one', () => {
    // *Whether* a reason is owed is the service's rule; whether a supplied one
    // clears the administrative floor is a shape question and belongs here.
    // Before this, the route accepted `"no"` — while suspension, role changes,
    // account lookups and feature flags all held out for twelve characters.
    expect(() => parseModerationDecision({ state: 'REJECTED', reason: 'no' })).toThrow(
      ContractViolationError,
    );
  });

  it('accepts a reason of exactly the administrative minimum', () => {
    // The boundary, in the direction that matters: an off-by-one here would
    // refuse a reason the form's own `minLength` had just told somebody was
    // long enough, and they would have no way to tell which of the two lied.
    const reason = 'x'.repeat(MIN_ADMIN_REASON_LENGTH);

    expect(parseModerationDecision({ state: 'REJECTED', reason }).reason).toBe(reason);
  });

  it('still takes an absent reason when reinstating, rather than demanding twelve characters', () => {
    // The whole reason this is not `adminReasonSchema`. Approving owes no
    // explanation, so an empty box has to mean "none given" — not "twelve
    // characters missing", which is what a bare minimum length would say to
    // somebody putting a listing back.
    expect(
      parseModerationDecision({ state: 'APPROVED', reason: '' }).reason,
    ).toBeNull();
  });
});

describe('the moderation outcome a caller reads back', () => {
  it('accepts the decision', () => {
    expect(parseModerationOutcome({ moderationState: 'UNDER_REVIEW' })).toEqual({
      moderationState: 'UNDER_REVIEW',
    });
  });

  it('refuses a state outside the vocabulary', () => {
    expect(() => parseModerationOutcome({ moderationState: 'HIDDEN' })).toThrow(
      ContractViolationError,
    );
  });

  it('refuses a response carrying anything else — including the listing', () => {
    /*
     * The test this parser exists for.
     *
     * The route answers with the decision alone because `OwnerListing` carries
     * the collection address and §8.4.1 does not disclose that to a moderator.
     * The failure mode is somebody later "improving" the controller to echo the
     * record back: a caller reading `body.moderationState` off an unvalidated
     * response would accept it silently, and a stranger's address would arrive
     * as a side effect of pressing a button. `strictObject` makes that a test
     * failure instead of a disclosure.
     */
    expect(() =>
      parseModerationOutcome({
        moderationState: 'REJECTED',
        collectionLocation: { postcode: 'BS7 8AA' },
      }),
    ).toThrow(ContractViolationError);
  });
});

describe('the transitions', () => {
  // The table in one place, so a reader can see the whole state machine and so
  // an added status cannot quietly acquire a default answer.
  const cases: ReadonlyArray<[ListingTransition, ListingStatus, boolean]> = [
    ['publish', 'DRAFT', true],
    ['publish', 'PUBLISHED', true],
    ['publish', 'PAUSED', true],
    ['pause', 'DRAFT', false],
    ['pause', 'PUBLISHED', true],
    ['pause', 'PAUSED', true],
  ];

  it.each(cases)('%s from %s is %s', (transition, from, allowed) => {
    expect(canTransition(transition, from)).toBe(allowed);
  });

  it('covers every status for every transition', () => {
    // The table above is hand-written, so this asserts it is complete. Without
    // it, adding a status leaves a pair silently untested — which is exactly
    // how a state acquires an unconsidered transition rule.
    const transitions: readonly ListingTransition[] = ['publish', 'pause'];
    const expected = transitions.length * LISTING_STATUSES.length;

    expect(cases).toHaveLength(expected);
  });

  it('treats resuming as publishing rather than a transition of its own', () => {
    // The kill switch and the completeness gate both hang off publish. A
    // separate resume would be a second door into public view, past both.
    expect(canTransition('publish', 'PAUSED')).toBe(true);
  });

  it('is idempotent, because a retried request is not a mistake', () => {
    expect(canTransition('publish', 'PUBLISHED')).toBe(true);
    expect(canTransition('pause', 'PAUSED')).toBe(true);
  });

  it('says nothing when the transition is legal', () => {
    expect(transitionRefusal('pause', 'PUBLISHED')).toBeNull();
  });

  it('explains a refused pause in words an owner can act on', () => {
    const refusal = transitionRefusal('pause', 'DRAFT');

    // A sentence naming its own subject, per contract-issues.ts. Asserted as a
    // property rather than a literal, so rewording the copy does not fail the
    // test but dropping the subject does.
    expect(refusal).toContain('This listing');
    expect(refusal).not.toContain('DRAFT');
  });
});

describe('the list of an owner’s own listings', () => {
  const ROW = {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Petrol hedge trimmer',
    categoryName: 'Outdoor and gardening',
    status: 'PUBLISHED',
    moderationState: 'APPROVED',
    isLocated: true,
    inclusiveDailyPrice: null,
    createdAt: '2026-08-11T09:00:00.000Z',
    updatedAt: '2026-08-11T09:00:00.000Z',
  };

  it('reads a page of rows and whether it was cut', () => {
    const page = parseOwnedListings({ listings: [ROW], truncated: false });

    expect(page.listings).toHaveLength(1);
    expect(page.listings[0]?.title).toBe('Petrol hedge trimmer');
    expect(page.truncated).toBe(false);
  });

  it('reads an empty list as an empty list', () => {
    // Not as an error, and not as null. Somebody who has listed nothing is the
    // ordinary first case, and the page has copy for exactly it.
    expect(parseOwnedListings({ listings: [], truncated: false }).listings).toEqual([]);
  });

  it('refuses a page that does not say whether it was cut', () => {
    // `truncated` is required rather than defaulted, because a default of false
    // is a claim: it would tell somebody they were looking at every listing they
    // own, on the strength of a field the server forgot to send.
    expect(() => parseOwnedListings({ listings: [ROW] })).toThrow();
  });

  it('refuses a moderation state it does not know', () => {
    // The closed vocabulary, checked on the way in. A state this build cannot
    // render must not reach the table as a string it would print raw.
    expect(() =>
      parseOwnedListings({
        listings: [{ ...ROW, moderationState: 'QUARANTINED' }],
        truncated: false,
      }),
    ).toThrow();
  });

  it('accepts a row whose price has not been set', () => {
    // Null means "show no price", never "free" — an unpriced draft is the
    // commonest row this page will ever render.
    const page = parseOwnedListings({
      listings: [{ ...ROW, inclusiveDailyPrice: null }],
      truncated: false,
    });

    expect(page.listings[0]?.inclusiveDailyPrice).toBeNull();
  });
});
