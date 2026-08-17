/**
 * Whether stopping the worker may skip waiting for in-flight jobs.
 *
 * This is one boolean, and it is here rather than inline in `main.ts` because
 * inverting it is invisible: the container check that would notice is the one
 * that runs *without* a broker, and it passes either way. What an inversion
 * actually breaks is the healthy path — a worker force-closed mid-job, the job
 * re-delivered, and for anything non-idempotent that is worse than waiting.
 * So the rule gets a name and a test.
 *
 * **The rule: a worker that has never reached its broker has no in-flight job,
 * so the wait it would perform is a wait for nothing.** That is not a
 * micro-optimisation. BullMQ 6's `Worker.close()` does not settle at all in
 * that state — measured on 6.1.2, a container stopped with no Redis reachable
 * took 25.3s and only exited because the drain timeout gave up on it, where
 * bullmq 5 stopped in about a second. Passing `force` skips
 * `whenCurrentJobsFinished`, which is where it stalls, and the same container
 * then stops in 0.4s.
 *
 * **The status answers "did we ever connect", not "are we connected now."**
 * BullMQ sets it to `ready` once the connection is up and leaves it there, so a
 * broker that came up and later died still earns the full drain. That is
 * deliberate: there may be a real job in flight which finishes if the
 * connection returns. This shortens exactly one case — the one where waiting
 * cannot possibly help.
 */

/**
 * BullMQ's own connection states, restated so a widened vocabulary upstream
 * becomes a compile error at the call site rather than a silent behaviour
 * change here. An unrecognised state would fall to "nothing to drain", which is
 * the wrong default for anything that might mean "connected".
 */
export type BackendConnectionStatus = 'initializing' | 'ready' | 'closing' | 'closed';

export function hasNothingToDrain(status: BackendConnectionStatus): boolean {
  return status !== 'ready';
}
