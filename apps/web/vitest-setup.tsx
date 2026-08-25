// Adds the DOM matchers (toHaveTextContent, toBeInTheDocument) to expect.
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

// Testing Library registers this itself only when vitest runs with
// `globals: true`. This suite imports `describe`/`it`/`expect` explicitly, so
// without it every render accumulates in the same document and queries start
// matching elements left behind by earlier tests — which shows up as
// "found multiple elements", several tests away from the cause.
afterEach(cleanup);

/**
 * Pay React's first-render cost here rather than inside somebody's first test.
 *
 * **This is a flake fix, and the flake was not what it looked like.** Three web
 * component files failed intermittently under `pnpm test:coverage` with *"Test
 * timed out in 5000ms"* — always the **first** test in whichever file lost the
 * race, never the same file twice. Measured in isolation the pattern is plain:
 * the first test in a component file takes ~680 ms and every test after it
 * takes 45–80 ms, because the first `render` is what initialises React's
 * reconciler, jsdom's document and Testing Library's query layer. That one-off
 * belongs to the *file*, and charging it to whichever test happens to be first
 * is what let 16 workers on 16 cores push it past a five-second budget.
 *
 * A setup file runs before any test in its file and its time is reported
 * separately, so the cost lands where it belongs and no test is billed for it.
 *
 * **`getByRole` is here deliberately and is most of the saving**, which is not
 * what the first version of this warm-up assumed. Rendering alone moved the
 * cost barely at all — 677 ms to 611 ms — because the expensive part is not
 * React. Testing Library builds its accessibility tree lazily on the first
 * role-based query, loading `aria-query` and computing accessible names, and
 * that is what the first test in each file was really paying for. Rendering a
 * `button` and asking for it by role exercises exactly that path.
 *
 * `cleanup` afterwards leaves the document exactly as a test expects to find it.
 *
 * **Skipped where there is no document** (slice 2.6c). One file in this project
 * runs `@vitest-environment node` — the media upload route handler, which parses
 * a multipart body that jsdom cannot — and a warm-up that renders would fail its
 * whole suite before a single test ran, with `document is not defined` pointing
 * at this file rather than at the one that opted out. There is nothing to warm
 * up without a DOM, so there is nothing to do.
 */
beforeAll(() => {
  if (typeof document === 'undefined') return;

  render(<button type="button">warm</button>);
  screen.getByRole('button', { name: 'warm' });
  cleanup();
});
