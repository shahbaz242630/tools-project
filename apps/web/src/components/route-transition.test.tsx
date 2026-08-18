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

  it('keeps the subtree while a multi-step sign-in walks its own sub-paths', () => {
    /*
     * **The defect this found, on 18 August 2026, and it made the product
     * unusable.** Clerk routes its whole sign-in flow underneath one catch-all
     * segment: `/sign-in`, then `/sign-in/factor-one`, then an SSO callback or a
     * verification step. Every one of those is a pathname change, so this
     * wrapper discarded `<SignIn />` and mounted a brand-new one at each step.
     *
     * A fresh instance re-runs its own routing and pushes its step path again
     * — this time relative to where it already is — so the URL grew a segment per
     * attempt: `/sign-in/factor-one`, `/sign-in/factor-one/factor-one`, and on.
     * The visible symptom was the card resetting to the email step forever, with
     * nothing in the console to say why. **Nobody could sign in at all.**
     *
     * The rule this pins: a step *inside* a page is not a navigation between
     * pages, and only the second one may remount anything.
     */
    pathname.current = '/sign-in';
    const { rerender } = render(
      <RouteTransition>
        <p>page content</p>
      </RouteTransition>,
    );
    const first = screen.getByText('page content');

    pathname.current = '/sign-in/factor-one';
    rerender(
      <RouteTransition>
        <p>page content</p>
      </RouteTransition>,
    );

    expect(screen.getByText('page content')).toBe(first);
  });

  it('still remounts when leaving a multi-step flow for an ordinary page', () => {
    // The other half of the exemption: it is scoped to movement *within* one
    // flow, and must not turn the fade off for the navigation out of it.
    pathname.current = '/sign-in/factor-one';
    const { rerender } = render(
      <RouteTransition>
        <p>page content</p>
      </RouteTransition>,
    );
    const first = screen.getByText('page content');

    pathname.current = '/account';
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
