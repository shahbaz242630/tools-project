/**
 * Environment for the worker's scheduled work (slice 4.7b).
 *
 * A separate schema from `loadEnv`, for the reason `loadIdentityEnv` and
 * `loadWebEnv` are separate: not every process needs this. The **API** has no use
 * for its own address, and folding this field into the shared loader would make
 * the API refuse to start without a value it never reads — the same coupling that
 * once made a queue consumer demand a JWT key.
 *
 * So the worker loads `loadEnv` **and** this. The API loads `loadEnv` and its own
 * two. **`INTERNAL_TRIGGER_SECRET` deliberately stays in the shared loader**,
 * because both processes genuinely need it: the worker to send, the API to verify.
 */

import { z } from 'zod';
import { EnvironmentError } from './env.js';
import type { EnvSource } from './env.js';

/**
 * Where the worker reaches the API, validated as a URL rather than a string.
 *
 * **Parsed at startup rather than at the first job.** A malformed value otherwise
 * surfaces as a `fetch` `TypeError` inside a scheduled job — with no request to
 * fail and nobody watching — up to fifteen minutes after the deploy that caused
 * it, which is the failure mode this whole package exists to prevent.
 *
 * **`http` is permitted and that is not an oversight.** The worker reaches the API
 * across the internal Docker network, where there is no certificate to verify and
 * nothing between them: BRD §10.2's TLS requirement is about traffic crossing the
 * edge, and the API is deliberately not on the edge network at all. Requiring
 * `https` here would mean terminating TLS between two containers on one host to
 * satisfy a rule aimed at the internet.
 */
const internalUrl = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL, for example http://api:3000');

const schema = z.object({
  /**
   * The API's address on the internal network (ADR 0048).
   *
   * `http://api:3000` deployed — the compose service name, resolved on the
   * internal network — and `http://localhost:3001` for local development, where
   * the API runs on 3001 because the Next dev server takes 3000.
   *
   * **Required, with no default.** A default would be wrong in one of the two
   * environments and wrong silently: the worker would start, the schedule would
   * fire, every trigger would fail against an address nobody chose, and the only
   * symptom would be a log line in a process nothing watches. It is the same
   * argument ADR 0038 makes for `POSTGRES_SSLMODE`.
   *
   * **It is not a secret and does not belong with one.** It names a host on a
   * private network; what authenticates the call is
   * `INTERNAL_TRIGGER_SECRET` in the shared loader.
   */
  API_INTERNAL_URL: internalUrl,
});

export type WorkerEnv = z.infer<typeof schema>;

/** Parse and validate, reporting every problem rather than only the first. */
export function loadWorkerEnv(source: EnvSource = process.env): WorkerEnv {
  const result = schema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentError(
      result.error.issues.map((issue) => {
        const name = issue.path.join('.') || '(root)';
        return issue.code === 'invalid_type' && issue.message === 'Required'
          ? `${name} is required but not set`
          : `${name}: ${issue.message}`;
      }),
    );
  }

  return result.data;
}
