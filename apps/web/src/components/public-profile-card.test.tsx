import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PublicProfileCard } from './public-profile-card';
import type { PublicProfileOutcome } from '../lib/profile';

const PROFILE = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Sarah M.',
  outwardCode: 'BS7',
  town: 'Bristol',
  memberSince: '2026-07',
} as const;

describe('PublicProfileCard', () => {
  it('shows the name, the district and the month', () => {
    render(<PublicProfileCard outcome={{ kind: 'found', profile: PROFILE }} />);

    expect(screen.getByText('Sarah M.')).toBeInTheDocument();
    expect(screen.getByText('Bristol · BS7')).toBeInTheDocument();
    expect(screen.getByText('July 2026')).toBeInTheDocument();
  });

  it('renders no location for a profile without an address', () => {
    render(
      <PublicProfileCard
        outcome={{
          kind: 'found',
          profile: { ...PROFILE, outwardCode: null, town: null },
        }}
      />,
    );

    expect(screen.getByText('Sarah M.')).toBeInTheDocument();
    expect(screen.queryByText('Location')).not.toBeInTheDocument();
  });

  it('shows a town alone when there is no district', () => {
    render(
      <PublicProfileCard
        outcome={{ kind: 'found', profile: { ...PROFILE, outwardCode: null } }}
      />,
    );
    expect(screen.getByText('Bristol')).toBeInTheDocument();
  });

  it('renders the month in UTC, so it cannot slip backwards', () => {
    // `new Date('2026-01')` is read as local time by some engines, which renders
    // as December west of Greenwich. Parsing as an explicit UTC day avoids a bug
    // that would only ever appear for some readers.
    render(
      <PublicProfileCard
        outcome={{ kind: 'found', profile: { ...PROFILE, memberSince: '2026-01' } }}
      />,
    );
    expect(screen.getByText('January 2026')).toBeInTheDocument();
  });

  it('says the same thing for missing, deleted and profileless', () => {
    render(<PublicProfileCard outcome={{ kind: 'not-found' }} />);
    expect(screen.getByText(/no profile here/i)).toBeInTheDocument();
  });

  it.each([
    ['unreachable', { kind: 'unreachable', reason: 'connect ECONNREFUSED' }],
    ['malformed', { kind: 'malformed', reason: 'id: invalid uuid' }],
  ])('does not claim the profile is missing when %s', (_case, outcome) => {
    // "There is no profile here" for an API outage would tell somebody their
    // account had vanished.
    render(<PublicProfileCard outcome={outcome as PublicProfileOutcome} />);
    expect(screen.queryByText(/no profile here/i)).not.toBeInTheDocument();
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
  });
});
