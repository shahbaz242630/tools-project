import { createServer } from 'node:http';
import type { Logger, Metrics } from '@platform/observability';

/**
 * The worker's scrape endpoint (slice H6).
 *
 * ## Why the worker needs one at all
 *
 * Until H6 the worker was the one running service nothing could see. Prometheus
 * scraped `api` and itself; the worker had no HTTP surface, so `recordQueueJob` sat
 * unused in the `Metrics` port from H1 onwards and no number about the queue
 * outlived a deploy. Slice 4.7b then put a schedule in here, which made that gap
 * matter: *"the sweep ran"* and *"the sweep has not run since Tuesday"* looked
 * identical from outside.
 *
 * ## Node's own `http`, and no framework
 *
 * One route, one method, one content type. Adding Fastify or Nest to a queue
 * consumer would pull a request pipeline, a router and a plugin system into a
 * process whose entire HTTP surface is a single `GET` — and `pnpm invariants` would
 * then have a second app importing a framework it has no other use for. This file
 * is the whole server.
 *
 * ## Unauthenticated, for exactly the reason the API's is
 *
 * **The worker is not reachable from the internet.** It joins `internal` and not
 * `edge`, it publishes no port, and the `Deploy rehearsal` job asserts the stack's
 * internals are unreachable from outside. Prometheus scrapes this by service name
 * from inside the network. That is the same control `MetricsController` relies on,
 * and it is stated here rather than assumed because this is a *second* place the
 * reasoning has to hold.
 *
 * **An exposition is a map of the process**: every job type, how often each runs and
 * how long it takes. If a browser-reachable route to the worker is ever added — and
 * there is no reason for one — this must not be on it.
 *
 * ## What it deliberately does not serve
 *
 * No `/health`. The container's probe is a **file** whose freshness proves a real
 * Redis round trip (see `main.ts`), and that is a stronger signal than an HTTP
 * handler answering from the event loop: a wedged worker with a live event loop
 * would return 200 forever. Adding a second, weaker health surface beside a working
 * one is how the weaker one ends up in a compose file.
 */

/** How long to wait for in-flight scrapes when shutting down. */
const CLOSE_TIMEOUT_MS = 2_000;

export interface MetricsServerOptions {
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly port: number;
  /** Bind address. `0.0.0.0` inside a container, or nothing reaches it. */
  readonly host?: string;
}

export interface MetricsServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  /**
   * The port actually bound, or 0 before `listen()` resolves.
   *
   * **Not the same as the port asked for**, which is why it exists: passing 0 lets
   * the OS choose one, and the requested value then describes nothing. A test binds
   * that way to avoid colliding with a dev server, and reading a log line to find
   * out where it landed would be a test coupled to a sentence.
   */
  readonly boundPort: number;
}

export function createMetricsServer(options: MetricsServerOptions): MetricsServer {
  const { metrics, logger, port, host = '0.0.0.0' } = options;

  const server = createServer((request, response) => {
    /*
     * **Method and path both checked, and anything else is a 404.** A scrape
     * endpoint that answered any path would answer a scanner's probe too, and the
     * one thing this process should never do is confirm what it is to something
     * that guessed. `url` can carry a query string, so the path is taken from the
     * front of it rather than compared whole.
     */
    const path = (request.url ?? '').split('?')[0];

    if (request.method !== 'GET' || path !== '/metrics') {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }

    void metrics
      .render()
      .then((body) => {
        response
          .writeHead(200, {
            // From the adapter, not written here: the exposition format carries a
            // version and the library that produced the text is what knows which.
            'content-type': metrics.contentType,
            'cache-control': 'no-store',
          })
          .end(body);
      })
      .catch((error: unknown) => {
        /*
         * **A failed render is a 500 and never fatal.** Rendering touches the
         * registry, and an exception here must not take down a process whose job is
         * running the expiry sweep — the scraper seeing a gap is the correct
         * consequence, and `up == 0` is a thing Prometheus already understands.
         */
        logger.warn('could not render metrics', { error });
        response.writeHead(500, { 'content-type': 'text/plain' }).end('error\n');
      });
  });

  /*
   * Never a reason for this to hold the process open. If everything else has let
   * go, an idle listener must not be what keeps a container alive — the same call
   * `main.ts` makes for its health interval.
   */
  server.unref();

  let boundPort = 0;

  return {
    get boundPort(): number {
      return boundPort;
    },

    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);

          /*
           * **The bound port, read from the socket rather than echoed from the
           * options.** The first version of this logged `port` straight back, which
           * is wrong whenever the requested port is 0 — the OS picks one and the
           * request describes nothing. It coincides for any configured port, so it
           * would never have shown in production and would have made this line a
           * claim rather than the observation the comment below says it is.
           */
          const address = server.address();
          boundPort =
            typeof address === 'object' && address !== null ? address.port : port;

          /*
           * Logged after binding rather than before, so the line is evidence the
           * port is actually open. A "listening" line printed before `listen`
           * resolves is a claim, and the failure it hides is a port collision.
           */
          logger.info('metrics endpoint listening', {
            host,
            port: boundPort,
            path: '/metrics',
          });
          resolve();
        });
      });
    },

    close(): Promise<void> {
      return new Promise((resolve) => {
        /*
         * Bounded, because `server.close()` waits for open connections and a
         * scraper holding one would otherwise delay shutdown past the drain budget.
         * `closeAllConnections` after the timeout rather than instead of the wait:
         * a scrape in flight is worth two seconds and no more.
         */
        const giveUp = setTimeout(() => {
          server.closeAllConnections();
        }, CLOSE_TIMEOUT_MS);
        giveUp.unref();

        server.close(() => {
          clearTimeout(giveUp);
          resolve();
        });
      });
    },
  };
}
