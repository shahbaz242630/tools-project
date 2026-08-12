import { describe, expect, it } from 'vitest';
import type { PublicationBlocker } from '@platform/contracts';
import { describeIncompleteRefusal } from './incomplete-refusal';

/**
 * The refusal an owner reads when an edit would break their published listing
 * (slice 2.9b-ii).
 *
 * **Every test here is about punctuation and completeness**, which is worth
 * saying because it looks like the least important file in the slice. The
 * defect it was extracted for was `'; '` plus an appended full stop against
 * blocker messages that are already sentences, and it reached a browser: *"…a
 * thing that is nowhere.. Put that back"*. Nothing failed, because nothing was
 * looking.
 */

/**
 * The real blocker sentences, copied from `publication.ts`.
 *
 * Typed as the real `PublicationBlocker` rather than a look-alike, so that a
 * change to the contract's shape reaches these fixtures. The *text* is duplicated
 * deliberately: importing `publicationBlockers` and generating it would make this
 * a test of two modules agreeing, and what is under test here is what happens to
 * a sentence that already ends in a full stop.
 */
const NO_ADDRESS: PublicationBlocker = {
  field: 'collectionLocation',
  message:
    'Where the item is collected from is needed before this listing can be ' +
    'published, because nobody can come and fetch a thing that is nowhere.',
};

const NO_DESCRIPTION: PublicationBlocker = {
  field: 'description',
  message: 'It has to say something before this listing can be published.',
};

describe('describeIncompleteRefusal', () => {
  it('says the change was not saved, before anything else', () => {
    // The owner's first question is what happened to their edit, not what is
    // wrong with the listing. A message that answers the second first leaves
    // them unable to tell whether half of it went in.
    expect(describeIncompleteRefusal([NO_ADDRESS])).toMatch(
      /^This listing is published/,
    );
    expect(describeIncompleteRefusal([NO_ADDRESS])).toContain('was not saved');
  });

  it('never doubles a full stop, which is the bug it was extracted for', () => {
    expect(describeIncompleteRefusal([NO_ADDRESS])).not.toContain('..');
    expect(describeIncompleteRefusal([NO_ADDRESS, NO_DESCRIPTION])).not.toContain('..');
  });

  it('joins two blockers as two sentences rather than as a list', () => {
    // They are written to stand alone (`PublicationBlocker`), so they need a
    // space and nothing else. A semicolon would make two sentences into one
    // ungrammatical one.
    const message = describeIncompleteRefusal([NO_ADDRESS, NO_DESCRIPTION]);

    expect(message).toContain('nowhere. It has to say something');
    expect(message).not.toContain(';');
  });

  it('carries every blocker rather than the first', () => {
    // The rule `publicationBlockers` follows on the other side: somebody who
    // fixes one thing and is then told about the next is being walked through
    // round trips for a form they can see all of.
    const message = describeIncompleteRefusal([NO_ADDRESS, NO_DESCRIPTION]);

    expect(message).toContain('collected from');
    expect(message).toContain('say something');
  });

  it('names reloading, because the form shows what was typed and not what is stored', () => {
    // An owner who emptied the address is looking at four empty boxes. Nothing
    // was written, so reloading is what brings the saved address back — and
    // saying so is what stops "put that back" being an instruction they cannot
    // follow.
    expect(describeIncompleteRefusal([NO_ADDRESS])).toContain('Reload this page');
  });

  it('names pausing as the way to make the change legitimately', () => {
    // The owner is not doing anything wrong; they are doing it in the wrong
    // order. Pause is one reversible action away and is what it exists for.
    expect(describeIncompleteRefusal([NO_ADDRESS])).toContain('pause the listing');
  });

  it('still reads as a sentence when the blocker list is empty', () => {
    /*
     * Unreachable through the route — the API only raises this error with at
     * least one blocker — and asserted anyway, because the failure mode of a
     * join is a dangling connective, and this is the one input that would
     * produce one.
     */
    const message = describeIncompleteRefusal([]);

    expect(message).not.toContain('  ');
    expect(message).toContain('was not saved');
    expect(message).toContain('Reload this page');
  });
});
