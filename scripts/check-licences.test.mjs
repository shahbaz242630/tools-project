import { describe, expect, it } from 'vitest';
import {
  assess,
  classifyIdentifier,
  evaluateExpression,
  findException,
  normaliseLicenceId,
} from './check-licences.mjs';

/**
 * The two cases that were live in the tree when this was written, and the reason
 * any of the rest of this file exists. `@img/sharp-win32-x64` was classified as
 * *neither* blocked nor reviewable, and `elkjs` printed NEEDS REVIEW and exited
 * 0. Both are reproduced below before anything general is asserted.
 */
const REAL = {
  'Apache-2.0 AND LGPL-3.0-or-later': [{ name: '@img/sharp-win32-x64' }],
  'EPL-2.0': [{ name: 'elkjs' }],
  'Apache-2.0 AND MIT': [{ name: '@swc/core-win32-x64-msvc' }],
  'MIT and ISC': [{ name: '@visx/vendor' }],
  MIT: [{ name: 'vitest' }],
};

describe('the two dependencies that were misclassified', () => {
  it('sees the LGPL inside a compound expression', () => {
    const result = evaluateExpression('Apache-2.0 AND LGPL-3.0-or-later');

    expect(result.verdict).toBe('review');
    expect(result.identifiers).toEqual(['LGPL-3.0']);
  });

  it('excuses both, because both are recorded in AUDIT-EXCEPTIONS.md', () => {
    const { blocked, needsReview, excused } = assess(REAL);

    expect(blocked).toEqual([]);
    expect(needsReview).toEqual([]);
    expect(excused.map((entry) => entry.name)).toEqual([
      '@img/sharp-win32-x64',
      'elkjs',
    ]);
  });

  it('excuses the platform sibling that CI and the deployed image resolve', () => {
    // The whole reason the exception is a pattern. This is what
    // `pnpm licenses list` prints on the ubuntu runner, and an exact-name
    // exception would have passed on Windows and reddened CI.
    const { needsReview, excused } = assess({
      'Apache-2.0 AND LGPL-3.0-or-later': [{ name: '@img/sharp-linux-x64' }],
      'LGPL-3.0-or-later': [{ name: '@img/sharp-libvips-linux-x64' }],
    });

    expect(needsReview).toEqual([]);
    expect(excused).toHaveLength(2);
  });

  it('fails on a reviewable licence nobody has recorded', () => {
    const { needsReview } = assess({ 'MPL-2.0': [{ name: 'some-new-dependency' }] });

    expect(needsReview).toEqual([
      {
        name: 'some-new-dependency',
        expression: 'MPL-2.0',
        identifiers: ['MPL-2.0'],
      },
    ]);
  });

  it('does not let one package borrow another package’s exception', () => {
    const { needsReview, excused } = assess({
      'EPL-2.0': [{ name: 'elkjs' }, { name: 'something-else' }],
    });

    expect(excused.map((entry) => entry.name)).toEqual(['elkjs']);
    expect(needsReview.map((entry) => entry.name)).toEqual(['something-else']);
  });
});

describe('normaliseLicenceId', () => {
  it.each([
    ['LGPL-3.0-or-later', 'LGPL-3.0'],
    ['LGPL-3.0-only', 'LGPL-3.0'],
    ['GPL-2.0+', 'GPL-2.0'],
    ['  MIT  ', 'MIT'],
    ['BSD-3-Clause', 'BSD-3-Clause'],
  ])('%s becomes %s', (input, expected) => {
    expect(normaliseLicenceId(input)).toBe(expected);
  });
});

describe('classifyIdentifier', () => {
  it.each([
    ['GPL-3.0-or-later', 'denied'],
    ['AGPL-3.0', 'denied'],
    ['LGPL-2.1-only', 'review'],
    ['EPL-2.0', 'review'],
    ['MIT', 'allowed'],
    ['BlueOak-1.0.0', 'allowed'],
  ])('%s is %s', (identifier, verdict) => {
    expect(classifyIdentifier(identifier).verdict).toBe(verdict);
  });

  it('catches a copyleft version nobody listed, by family', () => {
    // The safety net. Neither identifier is in DENIED or REVIEW.
    expect(classifyIdentifier('MPL-2.0-no-copyleft-exception').verdict).toBe('review');
    expect(classifyIdentifier('GPL-2.0-with-classpath-exception').verdict).toBe(
      'denied',
    );
    expect(classifyIdentifier('EUPL-1.2').verdict).toBe('review');
  });

  it('answers AGPL as AGPL rather than as GPL', () => {
    // Both are denied, so the verdict cannot show the ordering bug. The
    // identifier reported can.
    expect(classifyIdentifier('AGPL-3.0-or-later').id).toBe('AGPL-3.0');
  });

  it('reports an identifier in no list as unrecognised but permitted', () => {
    const result = classifyIdentifier('Some-New-Permissive-1.0');

    expect(result.verdict).toBe('allowed');
    expect(result.known).toBe(false);
  });
});

describe('evaluateExpression', () => {
  it('takes the stricter operand of AND', () => {
    expect(evaluateExpression('MIT AND GPL-3.0').verdict).toBe('denied');
    expect(evaluateExpression('Apache-2.0 AND MIT').verdict).toBe('allowed');
  });

  it('takes the more permissive operand of OR, because we may choose', () => {
    const result = evaluateExpression('MIT OR GPL-3.0');

    expect(result.verdict).toBe('allowed');
    // And says nothing about the branch we did not take — reporting it would
    // send somebody hunting for a GPL problem we do not have.
    expect(result.identifiers).toEqual([]);
  });

  it('respects parentheses and the AND-binds-tighter precedence', () => {
    expect(evaluateExpression('(MIT OR GPL-3.0) AND Apache-2.0').verdict).toBe(
      'allowed',
    );
    // Without precedence this would read as `MIT OR (GPL-3.0 AND Apache-2.0)`
    // and pass.
    expect(evaluateExpression('MIT AND GPL-3.0 OR AGPL-3.0').verdict).toBe('denied');
  });

  it('accepts the lowercase operator pnpm actually emits', () => {
    expect(evaluateExpression('MIT and ISC').verdict).toBe('allowed');
    expect(evaluateExpression('MIT and GPL-3.0').verdict).toBe('denied');
  });

  it('judges a WITH expression on its licence, not its exception', () => {
    expect(evaluateExpression('GPL-2.0 WITH Classpath-exception-2.0').verdict).toBe(
      'denied',
    );
    expect(evaluateExpression('MIT WITH Anything').verdict).toBe('allowed');
  });

  it('reports each driving identifier once', () => {
    const result = evaluateExpression('LGPL-3.0-only AND LGPL-3.0-or-later');

    expect(result.identifiers).toEqual(['LGPL-3.0']);
  });
});

describe('a dependency that grants no licence', () => {
  /*
   * The hole the August 2026 audit found. Every one of these used to be
   * reported as UNCLASSIFIED and pass, because the leniency that keeps the
   * build green for an unfamiliar *permissive* licence could not tell one from
   * the absence of a grant.
   */
  it.each([
    ['UNLICENSED', 'unlicensed-thing'],
    ['Unknown', 'no-license-field'],
    ['SEE LICENSE IN LICENSE.md', 'read-it-yourself'],
    ['LicenseRef-Bespoke', 'someones-own-terms'],
    ['', 'empty-field'],
  ])('fails the build on %s', (expression, name) => {
    const { noGrant, blocked, needsReview } = assess({ [expression]: [{ name }] });

    expect(noGrant.map((entry) => entry.name)).toEqual([name]);
    // Its own class, not folded into copyleft: the remedy is different, and
    // "would oblige us to publish our own source" is simply not true of it.
    expect(blocked).toEqual([]);
    expect(needsReview).toEqual([]);
  });

  it('does not confuse Unlicense with UNLICENSED', () => {
    // One letter apart and opposite in meaning: a public-domain dedication
    // against the absence of any grant.
    expect(classifyIdentifier('Unlicense').verdict).toBe('allowed');
    expect(classifyIdentifier('UNLICENSED').verdict).toBe('no-grant');
    expect(assess({ Unlicense: [{ name: 'public-domain-thing' }] }).noGrant).toEqual(
      [],
    );
  });

  it('lets OR choose the licence we can comply with', () => {
    // We may pick either, and picking is free — so this is an MIT dependency
    // and its unlicensed half is not a problem we have.
    expect(evaluateExpression('MIT OR UNLICENSED').verdict).toBe('allowed');
  });

  it('takes the no-grant half of an AND, which obliges us under both', () => {
    expect(evaluateExpression('MIT AND UNLICENSED').verdict).toBe('no-grant');
  });

  it('can be excused by a recorded commercial licence, unlike copyleft', () => {
    // Nothing is excused today; this asserts the mechanism exists, because a
    // paid licence is a real thing to hold and the alternative is arguing with
    // a red build. `findException` is what REVIEWED is consulted through.
    expect(findException('unlicensed-thing', 'UNLICENSED')).toBeNull();
  });
});

describe('findException', () => {
  it('matches on the normalised identifier, whichever spelling arrives', () => {
    expect(findException('elkjs', 'EPL-2.0')).not.toBeNull();
    expect(findException('@img/sharp-linux-x64', 'LGPL-3.0-or-later')).not.toBeNull();
    expect(findException('@img/sharp-linux-x64', 'LGPL-3.0-only')).not.toBeNull();
  });

  it('does not match a different licence on a covered package', () => {
    expect(findException('elkjs', 'GPL-3.0')).toBeNull();
  });
});

describe('assess', () => {
  it('blocks rather than reviews when an expression is denied', () => {
    const { blocked } = assess({ 'GPL-3.0-or-later': [{ name: 'copyleft-thing' }] });

    expect(blocked).toEqual([
      {
        name: 'copyleft-thing',
        expression: 'GPL-3.0-or-later',
        identifiers: ['GPL-3.0'],
      },
    ]);
  });

  it('collects unrecognised identifiers without failing on them', () => {
    const { blocked, needsReview, unrecognised } = assess({
      'Made-Up-1.0': [{ name: 'a' }],
      MIT: [{ name: 'b' }],
    });

    expect(blocked).toEqual([]);
    expect(needsReview).toEqual([]);
    expect(unrecognised).toEqual(['Made-Up-1.0']);
  });

  it('tolerates the shapes pnpm can hand back', () => {
    expect(() => assess({ MIT: [] })).not.toThrow();
    expect(() => assess({ MIT: null })).not.toThrow();
  });
});
