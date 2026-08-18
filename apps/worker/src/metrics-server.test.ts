import { afterEach, describe, expect, it } from 'vitest';
import { createNoopMetrics } from '@platform/observability';
import { createRecordingLogger } from '@platform/observability/testing';
import type { Metrics } from '@platform/observability';
import { createMetricsServer } from './metrics-server.js';
import type { MetricsServer } from './metrics-server.js';

/**
 * The worker's scrape endpoint (slice H6).
 *
 * **A real server on a real port, not a mocked `http` module.** What is worth
 * asserting here is what a scraper receives — the status, the content type, and that
 * every other path is a 404 — and none of that survives faking the transport. Port 0
 * lets the OS choose, so tests never collide with each other or with a dev server.
 */

let server: MetricsServer | undefined;
let port = 0;

/** Start a server on an OS-chosen port and remember it for teardown. */
async function start(metrics: Metrics): Promise<string> {
  const logger = createRecordingLogger();
  server = createMetricsServer({
    metrics,
    logger: logger.logger,
    port: 0,
    host: '127.0.0.1',
  });
  await server.listen();

  /*
   * Read off the server rather than out of a log line. The log *also* carries it, and
   * one test below asserts that specifically — but a test that needed a sentence in
   * order to reach the port would fail on a wording change.
   */
  port = server.boundPort;
  return `http://127.0.0.1:${String(port)}`;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Metrics that render a known body, so the response can be asserted exactly. */
function rendering(body: string): Metrics {
  return {
    ...createNoopMetrics(createRecordingLogger().logger),
    render: () => Promise.resolve(body),
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
  };
}

describe('the worker metrics endpoint', () => {
  it('serves the exposition on /metrics', async () => {
    const base = await start(rendering('# HELP queue_job_duration_seconds x\n'));

    const response = await fetch(`${base}/metrics`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('queue_job_duration_seconds');
  });

  it('serves the content type the adapter reports, not one written here', async () => {
    // The exposition format carries a version, and the library that produced the text
    // is the thing that knows which one it wrote.
    const base = await start(rendering('# ok\n'));

    const response = await fetch(`${base}/metrics`);

    expect(response.headers.get('content-type')).toContain('version=0.0.4');
  });

  it('tells caches not to keep it', async () => {
    const base = await start(rendering('# ok\n'));

    const response = await fetch(`${base}/metrics`);

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('404s every other path', async () => {
    /*
     * A scrape endpoint that answered any path would answer a scanner's probe too,
     * and the one thing this process should never do is confirm what it is to
     * something that guessed.
     */
    const base = await start(rendering('# ok\n'));

    for (const path of ['/', '/health', '/metrics/extra', '/Metrics']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
  });

  it('ignores a query string when matching the path', async () => {
    // Prometheus does not send one, but a proxy or a curl by hand can, and 404ing a
    // valid scrape because of `?x=1` would be a confusing outage.
    const base = await start(rendering('# ok\n'));

    expect((await fetch(`${base}/metrics?debug=1`)).status).toBe(200);
  });

  it('refuses methods other than GET', async () => {
    const base = await start(rendering('# ok\n'));

    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers 500 rather than dying when rendering fails', async () => {
    /*
     * **The important one.** Rendering touches the registry, and an exception must not
     * take down a process whose job is running the expiry sweep. The scraper seeing a
     * gap is the correct consequence — `up == 0` is a condition Prometheus already
     * understands.
     */
    const logger = createRecordingLogger();
    const broken: Metrics = {
      ...createNoopMetrics(logger.logger),
      render: () => Promise.reject(new Error('registry exploded')),
    };
    server = createMetricsServer({
      metrics: broken,
      logger: logger.logger,
      port: 0,
      host: '127.0.0.1',
    });
    await server.listen();
    const bound = server.boundPort;

    const response = await fetch(`http://127.0.0.1:${String(bound)}/metrics`);

    expect(response.status).toBe(500);
    expect(logger.at('warn')[0]?.message).toBe('could not render metrics');

    // Still serving: the process survived and the next scrape gets an answer.
    expect((await fetch(`http://127.0.0.1:${String(bound)}/nope`)).status).toBe(404);
  });

  it('logs the port it actually bound, not the one it was asked for', async () => {
    /*
     * The first version echoed the requested port straight into the log, which is
     * wrong for port 0 and *right by coincidence* for every configured port — so it
     * would never have shown in production while making a "listening on 9464" line a
     * claim rather than an observation.
     */
    const logger = createRecordingLogger();
    const own = createMetricsServer({
      metrics: rendering('# ok\n'),
      logger: logger.logger,
      port: 0,
      host: '127.0.0.1',
    });
    await own.listen();

    try {
      expect(own.boundPort).toBeGreaterThan(0);
      expect((logger.at('info')[0]?.fields as { port?: number }).port).toBe(
        own.boundPort,
      );
    } finally {
      await own.close();
    }
  });

  it('can be closed, and stops answering', async () => {
    const base = await start(rendering('# ok\n'));
    await server?.close();
    server = undefined;

    await expect(fetch(`${base}/metrics`)).rejects.toThrow();
  });
});
