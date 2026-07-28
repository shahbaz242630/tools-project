import type { ReadinessOutcome } from '../lib/readiness';

/**
 * Renders one readiness outcome.
 *
 * Presentational and exhaustive: every branch of `ReadinessOutcome` is handled,
 * so adding a case to that union is a type error here rather than a silently
 * blank panel.
 */
export function StatusReport({ outcome }: { outcome: ReadinessOutcome }) {
  switch (outcome.kind) {
    case 'ready':
    case 'not_ready':
      return (
        <section aria-labelledby="api-status">
          {/* One interpolated string rather than `API: {expression}`. React
              renders adjacent text nodes with a `<!-- -->` separator between
              them, so the latter never produces the literal "API: ready" in the
              HTML — which quietly breaks anything asserting on the markup. */}
          <h2 id="api-status">{`API: ${outcome.kind === 'ready' ? 'ready' : 'not ready'}`}</h2>
          <dl>
            {Object.entries(outcome.checks).map(([dependency, status]) => (
              <div key={dependency}>
                <dt>{dependency}</dt>
                <dd>{status}</dd>
              </div>
            ))}
          </dl>
          {Object.keys(outcome.checks).length === 0 ? (
            <p>The API reported no dependencies.</p>
          ) : null}
        </section>
      );

    case 'unreachable':
      return (
        <section aria-labelledby="api-status">
          <h2 id="api-status">API: unreachable</h2>
          <p>{outcome.reason}</p>
        </section>
      );

    case 'malformed':
      return (
        <section aria-labelledby="api-status">
          <h2 id="api-status">API: unrecognised response</h2>
          {/* Named explicitly, because the usual cause is a version skew during
              a deploy and that is not obvious from a generic error. */}
          <p>
            The API answered with something this version of the site does not
            understand. If a deploy is in progress, this should clear on its own.
          </p>
          <p>{outcome.reason}</p>
        </section>
      );
  }
}
