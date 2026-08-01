import { beforeEach, describe, expect, it } from 'vitest';
import type { ProfileInput } from '@platform/contracts';
import { ProfileConflictError } from './profile-store.js';
import { InMemoryAccountLookup, InMemoryProfileStore } from './testing/fakes.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { ProfilesService } from './profiles.service.js';

const ALICE_ID = '00000000-0000-4000-8000-000000000001';
const BOB_ID = '00000000-0000-4000-8000-000000000002';

/** Actors, as the controller assembles them from a verified session. */
const ALICE = { userId: ALICE_ID, ipAddress: '203.0.113.7' };
const BOB = { userId: BOB_ID, ipAddress: null };

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
let audit: AuditFakes;

beforeEach(() => {
  profiles = new InMemoryProfileStore();
  accounts = new InMemoryAccountLookup();
  accounts.add(ALICE_ID).add(BOB_ID);
  audit = createAuditFakes();
  service = new ProfilesService(profiles, accounts, audit.service);
});

describe('findMine', () => {
  it('is null before the first save', () => {
    // A normal state the form renders for, not an error.
    return expect(service.findMine(ALICE_ID)).resolves.toBeNull();
  });

  it('returns everything the owner supplied', async () => {
    await service.saveMine(ALICE, input);

    await expect(service.findMine(ALICE_ID)).resolves.toMatchObject({
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
    expect(profiles.all()[0]?.userId).toBe(ALICE_ID);
    await expect(service.findMine(BOB_ID)).resolves.toBeNull();
  });

  it('replaces rather than merges, so a cleared field really clears', async () => {
    await service.saveMine(ALICE, input);
    await service.saveMine(ALICE, {
      displayName: 'Sarah M.',
      phone: null,
      address: null,
    });

    await expect(service.findMine(ALICE_ID)).resolves.toMatchObject({
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

    await expect(service.findPublic(ALICE_ID)).resolves.toEqual({
      id: ALICE_ID,
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
    const published = await service.findPublic(ALICE_ID);

    expect(JSON.stringify(published)).not.toContain('8AA');
    expect(published?.outwardCode).toBe('BS7');
  });

  it('never publishes a phone number or a street line', async () => {
    await service.saveMine(ALICE, input);
    const serialised = JSON.stringify(await service.findPublic(ALICE_ID));

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

    await expect(service.findPublic(ALICE_ID)).resolves.toMatchObject({
      outwardCode: null,
      town: null,
    });
  });

  it('is null for an account that has no profile yet', () => {
    return expect(service.findPublic(ALICE_ID)).resolves.toBeNull();
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
    accounts.remove(ALICE_ID);

    await expect(service.findPublic(ALICE_ID)).resolves.toBeNull();
    // Still there — this is a disclosure rule, not a deletion.
    expect(profiles.all()).toHaveLength(1);
  });

  it('gives one answer for absent, deleted and profileless', async () => {
    // Three different underlying states, one response. Distinguishing them
    // would make this route an oracle for which user ids are real.
    await service.saveMine(BOB, input);
    accounts.remove(BOB_ID);

    const absent = await service.findPublic('00000000-0000-4000-8000-00000000dead');
    const deleted = await service.findPublic(BOB_ID);
    const noProfile = await service.findPublic(ALICE_ID);

    expect([absent, deleted, noProfile]).toEqual([null, null, null]);
  });

  it('dates membership from the account, not from the profile', async () => {
    // Somebody who signed up in January and filled in their profile in June is
    // a member since January. Taking it from the profile row would quietly
    // shorten everyone's history to whenever they last discovered the form.
    accounts.add(ALICE_ID, new Date('2026-01-03T00:00:00.000Z'));
    await service.saveMine(ALICE, input);

    await expect(service.findPublic(ALICE_ID)).resolves.toMatchObject({
      memberSince: '2026-01',
    });
  });

  it('gives month precision, never a day or a time', async () => {
    accounts.add(ALICE_ID, new Date('2026-11-27T23:45:12.345Z'));
    await service.saveMine(ALICE, input);

    const published = await service.findPublic(ALICE_ID);
    expect(published?.memberSince).toBe('2026-11');
    expect(JSON.stringify(published)).not.toContain('27');
  });
});

describe('adminSummaryFor', () => {
  it('is null when no profile was ever made', async () => {
    // Different from an empty profile, and the distinction is what tells
    // support "they never filled this in" rather than "something is broken".
    await expect(service.adminSummaryFor(ALICE_ID)).resolves.toBeNull();
  });

  it('reports the district, never the full postcode', async () => {
    await service.saveMine(ALICE, input);

    await expect(service.adminSummaryFor(ALICE_ID)).resolves.toMatchObject({
      displayName: 'Sarah M.',
      address: { town: 'Bristol', outwardCode: 'BS7' },
    });
  });

  it('carries no street line, postcode or phone number at all', async () => {
    // The property that keeps ADR 0019's claim true — the export stays the one
    // path by which a decrypted street line leaves the database. Asserted over
    // the serialised summary so a field added later is caught here.
    await service.saveMine(ALICE, input);

    const serialised = JSON.stringify(await service.adminSummaryFor(ALICE_ID));

    expect(serialised).not.toContain('Acacia');
    expect(serialised).not.toContain('BS7 8AA');
    expect(serialised).not.toContain('447700900123');
    expect(serialised).toContain('BS7');
  });

  it('says whether a phone number is saved, not what it is', async () => {
    await service.saveMine(ALICE, input);
    await service.saveMine(BOB, { ...input, phone: null });

    await expect(service.adminSummaryFor(ALICE_ID)).resolves.toMatchObject({
      hasPhone: true,
    });
    await expect(service.adminSummaryFor(BOB_ID)).resolves.toMatchObject({
      hasPhone: false,
    });
  });

  it('distinguishes no address from an address', async () => {
    await service.saveMine(ALICE, { ...input, address: null });

    await expect(service.adminSummaryFor(ALICE_ID)).resolves.toMatchObject({
      address: null,
    });
  });

  it('answers for an account the lookup no longer calls active', async () => {
    // Unlike `findPublic`, which checks first. Support is asked about an
    // account precisely when something has gone wrong with it, and the
    // deletion state is Identity's to report rather than this module's to hide.
    await service.saveMine(ALICE, input);
    accounts.remove(ALICE_ID);

    await expect(service.adminSummaryFor(ALICE_ID)).resolves.not.toBeNull();
  });

  it('records nothing — the disclosure is the caller’s to audit', async () => {
    // Identity writes `admin.user_viewed` before calling this. A second entry
    // here would double-count one disclosure in a six-year trail.
    await service.saveMine(ALICE, input);
    const before = audit.log.entries().length;

    await service.adminSummaryFor(ALICE_ID);

    expect(audit.log.entries()).toHaveLength(before);
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

describe('the audit trail', () => {
  it('records a creation on the first save', async () => {
    await service.saveMine(ALICE, input);

    expect(audit.log.entries()).toHaveLength(1);
    expect(audit.log.entries()[0]).toMatchObject({
      actorId: ALICE_ID,
      action: 'profile.created',
      targetType: 'profile',
      ipAddress: '203.0.113.7',
      // Absent, not empty: there was no prior state to digest.
      beforeHash: null,
    });
  });

  it('records an update on the second', async () => {
    await service.saveMine(ALICE, input);
    await service.saveMine(ALICE, { ...input, displayName: 'Sarah Mitchell' });

    const [, second] = audit.log.entries();
    expect(second).toMatchObject({ action: 'profile.updated' });
    expect(second?.beforeHash).not.toBeNull();
    expect(second?.beforeHash).not.toBe(second?.afterHash);
  });

  it('names the profile row, not the account', async () => {
    // An audit trail is the last place to leave an ambiguous reference. Using
    // the user id would work only while profiles are one-per-account.
    const saved = await service.saveMine(ALICE, input);
    expect(saved).toBeDefined();

    expect(audit.log.entries()[0]?.targetId).toBe(profiles.all()[0]?.id);
  });

  it('records no value, only digests of one', async () => {
    await service.saveMine(ALICE, input);

    const serialised = JSON.stringify(audit.log.entries());
    expect(serialised).not.toContain('Sarah');
    expect(serialised).not.toContain('900123');
    expect(serialised).not.toContain('Acacia');
  });

  it('ignores updatedAt, so an unchanged save is visibly unchanged', async () => {
    // The digest covers the profile's content and not its timestamp. Including
    // updatedAt would make every save look like a change, which destroys the
    // only thing comparing digests is for.
    await service.saveMine(ALICE, input);
    await service.saveMine(ALICE, input);

    const [, second] = audit.log.entries();
    expect(second?.beforeHash).toBe(second?.afterHash);
  });

  it('records the address the actor arrived from', async () => {
    await service.saveMine(BOB, input);
    expect(audit.log.entries()[0]).toMatchObject({ actorId: BOB_ID, ipAddress: null });
  });

  it('fails the save when the audit write fails', async () => {
    // Fail closed. A profile changed with no record of who changed it is the
    // outcome the audit log exists to prevent (ADR 0017).
    audit.log.failNextRecord(new Error('connection terminated unexpectedly'));

    await expect(service.saveMine(ALICE, input)).rejects.toThrow(
      /connection terminated/,
    );
  });
});

describe('eraseFor', () => {
  it('removes the profile and its address', async () => {
    await service.saveMine(ALICE, input);
    await service.eraseFor(ALICE);

    await expect(service.findMine(ALICE_ID)).resolves.toBeNull();
    expect(profiles.all()).toHaveLength(0);
  });

  it('stops the profile being publicly visible', async () => {
    // The debt slice 1.4 left: until now a deleted account's profile survived
    // and only the disclosure check kept it off the internet. Now it is gone.
    accounts.add(ALICE_ID);
    await service.saveMine(ALICE, input);
    await expect(service.findPublic(ALICE_ID)).resolves.not.toBeNull();

    await service.eraseFor(ALICE);

    await expect(service.findPublic(ALICE_ID)).resolves.toBeNull();
  });

  it('records what it erased', async () => {
    await service.saveMine(ALICE, input);
    await service.eraseFor(ALICE);

    const entry = audit.log.entries().find((e) => e.action === 'profile.erased');
    expect(entry).toMatchObject({ actorId: ALICE_ID, targetType: 'profile' });
    // Before, but no after: there is no resulting state, the row is gone.
    expect(entry?.beforeHash).not.toBeNull();
    expect(entry?.afterHash).toBeNull();
  });

  it('keeps no personal data in that record', async () => {
    await service.saveMine(ALICE, input);
    await service.eraseFor(ALICE);

    const serialised = JSON.stringify(audit.log.entries());
    expect(serialised).not.toContain('Sarah');
    expect(serialised).not.toContain('Acacia');
    expect(serialised).not.toContain('900123');
  });

  it('is idempotent', async () => {
    await service.saveMine(ALICE, input);
    await service.eraseFor(ALICE);

    await expect(service.eraseFor(ALICE)).resolves.toBeUndefined();
  });

  it('records nothing for somebody who never made a profile', async () => {
    // An entry claiming a profile was removed from somebody who never had one
    // is a false line in a trail retained for six years.
    await service.eraseFor(ALICE);

    expect(
      audit.log.entries().filter((e) => e.action === 'profile.erased'),
    ).toHaveLength(0);
  });

  it('touches nobody else’s data', async () => {
    await service.saveMine(ALICE, input);
    await service.saveMine(BOB, { ...input, displayName: 'Bob B.' });

    await service.eraseFor(ALICE);

    await expect(service.findMine(BOB_ID)).resolves.toMatchObject({
      displayName: 'Bob B.',
    });
  });
});
