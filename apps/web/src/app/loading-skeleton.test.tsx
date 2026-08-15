import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  LoadingAnnouncement,
  LoadingPage,
  SkeletonField,
  SkeletonLine,
  SkeletonPanel,
  SkeletonTitle,
} from './loading-skeleton';

/**
 * The skeleton has no data and no branches, so what is worth pinning is the two
 * properties it exists for: that somebody who cannot see it is told what is
 * happening, and that everything they *can* see is hidden from them rather than
 * announced as a page full of empty boxes.
 */

describe('what a screen reader is told', () => {
  it('announces the thing being waited for, politely', () => {
    render(<LoadingAnnouncement>Loading your listings</LoadingAnnouncement>);

    // `status`, not `alert`: waiting for a page is not an error, and an
    // assertive region interrupts whatever was being read.
    expect(screen.getByRole('status')).toHaveTextContent('Loading your listings');
  });

  it('hides every bar from the accessibility tree', () => {
    // A skeleton announced as content is a page of empty boxes read aloud. The
    // announcement above is the only thing in here with anything to say.
    const { container } = render(
      <LoadingPage>
        <LoadingAnnouncement>Loading</LoadingAnnouncement>
        <SkeletonTitle />
        <SkeletonLine />
        <SkeletonLine width="long" />
        <SkeletonLine width="short" />
        <SkeletonPanel />
        <SkeletonPanel height="short" />
        <SkeletonField />
      </LoadingPage>,
    );

    const decorative = container.querySelectorAll('[aria-hidden="true"]');
    expect(decorative.length).toBe(8);

    // Nothing else in the tree carries text, so the whole visible page has
    // exactly one thing to say.
    expect(container).toHaveTextContent('Loading');
  });
});

describe('the column it occupies', () => {
  it('is the page’s own, so nothing reflows when the content arrives', () => {
    // `--page-width` is read on `<main>` and differs per route. The class comes
    // from the page's module rather than being restated, so the two cannot
    // disagree about how wide the route is.
    const { container } = render(<LoadingPage className="wide">x</LoadingPage>);

    expect(container.querySelector('main')).toHaveClass('wide');
  });

  it('renders a main landmark, which is where the skip link lands', () => {
    render(<LoadingPage>x</LoadingPage>);

    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
