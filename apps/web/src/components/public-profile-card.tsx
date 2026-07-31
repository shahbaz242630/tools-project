import { Time } from '@platform/core';
import type { PublicProfileOutcome } from '../lib/profile';

/**
 * Somebody's public profile, as everybody sees it.
 *
 * Presentational and exhaustive: every branch of `PublicProfileOutcome` is
 * handled, so adding a case to that union is a type error here rather than a
 * blank panel.
 *
 * It renders only what the contract carries, and the contract carries no
 * contact data. There is deliberately nothing here that reaches for a field the
 * public projection does not have — if a future layout wants a phone number,
 * that has to be a visible change to `publicProfileSchema` and not a quiet one
 * in a component.
 */
export function PublicProfileCard({ outcome }: { outcome: PublicProfileOutcome }) {
  switch (outcome.kind) {
    case 'found': {
      const { profile } = outcome;
      const location = [profile.town, profile.outwardCode]
        .filter((part): part is string => part !== null)
        .join(' · ');

      return (
        <section aria-labelledby="profile">
          <h2 id="profile">{profile.displayName}</h2>
          <dl>
            {location === '' ? null : (
              <div>
                <dt>Location</dt>
                {/* District, never the full postcode. The value simply is not
                    in the response — see publicProfileSchema. */}
                <dd>{location}</dd>
              </div>
            )}
            <div>
              <dt>Member since</dt>
              <dd>{formatMonth(profile.memberSince)}</dd>
            </div>
          </dl>
        </section>
      );
    }

    case 'not-found':
      return (
        <section aria-labelledby="profile">
          <h2 id="profile">Profile not found</h2>
          {/* One message for "no such account", "deleted" and "no profile yet".
              The API does not distinguish them, and neither should this. */}
          <p>There is no profile here.</p>
        </section>
      );

    case 'unreachable':
      return (
        <section aria-labelledby="profile">
          <h2 id="profile">Profile unavailable</h2>
          <p>This profile could not be loaded — {outcome.reason}</p>
        </section>
      );

    case 'malformed':
      return (
        <section aria-labelledby="profile">
          <h2 id="profile">Profile unavailable</h2>
          <p>
            The API answered with something this version of the site does not
            understand. If a deploy is in progress, this should clear on its own.
          </p>
          <p>{outcome.reason}</p>
        </section>
      );
  }
}

/**
 * `2026-07` → `July 2026`.
 *
 * Pinned to UTC at both ends. `new Date('2026-07')` is read as local time by
 * some engines, which renders as June for a reader west of Greenwich — a bug
 * that would appear for some people and not others, and never here.
 */
function formatMonth(yearMonth: string): string {
  const instant = Time.fromIsoUtc(`${yearMonth}-01T00:00:00.000Z`);

  return instant.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
