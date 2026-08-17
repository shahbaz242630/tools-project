import { describe, expect, it } from 'vitest';
import { hasNothingToDrain } from './drain.js';

describe('hasNothingToDrain', () => {
  it('waits for in-flight jobs once the broker has been reached', () => {
    // The one case that must never be forced. A connected worker may be holding
    // a job, and an interrupted job is re-delivered.
    expect(hasNothingToDrain('ready')).toBe(false);
  });

  it('does not wait when the broker has never been reached', () => {
    // Nothing can have been taken, so there is nothing to finish — and this is
    // the state in which bullmq 6's close() does not settle at all.
    expect(hasNothingToDrain('initializing')).toBe(true);
  });

  it('does not wait when the connection is already closing or closed', () => {
    expect(hasNothingToDrain('closing')).toBe(true);
    expect(hasNothingToDrain('closed')).toBe(true);
  });
});
