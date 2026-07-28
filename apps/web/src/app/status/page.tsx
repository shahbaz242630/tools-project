import Link from 'next/link';
import { StatusReport } from '../../components/status-report';
import { webEnv } from '../../lib/env';
import { fetchReadiness } from '../../lib/readiness';

/**
 * Never prerendered.
 *
 * Without this Next would render the page at build time, where no API is
 * running — baking "unreachable" into a static file and serving that answer
 * forever. It also has to be per-request to be worth anything: a cached
 * readiness check is just a timestamp.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Status' };

export default async function StatusPage() {
  const outcome = await fetchReadiness(webEnv().API_BASE_URL);

  return (
    <main>
      <h1>Status</h1>
      <p>
        Live, read from the API on each request. Nothing here is cached or hard-coded.
      </p>

      <StatusReport outcome={outcome} />

      <p>
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
