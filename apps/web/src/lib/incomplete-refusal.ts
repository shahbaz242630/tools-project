import type { PublicationBlocker } from '@platform/contracts';

/**
 * What an owner is told when an edit would leave a published listing incomplete
 * (slice 2.9b-ii).
 *
 * **Its own module rather than a helper inside the server action**, for the
 * reason `collection-location.ts` and `replacement-value.ts` give: a `'use
 * server'` file cannot be imported by a test without dragging in `next/headers`
 * and Clerk, so a sentence assembled inside one is a sentence nothing checks.
 *
 * That is not a hypothetical here. The first version of this lived in the action,
 * joined the blockers with `'; '` and appended a full stop — and every test in
 * the slice passed while the page read *"…a thing that is nowhere.. Put that
 * back"*. It was found by looking at it. Moving it here is what makes the next
 * one findable without looking.
 *
 * Three things the sentence has to do, in this order:
 *
 * 1. **Say the change was not saved.** The first draft named the problem and the
 *    way out and never said what had happened, which leaves somebody unable to
 *    tell whether half their edit went in.
 * 2. **Say what is missing**, in the platform's existing words. Each
 *    `PublicationBlocker.message` is already a sentence that names its own
 *    subject and ends in a full stop, so they are joined with a space and
 *    nothing is added — the convention `contract-issues.ts` enforces after the
 *    same defect was found four times.
 * 3. **Say how to get the old value back, and how to make the change properly.**
 *    The form echoes back what was *typed*, so an owner who emptied the address
 *    is looking at empty boxes; nothing was written, so reloading restores them.
 */
export function describeIncompleteRefusal(
  blockers: readonly PublicationBlocker[],
): string {
  return [
    'This listing is published, so that change was not saved — it would have ' +
      'left the listing incomplete.',
    ...blockers.map((blocker) => blocker.message),
    'Reload this page to get the saved details back, or pause the listing first ' +
      'and then make the change.',
  ].join(' ');
}
