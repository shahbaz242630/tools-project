import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { Metrics } from '@platform/observability';
import { METRICS } from './metrics.tokens.js';

/**
 * The scrape endpoint (slice H1).
 *
 * **Deliberately unauthenticated, and that is safe here for one specific
 * reason: the API is not reachable from the internet.** Only `web` joins the
 * `edge` network, CI asserts it on every pull request, and Prometheus scrapes
 * this over the `internal` network from inside the stack. It is the same
 * guarantee Postgres and Redis rely on, and the same one the `Deploy rehearsal`
 * job proves with *"the data stores are not reachable from outside the stack"*.
 *
 * **If a browser-reachable route to the API is ever added, this must not be on
 * it.** An exposition is a map of the application: every route, every queue,
 * request volumes and error rates. It tells an attacker what exists and, from
 * timing histograms, roughly how expensive each thing is.
 *
 * It carries no guard, unlike every other non-health route. A guard would need
 * an identity, and Prometheus does not have one — and adding a shared secret
 * would be a credential in a place that already has a stronger control than a
 * credential.
 */
@Controller()
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: Metrics) {}

  /**
   * The exposition.
   *
   * The content type comes from the adapter rather than being written here,
   * because the exposition format has a version in it and the library that
   * produces the text is the thing that knows which one it wrote.
   */
  @Get('metrics')
  @Header('cache-control', 'no-store')
  async scrape(): Promise<string> {
    return this.metrics.render();
  }
}
