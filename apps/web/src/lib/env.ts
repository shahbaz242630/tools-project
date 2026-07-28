/**
 * The web app's validated environment, read once.
 *
 * Lazy rather than module-scope. Next evaluates module scope during `next
 * build`, where `API_BASE_URL` is deliberately not set — a build machine has no
 * API and should not need one. Reading it eagerly would make the build fail on
 * a missing variable that is only required to serve a request.
 */

import { loadWebEnv } from '@platform/config';
import type { WebEnv } from '@platform/config';

let cached: WebEnv | undefined;

export function webEnv(): WebEnv {
  cached ??= loadWebEnv();
  return cached;
}
