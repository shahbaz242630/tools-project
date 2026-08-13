import { Landing } from '../components/landing';

/**
 * The front page (slice D3).
 *
 * A composition root: the page is one component so that its copy — which makes
 * claims about money, privacy and what the platform can do today — is
 * assertable. `app/` is outside the coverage thresholds precisely because pages
 * are wiring, and copy this consequential should not live in wiring.
 */
export default function HomePage() {
  return <Landing />;
}
