// Adds the DOM matchers (toHaveTextContent, toBeInTheDocument) to expect.
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library registers this itself only when vitest runs with
// `globals: true`. This suite imports `describe`/`it`/`expect` explicitly, so
// without it every render accumulates in the same document and queries start
// matching elements left behind by earlier tests — which shows up as
// "found multiple elements", several tests away from the cause.
afterEach(cleanup);
