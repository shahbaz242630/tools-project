import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusReport } from './status-report';

describe('StatusReport', () => {
  it('shows each dependency and its status when ready', () => {
    render(
      <StatusReport
        outcome={{ kind: 'ready', checks: { postgres: 'ok', redis: 'ok' } }}
      />,
    );
    expect(screen.getByRole('heading')).toHaveTextContent('API: ready');
    expect(screen.getByText('postgres')).toBeInTheDocument();
    expect(screen.getAllByText('ok')).toHaveLength(2);
  });

  it('says not ready and still names the broken dependency', () => {
    // The detail is the point. "Not ready" alone sends someone to the logs for
    // something the page already knows.
    render(
      <StatusReport
        outcome={{ kind: 'not_ready', checks: { postgres: 'failed', redis: 'ok' } }}
      />,
    );
    expect(screen.getByRole('heading')).toHaveTextContent('API: not ready');
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('distinguishes a timeout from a failure', () => {
    render(
      <StatusReport outcome={{ kind: 'not_ready', checks: { redis: 'timeout' } }} />,
    );
    expect(screen.getByText('timeout')).toBeInTheDocument();
  });

  it('says so explicitly when there are no dependencies rather than showing an empty list', () => {
    render(<StatusReport outcome={{ kind: 'ready', checks: {} }} />);
    expect(screen.getByText(/reported no dependencies/)).toBeInTheDocument();
  });

  it('shows the reason when the API is unreachable', () => {
    render(<StatusReport outcome={{ kind: 'unreachable', reason: 'ECONNREFUSED' }} />);
    expect(screen.getByRole('heading')).toHaveTextContent('API: unreachable');
    expect(screen.getByText('ECONNREFUSED')).toBeInTheDocument();
  });

  it('explains a malformed response as a probable deploy skew', () => {
    render(
      <StatusReport outcome={{ kind: 'malformed', reason: 'checks.postgres: bad' }} />,
    );
    expect(screen.getByRole('heading')).toHaveTextContent('unrecognised response');
    expect(screen.getByText(/deploy is in progress/)).toBeInTheDocument();
    expect(screen.getByText('checks.postgres: bad')).toBeInTheDocument();
  });

  it('labels the section for assistive technology in every state', () => {
    for (const outcome of [
      { kind: 'ready', checks: {} },
      { kind: 'not_ready', checks: {} },
      { kind: 'unreachable', reason: 'x' },
      { kind: 'malformed', reason: 'x' },
    ] as const) {
      const { unmount } = render(<StatusReport outcome={outcome} />);
      expect(screen.getByRole('region')).toBeInTheDocument();
      unmount();
    }
  });
});
