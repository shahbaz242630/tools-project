'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import styles from './route-transition.module.css';

/**
 * The 250ms fade-up between pages (slice D3).
 *
 * **The `key` is the whole mechanism.** A CSS animation runs when an element is
 * inserted, and React reuses this wrapper across navigations — so without a key
 * that changes, the animation plays once on first load and never again, which
 * looks exactly like a transition that works until you navigate twice. Keying on
 * the pathname makes React discard the subtree and mount a new one.
 *
 * **Its children stay server components.** They arrive as a prop, already
 * rendered, so putting a client boundary here does not drag the application
 * across it.
 *
 * Deferred from D2 on purpose: it needs a client boundary at the root, and that
 * is not a decision to make inside a slice about page structure.
 *
 * **This is not a loading state and was mistaken for one for two phases.** It
 * plays when a page *arrives*; it says a navigation happened, not that one is
 * still happening — so for the whole of Phases 2 and 3 a five-second server read
 * showed the previous page, unchanged and unfaded, and then this ran once the
 * wait was already over. The loading states added in the Phase 0–3 audit
 * (`loading-skeleton.tsx` and the `loading.tsx` files beside each data segment)
 * are the other half, and the two compose rather than compete: the skeleton
 * mounts under this wrapper and fades in once, then React swaps the real content
 * into the same Suspense boundary without changing the pathname, so nothing
 * fades a second time. Do not add a second animation to the swap — one fade per
 * navigation is the design.
 *
 * Nothing is needed here for reduced motion — `globals.css` collapses every
 * animation to 0.01ms under `prefers-reduced-motion`, which is the one place
 * that rule can be enforced for code nobody has written yet.
 */
export function RouteTransition({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div key={pathname} className={styles.enter}>
      {children}
    </div>
  );
}
