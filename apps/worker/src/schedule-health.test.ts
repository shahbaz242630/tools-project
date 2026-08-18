import { describe, expect, it } from 'vitest';
import { scheduleIsRegistered } from './schedule-health.js';

/**
 * The fourth health question (slice H6).
 *
 * Small enough to look not worth testing, which is exactly the argument `drain.ts`
 * makes for testing its own one boolean: **inverting this is invisible.** A version
 * that returned `true` unconditionally would pass every container check — the probe
 * would keep refreshing, the worker would keep reading healthy, and the failure it
 * exists to catch would be back.
 */

const OURS = 'expire-requests-every-15-minutes';

describe('scheduleIsRegistered', () => {
  it('is true when our schedule is there', () => {
    expect(scheduleIsRegistered([{ key: OURS }], OURS)).toBe(true);
  });

  it('is false when nothing is registered', () => {
    /*
     * The failure 4.7b introduced and recorded: `upsertJobScheduler` failed while
     * Redis stayed healthy, so every other health question still answers yes.
     */
    expect(scheduleIsRegistered([], OURS)).toBe(false);
  });

  it('is false when only somebody else’s schedule is there', () => {
    /*
     * **Why this matches a key rather than checking the list is non-empty.** A
     * non-empty check would pass here — and, more usefully, it would pass on a
     * *stale* schedule left behind by a renamed id, which is the mistake `queues.ts`
     * warns about: changing `EXPIRE_REQUESTS_SCHEDULER` does not rename the schedule
     * Redis holds, it adds a second one. This is what notices.
     */
    expect(scheduleIsRegistered([{ key: 'some-other-schedule' }], OURS)).toBe(false);
  });

  it('is true when ours sits among others', () => {
    expect(
      scheduleIsRegistered([{ key: 'another' }, { key: OURS }, { key: 'third' }], OURS),
    ).toBe(true);
  });

  it('does not match on a prefix', () => {
    // `expire-requests-every-15-minutes-v2` is a different schedule, and treating it
    // as ours would hide precisely the rename this check is for.
    expect(scheduleIsRegistered([{ key: `${OURS}-v2` }], OURS)).toBe(false);
  });
});
