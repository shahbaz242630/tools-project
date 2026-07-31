import { beforeEach, describe, expect, it } from 'vitest';
import type { ProfileInput } from '@platform/contracts';
import { ProfileConflictError } from './profile-store.js';
import { InMemoryAccountLookup, InMemoryProfileStore } from './testing/fakes.js';
import { ProfilesService } from './profiles.service.js';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';

const input: ProfileInput = {
  displayName: 'Sarah M.',
  phone: '+447700900123',
  address: {
    line1: '12 Acacia Avenue',
    line2: null,
    town: 'Bristol',
    postcode: 'BS7 8AA',
  },
};

let profiles: InMemoryProfileStore;
let accounts: InMemoryAccountLookup;
let service: ProfilesService;

beforeEach(() => {
  profiles = new InMemoryProfileStore();
  accounts = new InMemoryAccountLookup();
  accounts.add(ALICE).add(BOB);
  service = new ProfilesService(profiles, accounts);
});

describe('findMine', () => {
  it('is null before the first save', () => {
    // A normal state the form renders for, not an error.
    return expect(service.findMine(ALICE)).resolves.toBeNull();
  });

  it('returns everything the owner supplied', async () => {
    await service.saveMine(ALICE, input);

    await expect(service.findMine(ALICE)).resolves.toMatchObject({
      displayName: 'Sarah M.',
      phone: '+447700900123',
      address: {
        line1: '12 Acacia Avenue',
        town: 'Bristol',
        postcode: 'BS7 8AA',
      },
    });
  });

  it('serialises updatedAt as an ISO string for the wire', async () => {
    const saved = await service.saveMine(ALICE, input);
    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('saveMine', () => {
  it('writes only the caller’s row', async () => {
    await service.saveMine(ALICE, input);

    // The structural guarantee: the service is given the id by the guard and
    // there is no parameter through which another could be named.
    expect(profiles.all()).toHaveLength(1);
    expect(profiles.all()[0]?.userId).toBe(ALICE);
    await expect(service.findMine(BOB)).resolves.toBeNull();
  });

  it('replaces rather than merges, so a cleared field really clears', async () => {
    await service.saveMine(ALICE, input);
    await service.saveMine(ALICE, {
      displayName: 'Sarah M.',
      phone: null,
      address: null,
    });

    await expect(service.findMine(ALICE)).resolves.toMatchObject({
      phone: null,
      address: null,
    });
  });

  it('accepts a profile with a name alone', async () => {
    const saved = await service.saveMine(ALICE, {
      displayName: 'Sarah M.',
      phone: null,
      address: null,
    });

    expect(saved).toMatchObject({
      displayName: 'Sarah M.',
      phone: null,
      address: null,
    });
  });
});

describe('findPublic', () => {
  it('publishes the name, the district and the month — and nothing else', async () => {
    await service.saveMine(ALICE, input);

    await expect(service.findPublic(ALICE)).resolves.toEqual({
      id: ALICE,
      displayName: 'Sarah M.',
      outwardCode: 'BS7',
      town: 'Bristol',
      memberSince: '2026-07',
    });
  });

  it('never publishes the inward code', async () => {
    // The single most important assertion in this file. A full postcode beside
    // a name is close enough to an address to find somebody on the electoral
    // roll; the district covers thousands of homes and answers the only
    // question a renter is actually asking.
    await service.saveMine(ALICE, input);
    const published = await service.findPublic(ALICE);

    expect(JSON.stringify(published)).not.toContain('8AA');
    expect(published?.outwardCode).toBe('BS7');
  });

  it('never publishes a phone number or a street line', async () => {
    await service.saveMine(ALICE, input);
    const serialised = JSON.stringify(await service.findPublic(ALICE));

    expect(serialised).not.toContain('900123');
    expect(serialised).not.toContain('447700');
    expect(serialised).not.toContain('Acacia');
  });

  it('shows no location for a profile with no address', async () => {
    await service.saveMine(ALICE, {
      displayName: 'Sarah M.',
      phone: null,
      address: null,
    });

    await expect(service.findPublic(ALICE)).resolves.toMatchObject({
      outwardCode: null,
      town: null,
    });
  });

  it('is null for an account that has no profile yet', () => {
    return expect(service.findPublic(ALICE)).resolves.toBeNull();
  });

  it('is null for an account that does not exist', () => {
    return expect(
      service.findPublic('00000000-0000-4000-8000-00000000dead'),
    ).resolves.toBeNull();
  });

  it('stops publishing a deleted account, even with the profile row intact', async () => {
    // The profile row outlives the account: erasure is a later slice, and until
    // it exists the deletion check is what stops a deleted person's name and
    // district staying on the internet. Checking the profile alone would miss
    // this entirely.
    await service.saveMine(ALICE, input);
    accounts.remove(ALICE);

    await expect(service.findPublic(ALICE)).resolves.toBeNull();
    // Still there — this is a disclosure rule, not a deletion.
    expect(profiles.all()).toHaveLength(1);
  });

  it('gives one answer for absent, deleted and profileless', async () => {
    // Three different underlying states, one response. Distinguishing them
    // would make this route an oracle for which user ids are real.
    await service.saveMine(BOB, input);
    accounts.remove(BOB);

    const absent = await service.findPublic('00000000-0000-4000-8000-00000000dead');
    const deleted = await service.findPublic(BOB);
    const noProfile = await service.findPublic(ALICE);

    expect([absent, deleted, noProfile]).toEqual([null, null, null]);
  });

  it('dates membership from the account, not from the profile', async () => {
    // Somebody who signed up in January and filled in their profile in June is
    // a member since January. Taking it from the profile row would quietly
    // shorten everyone's history to whenever they last discovered the form.
    accounts.add(ALICE, new Date('2026-01-03T00:00:00.000Z'));
    await service.saveMine(ALICE, input);

    await expect(service.findPublic(ALICE)).resolves.toMatchObject({
      memberSince: '2026-01',
    });
  });

  it('gives month precision, never a day or a time', async () => {
    accounts.add(ALICE, new Date('2026-11-27T23:45:12.345Z'));
    await service.saveMine(ALICE, input);

    const published = await service.findPublic(ALICE);
    expect(published?.memberSince).toBe('2026-11');
    expect(JSON.stringify(published)).not.toContain('27');
  });
});

describe('ProfileConflictError', () => {
  it('carries a name, which is what callers match on', () => {
    // Matched by name rather than by `instanceof` in places that cross a module
    // boundary, so the name is part of the contract, not a debugging detail.
    const error = new ProfileConflictError(new Error('P2002'));

    expect(error.name).toBe('ProfileConflictError');
    expect(error.message).toMatch(/concurrent/);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('is propagated by the service rather than swallowed', async () => {
    // Two tabs saving a brand-new profile at once. The caller decides whether
    // re-reading is right; a service that quietly returned stale state here is
    // how somebody's save silently does nothing.
    profiles.failNextSave(new ProfileConflictError());

    await expect(service.saveMine(ALICE, input)).rejects.toThrow(ProfileConflictError);
  });
});
