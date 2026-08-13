import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoticePage } from './notice-page';

describe('NoticePage', () => {
  it('shows the overline, the heading and the sentence', () => {
    render(
      <NoticePage overline="404" heading="This page doesn't exist.">
        The link may be old.
      </NoticePage>,
    );
    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      "This page doesn't exist.",
    );
    expect(screen.getByText('The link may be old.')).toBeInTheDocument();
  });

  it('always offers a way home', () => {
    render(
      <NoticePage overline="404" heading="Gone">
        Nothing here.
      </NoticePage>,
    );
    expect(screen.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/');
  });

  it('does not offer to browse, because there is nothing to browse', () => {
    // The design pairs "Go home" with "Browse tools", which is search — Phase 3.
    // A 404 linking to another page that does not exist is a joke at the
    // reader's expense.
    render(
      <NoticePage overline="404" heading="Gone">
        Nothing here.
      </NoticePage>,
    );
    expect(screen.queryByRole('link', { name: /browse/i })).not.toBeInTheDocument();
  });

  it('renders a caller-supplied action beside it', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();

    render(
      <NoticePage
        overline="Something went wrong"
        heading="That didn't work."
        action={
          <button type="button" onClick={reset}>
            Try again
          </button>
        }
      >
        Nothing you did caused this.
      </NoticePage>,
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('renders no action when the caller has none to give', () => {
    render(
      <NoticePage overline="404" heading="Gone">
        Nothing here.
      </NoticePage>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
