import { describe, expect, it } from 'vitest';
import { HEARTBEAT_JOB, MAINTENANCE_QUEUE } from './queues.js';

describe('queue and job names', () => {
  it('pins the names that are persisted in Redis', () => {
    // These strings are Redis keys, not identifiers. Renaming one in code does
    // not rename the queue that already holds jobs: the old queue keeps its
    // work and nothing consumes it, while the new one starts empty and looks
    // healthy. Nothing else would fail.
    //
    // Changing these assertions should therefore be a deliberate act with a
    // plan for draining the old queue first.
    expect(MAINTENANCE_QUEUE).toBe('maintenance');
    expect(HEARTBEAT_JOB).toBe('heartbeat');
  });
});
