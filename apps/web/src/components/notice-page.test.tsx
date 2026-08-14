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

  /*
   * **An absence test until slice 3.1e**, saying this page must not link to
   * Browse because search was Phase 3 and a 404 pointing at a page that does not
   * exist is a joke at the reader's expense. It exists now, so the test is
   * inverted rather than deleted — and the pair below is the point: a page that
   * asks for a primary link gets one, a page that does not still gets none.
   */
  it('offers the primary link when the page has one', () => {
    render(
      <NoticePage
        overline="404"
        heading="Gone"
        primaryLink={{ href: '/browse', label: 'Browse tools' }}
      >
        Nothing here.
      </NoticePage>,
    );
    expect(screen.getByRole('link', { name: 'Browse tools' })).toHaveAttribute(
      'href',
      '/browse',
    );
  });

  it('offers none when the page has none, so the error boundary stays a pair', () => {
    // The error boundary's controls are "Try again" and "Go home". A third,
    // offering to go shopping after something broke, is noise at the wrong
    // moment.
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
