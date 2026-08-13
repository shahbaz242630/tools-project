import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouteTransition } from './route-transition';

const pathname = vi.hoisted(() => ({ current: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

describe('RouteTransition', () => {
  it('renders whatever it is given', () => {
    render(
      <RouteTransition>
        <p>page content</p>
      </RouteTransition>,
    );
    expect(screen.getByText('page content')).toBeInTheDocument();
  });

  it('remounts its subtree when the path changes', () => {
    /*
     * **This is the whole mechanism.** A CSS animation runs when an element is
     * inserted, and React reuses this wrapper across navigations — so without a
     * key that changes, the fade plays once on first load and never again, which
     * looks exactly like a transition that works until you navigate twice.
     *
     * A ref that survives remounting is what makes the difference observable:
     * the same element identity means React kept the node, a new one means it
     * discarded it.
     */
    pathname.current = '/';
    const { rerender } = render(
      <RouteTransition>
        <p>page content</p>
      </RouteTransition>,
    );
    const first = screen.getByText('page content');

    pathname.current = '/status';
    rerender(
      <RouteTransition>
        <p>page content</p>
      </RouteTransition>,
    );

    expect(screen.getByText('page content')).not.toBe(first);
  });

  it('keeps the subtree when the path has not changed', () => {
    // The other half: a re-render on the same route must not throw away the
    // page, which would discard scroll position and any client state on it.
    pathname.current = '/status';
    const { rerender } = render(
      <RouteTransition>
        <p>page content</p>
      </RouteTransition>,
    );
    const first = screen.getByText('page content');

    rerender(
      <RouteTransition>
        <p>page content</p>
      </RouteTransition>,
    );

    expect(screen.getByText('page content')).toBe(first);
  });
});
