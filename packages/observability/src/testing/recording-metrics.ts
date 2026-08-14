import type {
  DatabaseQuerySample,
  GeocodeSample,
  HttpRequestSample,
  ListingSearchSample,
  Metrics,
  QueueJobSample,
} from '../metrics.js';
import { PROMETHEUS_CONTENT_TYPE } from '../metrics.js';

/**
 * Everything one of these was handed, kept in the order it arrived.
 *
 * Separate arrays rather than one tagged list, because every assertion a test
 * wants to write is about one kind of sample — and `records.filter(r => r.kind
 * === 'search')` in every test is the shape that eventually gets written wrong.
 */
export interface RecordingMetrics {
  readonly metrics: Metrics;
  readonly httpRequests: HttpRequestSample[];
  readonly databaseQueries: DatabaseQuerySample[];
  readonly queueJobs: QueueJobSample[];
  readonly listingSearches: ListingSearchSample[];
  readonly geocodes: GeocodeSample[];
}

/**
 * Metrics that keep what they were given (slice 3.1f).
 *
 * **The test fake BRD §5 asks for beside every adapter**, and it arrives three
 * slices after the interface did because until now there was nothing worth
 * asserting: H1's samples come from a Fastify hook, which
 * `metrics.hook.test.ts` drove with a hand-rolled object. Slice 3.1f puts
 * recording calls inside *application services*, where whether the call happened
 * at all is a property of the code under test rather than of the framework.
 *
 * **It exists as one shared fake rather than a literal per test file for a
 * reason the compiler enforces**: a method added to `Metrics` breaks one file
 * here instead of appearing to be optional at a dozen call sites. Both of
 * `metrics.hook.test.ts`'s hand-rolled doubles were replaced by this when it was
 * written, which is what made that guarantee true rather than aspirational.
 *
 * **`render` returns empty exposition**, like the no-op adapter: nothing here
 * pretends to be Prometheus. Assertions belong on the arrays above, where they
 * are about what the code decided rather than about text formatting — that is
 * `metrics.test.ts`'s job, against the real registry.
 */
export function createRecordingMetrics(): RecordingMetrics {
  const httpRequests: HttpRequestSample[] = [];
  const databaseQueries: DatabaseQuerySample[] = [];
  const queueJobs: QueueJobSample[] = [];
  const listingSearches: ListingSearchSample[] = [];
  const geocodes: GeocodeSample[] = [];

  return {
    metrics: {
      recordHttpRequest: (sample) => httpRequests.push(sample),
      recordDatabaseQuery: (sample) => databaseQueries.push(sample),
      recordQueueJob: (sample) => queueJobs.push(sample),
      recordListingSearch: (sample) => listingSearches.push(sample),
      recordGeocode: (sample) => geocodes.push(sample),
      render: () => Promise.resolve(''),
      contentType: PROMETHEUS_CONTENT_TYPE,
    },
    httpRequests,
    databaseQueries,
    queueJobs,
    listingSearches,
    geocodes,
  };
}
