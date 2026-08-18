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
 *
 * **One exception to the key, and it is not cosmetic — it made signing in
 * impossible** (found 18 August 2026, walking slice 4.5b). See
 * `MULTI_STEP_PREFIXES` below.
 */
export function RouteTransition({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div key={transitionKey(pathname)} className={styles.enter}>
      {children}
    </div>
  );
}

/**
 * Paths where a component routes its own steps underneath one page.
 *
 * **Clerk mounts a whole multi-step flow under a single catch-all segment.**
 * `/sign-in` becomes `/sign-in/factor-one`, then an SSO callback, then a
 * verification step — and every one of those is a pathname change. Keying on the
 * full pathname therefore threw `<SignIn />` away and mounted a new one at each
 * step, and a fresh instance re-runs its own routing and pushes its step path
 * *again*, relative to where it already is. The URL grew a segment per attempt
 * — `/sign-in/factor-one/factor-one/factor-one` — and the card reset to the
 * email step every time, with nothing in the console to say why.
 *
 * **Nobody could sign in.** It is written here as a list of prefixes rather than
 * a clever rule for `proxy.ts`'s reason: three literal strings can be argued
 * with, and the failure of getting this wrong is silent in both directions.
 *
 * `/account/email` is on it because slice 1.6 gives Clerk the same catch-all
 * treatment for changing an email address.
 */
const MULTI_STEP_PREFIXES = ['/sign-in', '/sign-up', '/account/email'] as const;

/**
 * The identity of the *page*, which is not always the pathname.
 *
 * A step inside a flow keeps the flow's key, so the subtree survives it. Every
 * other navigation keys on the whole path, so `/hire/a` to `/hire/b` still
 * fades — which is the design, and is what a coarser rule like "the first
 * segment" would have quietly broken.
 */
function transitionKey(pathname: string): string {
  const flow = MULTI_STEP_PREFIXES.find(
    // Whole segments, never a bare `startsWith` on the prefix alone: a future
    // `/sign-in-help` is a different page and must keep its own key.
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  return flow ?? pathname;
}
