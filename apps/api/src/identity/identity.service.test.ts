import { beforeEach, describe, expect, it } from 'vitest';
import { IdentityService } from './identity.service.js';
import { AccountDeletedError } from './identity-errors.js';
import { AccountErasure, tombstoneEmail } from './account-erasure.js';
import { AccountDataService } from './account-data.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PersonalDataEraser } from './personal-data-eraser.js';
import type { Logger } from '@platform/observability';
import type { VerifiedSession } from './session-verifier.js';
import { InMemoryUserDirectory, InMemoryWebhookLedger } from './testing/fakes.js';
import { UserConflictError } from './user-directory.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import {
  RecordingEraser,
  StubDataSource,
  StubListingDataSource,
} from './testing/fakes.js';
import { InMemoryAuthenticationEvents } from './testing/fakes.js';
import { createRecordingLogger } from '@platform/observability/testing';
import { mapClerkEvent } from './clerk-event-mapper.js';

const SESSION: VerifiedSession = {
  clerkUserId: 'user_1',
  sessionId: 'sess_1',
  email: 'alice@example.com',
  secondFactorAgeMinutes: null,
};

let users: InMemoryUserDirectory;
let ledger: InMemoryWebhookLedger;
let service: ReturnType<typeof identityFor>;

beforeEach(() => {
  users = new InMemoryUserDirectory();
  ledger = new InMemoryWebhookLedger();
  service = identityFor({
    directory: users,
    ledger,
    audit: createAuditFakes().service,
  });
});

describe('resolveSession', () => {
  it('creates the mirror row on first sight', async () => {
    // Clerk delivers user.created asynchronously. Without provisioning here,
    // someone who signs up and is redirected straight in meets an error until
    // the webhook lands — a race they would hit on their very first request.
    const user = await service.mirror.resolveSession(SESSION);

    expect(user).toMatchObject({
      clerkUserId: 'user_1',
      email: 'alice@example.com',
      role: 'USER',
      deletedAt: null,
    });
  });

  it('returns the same row on subsequent requests', async () => {
    const first = await service.mirror.resolveSession(SESSION);
    const second = await service.mirror.resolveSession(SESSION);

    expect(second.id).toBe(first.id);
    expect(users.all()).toHaveLength(1);
  });

  it('defaults a new account to the least privilege', async () => {
    expect((await service.mirror.resolveSession(SESSION)).role).toBe('USER');
  });

  it('converges a stale email without waiting for a webhook', async () => {
    await service.mirror.resolveSession(SESSION);

    // The token is Clerk-signed and therefore current. A mirror that disagrees
    // means user.updated was missed or is still in flight, and a redelivery may
    // never come.
    const updated = await service.mirror.resolveSession({
      ...SESSION,
      email: 'alice.new@example.com',
    });

    expect(updated.email).toBe('alice.new@example.com');
    expect(users.all()).toHaveLength(1);
  });

  it('refuses a session belonging to a deleted account', async () => {
    await service.mirror.resolveSession(SESSION);
    await service.mirror.applyEvent('msg_1', {
      type: 'user.deleted',
      clerkUserId: 'user_1',
    });

    await expect(service.mirror.resolveSession(SESSION)).rejects.toBeInstanceOf(
      AccountDeletedError,
    );
  });

  it('does not resurrect a deleted account by signing in', async () => {
    const user = await service.mirror.resolveSession(SESSION);
    await service.mirror.applyEvent('msg_1', {
      type: 'user.deleted',
      clerkUserId: 'user_1',
    });

    await service.mirror.resolveSession(SESSION).catch(() => undefined);

    const row = await users.findByClerkUserId('user_1');
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.email).toBe(tombstoneEmail(user.id));
  });
});

describe('applyEvent', () => {
  it('applies an upsert and reports it applied', async () => {
    const applied = await service.mirror.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice@example.com',
    });

    expect(applied).toBe(true);
    expect(users.all()).toHaveLength(1);
  });

  it('ignores a redelivery of the same event', async () => {
    // Providers retry on timeouts they caused. A duplicate is a normal event,
    // and the second delivery must not change anything.
    const event = {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice@example.com',
    } as const;

    expect(await service.mirror.applyEvent('msg_1', event)).toBe(true);
    expect(await service.mirror.applyEvent('msg_1', event)).toBe(false);
    expect(users.all()).toHaveLength(1);
  });

  it('does not let a redelivery undo a later change', async () => {
    // The failure this prevents: create arrives, update arrives, then the
    // create is retried and reverts the address. Idempotency is keyed on the
    // delivery, so the retry is dropped rather than re-applied.
    await service.mirror.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice@example.com',
    });
    await service.mirror.applyEvent('msg_2', {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice.new@example.com',
    });
    await service.mirror.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice@example.com',
    });

    expect((await users.findByClerkUserId('user_1'))?.email).toBe(
      'alice.new@example.com',
    );
  });

  it('updates the address of an existing mirror row', async () => {
    await service.mirror.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice@example.com',
    });
    await service.mirror.applyEvent('msg_2', {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice.new@example.com',
    });

    expect(users.all()).toHaveLength(1);
    expect((await users.findByClerkUserId('user_1'))?.email).toBe(
      'alice.new@example.com',
    );
  });

  it('marks the delivery processed once applied', async () => {
    await service.mirror.applyEvent('msg_1', {
      type: 'user.deleted',
      clerkUserId: 'user_1',
    });

    // A row claimed but never marked is a delivery we accepted and failed to
    // apply — the state worth alerting on once there is somewhere to alert.
    expect(ledger.unprocessed()).toEqual([]);
  });

  describe('deletion', () => {
    it('soft-deletes and tombstones the address', async () => {
      const user = await service.mirror.resolveSession(SESSION);

      await service.mirror.applyEvent('msg_1', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });

      const row = await users.findByClerkUserId('user_1');
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(row?.email).toBe(tombstoneEmail(user.id));
    });

    it('keeps the row, because the ledger will reference it', async () => {
      await service.mirror.resolveSession(SESSION);
      await service.mirror.applyEvent('msg_1', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });

      // Hard deletion is not available to us: from Phase 2 listings, bookings
      // and immutable ledger entries point here, and the ledger can never lose
      // its counterparty.
      expect(users.all()).toHaveLength(1);
    });

    it('frees the real address for genuine re-registration', async () => {
      await service.mirror.resolveSession(SESSION);
      await service.mirror.applyEvent('msg_1', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });

      // A retained unique row would lock that person out of the platform
      // permanently. This is the case the tombstone exists for.
      const returning = await service.mirror.resolveSession({
        clerkUserId: 'user_2',
        sessionId: 'sess_2',
        email: 'alice@example.com',
        secondFactorAgeMinutes: null,
      });

      expect(returning.email).toBe('alice@example.com');
      expect(users.all()).toHaveLength(2);
    });

    it('treats deleting an unknown account as a success', async () => {
      // The mirror already reflects the requested state, which is all a
      // retrying caller cares about.
      await expect(
        service.mirror.applyEvent('msg_1', {
          type: 'user.deleted',
          clerkUserId: 'ghost',
        }),
      ).resolves.toBe(true);
    });

    it('treats a second deletion as a success without re-tombstoning', async () => {
      const user = await service.mirror.resolveSession(SESSION);
      await service.mirror.applyEvent('msg_1', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });
      const first = await users.findByClerkUserId('user_1');

      await service.mirror.applyEvent('msg_2', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });
      const second = await users.findByClerkUserId('user_1');

      expect(second?.deletedAt).toEqual(first?.deletedAt);
      expect(second?.email).toBe(tombstoneEmail(user.id));
    });

    it('does not let a late update revive a deleted account', async () => {
      // Webhooks are not ordered. A user.updated queued before the delete can
      // arrive after it, and applying the address would undo the erasure.
      const user = await service.mirror.resolveSession(SESSION);
      await service.mirror.applyEvent('msg_1', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });

      await service.mirror.applyEvent('msg_2', {
        type: 'user.upserted',
        clerkUserId: 'user_1',
        email: 'alice@example.com',
      });

      const row = await users.findByClerkUserId('user_1');
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.email).toBe(tombstoneEmail(user.id));
    });
  });
});

describe('tombstoneEmail', () => {
  it('uses a domain that can never be real', () => {
    // RFC 2606 reserves .invalid, so this can never collide with a genuine
    // address or accidentally receive mail.
    expect(tombstoneEmail('abc')).toMatch(/@deleted\.invalid$/);
  });

  it('is unique per user', () => {
    expect(tombstoneEmail('a')).not.toBe(tombstoneEmail('b'));
  });
});

describe('conflicting accounts', () => {
  it('refuses to attach one address to a second Clerk account', async () => {
    // Not an overwrite. Silently repointing the row would, from Phase 2, hand
    // one person another's listings, bookings and payouts.
    await service.mirror.resolveSession(SESSION);

    await expect(
      service.mirror.resolveSession({
        clerkUserId: 'user_2',
        sessionId: 'sess_2',
        email: 'alice@example.com',
        secondFactorAgeMinutes: null,
      }),
    ).rejects.toBeInstanceOf(UserConflictError);
  });

  it('treats a differently-cased address as the same one', async () => {
    // The column is citext, so this is the database's answer. The fake models
    // it so the rule is tested here rather than only in the integration suite.
    await service.mirror.resolveSession(SESSION);

    await expect(
      service.mirror.resolveSession({
        clerkUserId: 'user_2',
        sessionId: 'sess_2',
        email: 'ALICE@EXAMPLE.COM',
        secondFactorAgeMinutes: null,
      }),
    ).rejects.toBeInstanceOf(UserConflictError);
  });
});

describe('the audit trail', () => {
  it('records provisioning the first time a session is seen', async () => {
    const audit = createAuditFakes();
    const directory = new InMemoryUserDirectory();
    const identity = identityFor({ directory, audit: audit.service });

    const user = await identity.mirror.resolveSession(
      {
        clerkUserId: 'user_a',
        sessionId: 'sess_a',
        email: 'alice@example.com',
        secondFactorAgeMinutes: null,
      },
      '203.0.113.7',
    );

    expect(audit.log.entries()).toHaveLength(1);
    expect(audit.log.entries()[0]).toMatchObject({
      actorId: user.id,
      action: 'account.provisioned',
      targetType: 'user',
      targetId: user.id,
      ipAddress: '203.0.113.7',
      beforeHash: null,
    });
  });

  it('records it once, however many times the session is seen again', async () => {
    // Provisioning is an event, not a state. A second entry on every request
    // would bury the one that mattered under thousands that did not.
    const audit = createAuditFakes();
    const identity = identityFor({ audit: audit.service });
    const session = {
      clerkUserId: 'user_a',
      sessionId: 'sess_a',
      email: 'a@example.com',
      secondFactorAgeMinutes: null,
    };

    await identity.mirror.resolveSession(session);
    await identity.mirror.resolveSession(session);
    await identity.mirror.resolveSession(session);

    expect(audit.log.entries()).toHaveLength(1);
  });

  it('records no email, only a digest of the account state', async () => {
    const audit = createAuditFakes();
    const identity = identityFor({ audit: audit.service });

    await identity.mirror.resolveSession({
      clerkUserId: 'user_a',
      sessionId: 'sess_a',
      email: 'alice@example.com',
      secondFactorAgeMinutes: null,
    });

    expect(JSON.stringify(audit.log.entries())).not.toContain('alice@example.com');
  });

  it('attributes a webhook-provisioned account to nobody', async () => {
    // No session was held, so there is no actor and no address. Recording the
    // account as its own actor would invent a sign-in that never happened.
    const audit = createAuditFakes();
    const identity = identityFor({ audit: audit.service });

    await identity.mirror.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_a',
      email: 'alice@example.com',
    });

    expect(audit.log.entries()[0]).toMatchObject({
      actorId: null,
      ipAddress: null,
      action: 'account.provisioned',
    });
  });

  it('records nothing when a webhook merely updates an existing account', async () => {
    const audit = createAuditFakes();
    const identity = identityFor({ audit: audit.service });
    const event = {
      type: 'user.upserted',
      clerkUserId: 'user_a',
      email: 'alice@example.com',
    } as const;

    await identity.mirror.applyEvent('msg_1', event);
    await identity.mirror.applyEvent('msg_2', { ...event, email: 'new@example.com' });

    expect(
      audit.log.entries().filter((e) => e.action === 'account.provisioned'),
    ).toHaveLength(1);
  });
});

describe('requestDeletion', () => {
  const ACTOR = (id: string) => ({
    userId: id,
    ipAddress: '203.0.113.7',
    sessionId: 'sess_3HDhyL6953Z755UaiBQzqU9maQA',
  });

  async function provision() {
    const audit = createAuditFakes();
    const eraser = new RecordingEraser();
    const directory = new InMemoryUserDirectory();
    const identity = identityFor({ directory, audit: audit.service, eraser: eraser });

    const user = await identity.mirror.resolveSession({
      clerkUserId: 'user_a',
      sessionId: 'sess_a',
      email: 'alice@example.com',
      secondFactorAgeMinutes: null,
    });

    return { id: user.id, audit, eraser, directory, identity };
  }

  it('erases the personal data other modules hold', async () => {
    const { id, eraser, identity } = await provision();
    await identity.accountData.requestDeletion(ACTOR(id));

    expect(eraser.erased).toEqual([id]);
  });

  it('tombstones the address and marks the account deleted', async () => {
    const { id, directory, identity } = await provision();
    await identity.accountData.requestDeletion(ACTOR(id));

    const user = await directory.findById(id);
    expect(user?.deletedAt).toBeInstanceOf(Date);
    expect(user?.deletionRequestedAt).toBeInstanceOf(Date);
    // `.invalid` is reserved by RFC 2606, so it can never collide with a real
    // address — and replacing it frees the real one for re-registration, which
    // a retained unique row would block forever.
    expect(user?.email).toBe(`deleted+${id}@deleted.invalid`);
  });

  it('erases before it tombstones', async () => {
    // The ordering decision (ADR 0018). Tombstoning first would leave somebody
    // locked out of an account that still holds their address, with no way to
    // ask again. This proves a failed erasure leaves the account usable.
    const { id, directory, identity, eraser } = await provision();
    eraser.failNextErase(new Error('storage unavailable'));

    await expect(identity.accountData.requestDeletion(ACTOR(id))).rejects.toThrow(
      /storage unavailable/,
    );

    const user = await directory.findById(id);
    expect(user?.deletedAt).toBeNull();
    expect(user?.email).toBe('alice@example.com');
  });

  it('is idempotent — a second request succeeds and changes nothing', async () => {
    const { id, identity, directory, eraser } = await provision();
    await identity.accountData.requestDeletion(ACTOR(id));
    const first = await directory.findById(id);

    await expect(
      identity.accountData.requestDeletion(ACTOR(id)),
    ).resolves.toBeUndefined();

    expect(await directory.findById(id)).toMatchObject({
      deletedAt: first?.deletedAt,
      email: first?.email,
    });
    // Erased once. A repeat must not re-run erasure it has already done.
    expect(eraser.erased).toEqual([id]);
  });

  it('succeeds for an account that never existed', async () => {
    // A retry after a dropped connection must be able to finish rather than be
    // told it is too late.
    const { identity } = await provision();
    await expect(
      identity.accountData.requestDeletion(
        ACTOR('00000000-0000-4000-8000-00000000dead'),
      ),
    ).resolves.toBeUndefined();
  });

  it('writes an audit entry that survives the erasure it describes', async () => {
    const { id, audit, identity } = await provision();
    await identity.accountData.requestDeletion(ACTOR(id));

    const entry = audit.log
      .entries()
      .find((e) => e.action === 'account.deletion_requested');
    expect(entry).toMatchObject({
      actorId: id,
      targetType: 'user',
      targetId: id,
      ipAddress: '203.0.113.7',
    });
    // Before and after differ: the email was replaced.
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('keeps no personal data in the audit trail', async () => {
    // The reason the entry can be retained six years while the account's data
    // is erased: it holds digests, not values (ADR 0017).
    const { id, audit, identity } = await provision();
    await identity.accountData.requestDeletion(ACTOR(id));

    expect(JSON.stringify(audit.log.entries())).not.toContain('alice@example.com');
  });

  it('records nothing extra on a repeat request', async () => {
    const { id, audit, identity } = await provision();
    await identity.accountData.requestDeletion(ACTOR(id));
    await identity.accountData.requestDeletion(ACTOR(id));

    expect(
      audit.log.entries().filter((e) => e.action === 'account.deletion_requested'),
    ).toHaveLength(1);
  });

  it('leaves a deleted account unable to resolve a session', async () => {
    // The end-to-end consequence: the guard refuses it, so the credential still
    // existing at Clerk does not let anybody back in.
    const { id, identity } = await provision();
    await identity.accountData.requestDeletion(ACTOR(id));

    await expect(
      identity.mirror.resolveSession({
        clerkUserId: 'user_a',
        sessionId: 'sess_a',
        email: 'alice@example.com',
        secondFactorAgeMinutes: null,
      }),
    ).rejects.toThrow(AccountDeletedError);
  });
});

describe('exportFor', () => {
  const ACTOR = (id: string) => ({
    userId: id,
    ipAddress: '203.0.113.7',
    sessionId: 'sess_3HDhyL6953Z755UaiBQzqU9maQA',
  });

  async function provision() {
    const audit = createAuditFakes();
    const source = new StubDataSource();
    const directory = new InMemoryUserDirectory();
    const identity = identityFor({ directory, audit: audit.service, source: source });

    const user = await identity.mirror.resolveSession({
      clerkUserId: 'user_a',
      sessionId: 'sess_a',
      email: 'alice@example.com',
      secondFactorAgeMinutes: null,
    });

    return { id: user.id, audit, source, directory, identity };
  }

  it('includes the account', async () => {
    const { id, identity } = await provision();
    const document = await identity.accountData.exportFor(ACTOR(id));

    expect(document?.account).toMatchObject({
      id,
      email: 'alice@example.com',
      role: 'USER',
      deletedAt: null,
      deletionRequestedAt: null,
    });
  });

  it('carries a schema version and an export timestamp', async () => {
    // A person may keep this file for years. Without a version, an old export
    // is indistinguishable from a malformed one.
    const { id, identity } = await provision();
    const document = await identity.accountData.exportFor(ACTOR(id));

    // Literal rather than the constant: importing EXPORT_SCHEMA_VERSION here
    // would make this assert that a number equals itself, and pass through any
    // bump. Version 2 added `signIns` in slice 1.11a; version 3 added
    // `listings` in 2.5a — and this line failing is how that bump announced
    // itself, which is the whole reason it is a literal.
    expect(document?.schemaVersion).toBe(4);
    expect(document?.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes the profile section a module contributed, decrypted', async () => {
    const { id, source, identity } = await provision();
    source.returns({
      displayName: 'Sarah M.',
      phone: '+447700900123',
      address: {
        line1: '12 Acacia Avenue',
        line2: null,
        town: 'Bristol',
        postcode: 'BS7 8AA',
      },
      updatedAt: '2026-07-31T09:00:00.000Z',
    });

    const document = await identity.accountData.exportFor(ACTOR(id));

    // The one place plaintext street lines leave the database (ADR 0019).
    expect(document?.profile?.address?.line1).toBe('12 Acacia Avenue');
    expect(document?.profile?.phone).toBe('+447700900123');
  });

  it('reports no profile as null rather than as an empty one', async () => {
    // Different facts, and worth the distinction in a file read years later.
    const { id, identity } = await provision();
    await expect(identity.accountData.exportFor(ACTOR(id))).resolves.toMatchObject({
      profile: null,
    });
  });

  it('includes the person’s own activity', async () => {
    const { id, identity } = await provision();
    const document = await identity.accountData.exportFor(ACTOR(id));

    // Provisioning happened when the session first resolved.
    expect(document?.activity.map((entry) => entry.action)).toContain(
      'account.provisioned',
    );
  });

  it('leaves the digests out of the activity', async () => {
    // Keyed with a secret the reader does not have, so meaningless to them.
    // Article 15 is about the personal data we hold, not our integrity checks.
    const { id, identity } = await provision();
    const document = await identity.accountData.exportFor(ACTOR(id));

    for (const entry of document?.activity ?? []) {
      expect(entry).not.toHaveProperty('beforeHash');
      expect(entry).not.toHaveProperty('afterHash');
    }
  });

  it('records the export itself', async () => {
    // The one bulk disclosure the platform performs. An access log with a hole
    // exactly where the sensitive operation is would be worse than none.
    const { id, audit, identity } = await provision();
    await identity.accountData.exportFor(ACTOR(id));

    expect(audit.log.entries().at(-1)).toMatchObject({
      actorId: id,
      action: 'account.exported',
      targetType: 'user',
      targetId: id,
      ipAddress: '203.0.113.7',
    });
  });

  it('records the export as a disclosure, not as a change', async () => {
    // No before and no after: nothing was mutated. Inventing a state
    // transition would make disclosures and changes indistinguishable.
    const { id, audit, identity } = await provision();
    await identity.accountData.exportFor(ACTOR(id));

    expect(audit.log.entries().at(-1)).toMatchObject({
      beforeHash: null,
      afterHash: null,
    });
  });

  it('does not describe its own creation', async () => {
    // The entry is recorded before the document is built, so it appears in the
    // *next* export. A file describing its own creation reads as a bug to
    // anyone comparing two of them.
    const { id, identity } = await provision();
    const first = await identity.accountData.exportFor(ACTOR(id));

    expect(first?.activity.map((entry) => entry.action)).not.toContain(
      'account.exported',
    );

    const second = await identity.accountData.exportFor(ACTOR(id));
    expect(second?.activity.map((entry) => entry.action)).toContain('account.exported');
  });

  it('is null for an account that does not exist', async () => {
    const { identity } = await provision();
    await expect(
      identity.accountData.exportFor(ACTOR('00000000-0000-4000-8000-00000000dead')),
    ).resolves.toBeNull();
  });

  it('shows a deleted account as deleted rather than hiding it', async () => {
    // Somebody exporting after a deletion request should see that it happened,
    // and when they asked. Both timestamps are personal data about them.
    const { id, identity } = await provision();
    await identity.accountData.requestDeletion(ACTOR(id));

    const document = await identity.accountData.exportFor(ACTOR(id));
    expect(document?.account.deletedAt).not.toBeNull();
    expect(document?.account.deletionRequestedAt).not.toBeNull();
  });
});

describe('correcting the email', () => {
  const SESSION = (email: string) => ({
    clerkUserId: 'user_a',
    sessionId: 'sess_a',
    email,
    secondFactorAgeMinutes: null,
  });

  async function provision(email = 'old@example.com') {
    const audit = createAuditFakes();
    const directory = new InMemoryUserDirectory();
    const identity = identityFor({ directory, audit: audit.service });

    const user = await identity.mirror.resolveSession(SESSION(email));
    return { id: user.id, audit, directory, identity };
  }

  it('corrects the mirror on the next authenticated request', async () => {
    // The just-in-time path. A missed or delayed `user.updated` converges here
    // rather than waiting for a redelivery that may never come.
    const { identity } = await provision();

    const user = await identity.mirror.resolveSession(SESSION('new@example.com'));

    expect(user.email).toBe('new@example.com');
  });

  it('records the correction, with the address it came from', async () => {
    // Ordinary-looking and security-relevant: changing the address is how an
    // account takeover is made permanent.
    const { id, audit, identity } = await provision();
    await identity.mirror.resolveSession(SESSION('new@example.com'));

    const entry = audit.log.entries().find((e) => e.action === 'account.email_changed');
    expect(entry).toMatchObject({ actorId: id, targetType: 'user', targetId: id });
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('records neither address in the trail', async () => {
    const { audit, identity } = await provision();
    await identity.mirror.resolveSession(SESSION('new@example.com'));

    const serialised = JSON.stringify(audit.log.entries());
    expect(serialised).not.toContain('old@example.com');
    expect(serialised).not.toContain('new@example.com');
  });

  it('records nothing when the address has not changed', async () => {
    // Every authenticated request passes through this path. An entry per
    // request would bury the corrections that matter under thousands that
    // changed nothing.
    const { audit, identity } = await provision();
    await identity.mirror.resolveSession(SESSION('old@example.com'));
    await identity.mirror.resolveSession(SESSION('old@example.com'));

    expect(
      audit.log.entries().filter((e) => e.action === 'account.email_changed'),
    ).toHaveLength(0);
  });

  it('records a correction that arrives on a webhook, with no actor', async () => {
    // Nobody was holding a session, so there is no address to attribute it to.
    const { audit, identity } = await provision();

    await identity.mirror.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_a',
      email: 'new@example.com',
    });

    const entry = audit.log.entries().find((e) => e.action === 'account.email_changed');
    expect(entry).toMatchObject({ actorId: null, ipAddress: null });
  });

  it('uses one correction path, so the webhook and the session agree', async () => {
    // Both routes reach the same method. If they diverged, one of them would
    // eventually gain a rule the other lacked — most likely the audit entry.
    const viaSession = await provision();
    await viaSession.identity.mirror.resolveSession(SESSION('new@example.com'));

    const viaWebhook = await provision();
    await viaWebhook.identity.mirror.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_a',
      email: 'new@example.com',
    });

    const actions = (fakes: typeof viaSession) =>
      fakes.audit.log.entries().map((entry) => entry.action);

    expect(actions(viaSession)).toEqual(actions(viaWebhook));
  });

  it('survives a collision rather than failing the request', async () => {
    // `users.email` is unique, so a correction can lose to a stale row —
    // somebody else has since taken at the provider an address our mirror still
    // holds. Throwing would 500 an ordinary page load over a race that resolves
    // itself when the other account's next request corrects its own row.
    const audit = createAuditFakes();
    const directory = new InMemoryUserDirectory();
    const identity = identityFor({ directory, audit: audit.service });

    await identity.mirror.resolveSession({
      clerkUserId: 'user_b',
      sessionId: 'sess_b',
      email: 'taken@example.com',
      secondFactorAgeMinutes: null,
    });
    const mine = await identity.mirror.resolveSession(SESSION('old@example.com'));

    const after = await identity.mirror.resolveSession(SESSION('taken@example.com'));

    // The request succeeded, and the mirror is knowingly stale.
    expect(after.id).toBe(mine.id);
    expect(after.email).toBe('old@example.com');
  });

  it('records nothing when a collision stopped the correction', async () => {
    // The trail must not claim a change that did not happen.
    const audit = createAuditFakes();
    const directory = new InMemoryUserDirectory();
    const identity = identityFor({ directory, audit: audit.service });

    await identity.mirror.resolveSession({
      clerkUserId: 'user_b',
      sessionId: 'sess_b',
      email: 'taken@example.com',
      secondFactorAgeMinutes: null,
    });
    await identity.mirror.resolveSession(SESSION('old@example.com'));
    await identity.mirror.resolveSession(SESSION('taken@example.com'));

    expect(
      audit.log.entries().filter((e) => e.action === 'account.email_changed'),
    ).toHaveLength(0);
  });

  it('shows the correction in the person’s own activity', async () => {
    const { id, identity } = await provision();
    await identity.mirror.resolveSession(SESSION('new@example.com'));

    const document = await identity.accountData.exportFor({
      userId: id,
      ipAddress: null,
      sessionId: null,
    });
    expect(document?.activity.map((entry) => entry.action)).toContain(
      'account.email_changed',
    );
  });

  it('does not correct a deleted account', async () => {
    // A tombstoned address must not be overwritten by a provider event; that
    // would undo the erasure.
    const { id, directory, identity } = await provision();
    await identity.accountData.requestDeletion({
      userId: id,
      ipAddress: null,
      sessionId: null,
    });

    await identity.mirror.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_a',
      email: 'resurrect@example.com',
    });

    expect((await directory.findById(id))?.email).toBe(`deleted+${id}@deleted.invalid`);
  });
});

describe('authentication events', () => {
  const SESSION = {
    id: 'sess_1',
    user_id: 'user_a',
    created_at: 1785408799422,
    updated_at: 1785495199422,
  };

  /** Beside `data` in Clerk's envelope, not inside it — see ADR 0025. */
  const ATTRIBUTES = {
    http_request: {
      client_ip: '2.49.99.113',
      user_agent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
    },
  };

  async function withAccount() {
    const events = new InMemoryAuthenticationEvents();
    const logger = createRecordingLogger();
    const directory = new InMemoryUserDirectory();
    const audit = createAuditFakes();
    const identity = identityFor({
      directory,
      audit: audit.service,
      events: events,
      logger: logger.logger,
    });

    const user = await identity.mirror.resolveSession({
      clerkUserId: 'user_a',
      sessionId: 'sess_a',
      email: 'alice@example.com',
      secondFactorAgeMinutes: null,
    });

    return { id: user.id, identity, events, logger, directory };
  }

  function delivery(type: string, data: Record<string, unknown>) {
    const mapped = mapClerkEvent(type, data, ATTRIBUTES);
    if (mapped === null) throw new Error(`expected ${type} to map`);
    return mapped;
  }

  it('records a sign-in against the account it belongs to', async () => {
    const { id, identity, events } = await withAccount();

    await identity.mirror.applyEvent('msg_1', delivery('session.created', SESSION));

    expect(events.all()).toEqual([
      expect.objectContaining({
        userId: id,
        clerkSessionId: 'sess_1',
        event: 'started',
        activity: expect.objectContaining({ deviceType: 'Windows', isMobile: false }),
      }),
    ]);
  });

  it('drops a session event for an account we do not mirror, and says so', async () => {
    // Clerk delivers user.created and session.created independently and neither
    // is ordered against the other, so this race is real. Throwing would be
    // worse than dropping: the delivery is already claimed in the ledger, so the
    // retry is refused as a duplicate and the event is lost anyway — while
    // leaving an unprocessed ledger row nothing is watching.
    const { identity, events, logger } = await withAccount();

    await identity.mirror.applyEvent(
      'msg_1',
      delivery('session.created', { ...SESSION, user_id: 'user_nobody' }),
    );

    expect(events.all()).toEqual([]);
    expect(logger.at('warn')).toEqual([
      expect.objectContaining({
        message: 'dropped a session event for an unmirrored account',
        fields: expect.objectContaining({ clerkUserId: 'user_nobody' }),
      }),
    ]);
  });

  it('is idempotent across two delivery ids for one logical event', async () => {
    // The webhook_events ledger refuses a redelivered *delivery*; it cannot see
    // the same event arriving under a new id, which a provider replay produces.
    const { identity, events } = await withAccount();

    await identity.mirror.applyEvent('msg_1', delivery('session.created', SESSION));
    await identity.mirror.applyEvent('msg_2', delivery('session.created', SESSION));

    expect(events.all()).toHaveLength(1);
  });

  it('keeps both a sign-in and a sign-out for one session', async () => {
    const { identity, events } = await withAccount();

    await identity.mirror.applyEvent('msg_1', delivery('session.created', SESSION));
    await identity.mirror.applyEvent('msg_2', delivery('session.ended', SESSION));

    expect(
      events
        .all()
        .map((row) => row.event)
        .sort(),
    ).toEqual(['ended', 'started']);
  });

  it('records against a deleted account rather than skipping it', async () => {
    // A sign-in to an account somebody asked us to delete is exactly what a
    // security enquiry wants to see, and the row holds no personal data once
    // erasure has nulled the activity columns.
    const { id, identity, events } = await withAccount();
    await identity.accountData.requestDeletion({
      userId: id,
      ipAddress: null,
      sessionId: null,
    });

    await identity.mirror.applyEvent('msg_1', delivery('session.created', SESSION));

    expect(events.all()).toHaveLength(1);
  });

  it('serves the account holder their own sign-ins, newest first', async () => {
    const { id, identity } = await withAccount();

    await identity.mirror.applyEvent('msg_1', delivery('session.created', SESSION));
    await identity.mirror.applyEvent('msg_2', delivery('session.ended', SESSION));

    const entries = await identity.accountData.signInsFor(id);

    expect(entries.map((entry) => entry.event)).toEqual(['ended', 'started']);
  });

  describe('erasure', () => {
    it('redacts the device and place but keeps the row', async () => {
      // §10.1 retains security logs six years. "A session started at 14:02" is
      // the part that can honestly be retained once "from Edge on Windows" is
      // gone — and keeping the row is also what stops the ON DELETE RESTRICT
      // foreign key turning an erasure into a failure.
      const { id, identity, events } = await withAccount();
      await identity.mirror.applyEvent('msg_1', delivery('session.created', SESSION));

      await identity.accountData.requestDeletion({
        userId: id,
        ipAddress: null,
        sessionId: null,
      });

      expect(events.all()).toEqual([
        expect.objectContaining({
          clerkSessionId: 'sess_1',
          event: 'started',
          activity: {
            ipAddress: null,
            browserName: null,
            browserVersion: null,
            deviceType: null,
            isMobile: null,
          },
        }),
      ]);
    });

    it('can fail: without erasure the device would survive a deletion', async () => {
      // The mirror of the test above. If `eraseActivity` were ever dropped from
      // requestDeletion, the assertion above is the only thing that notices —
      // so this pins that the data really was there to erase, rather than the
      // test passing because nothing was ever recorded.
      const { id, identity, events } = await withAccount();
      await identity.mirror.applyEvent('msg_1', delivery('session.created', SESSION));

      expect(events.all()[0]?.activity.deviceType).toBe('Windows');

      await identity.accountData.requestDeletion({
        userId: id,
        ipAddress: null,
        sessionId: null,
      });
      expect(events.all()[0]?.activity.deviceType).toBeNull();
    });
  });
});

describe('deletion erases whichever path starts it', () => {
  /**
   * Slice 1.5c. Two paths can begin a deletion — our own `/account/delete`
   * route, and Clerk's `user.deleted` webhook when somebody deletes from
   * Clerk's own account screen, which has been mounted at `/account/email`
   * since slice 1.7. Until this slice the webhook path tombstoned the email and
   * stopped: no erasure, no redaction, no `deletionRequestedAt`, no audit
   * entry. A person was told their data was gone while all of it survived.
   */
  const SESSION_EVENT = {
    id: 'sess_1',
    user_id: 'user_a',
    created_at: 1785661283293,
    updated_at: 1785661283331,
  };
  const ATTRIBUTES = {
    http_request: {
      client_ip: '2.49.99.113',
      user_agent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
    },
  };

  /** An account with a profile, an address and a recorded sign-in. */
  async function populated() {
    const events = new InMemoryAuthenticationEvents();
    const directory = new InMemoryUserDirectory();
    const eraser = new RecordingEraser();
    const audit = createAuditFakes();
    const identity = identityFor({
      directory,
      audit: audit.service,
      eraser: eraser,
      events: events,
    });

    const user = await identity.mirror.resolveSession({
      clerkUserId: 'user_a',
      sessionId: 'sess_a',
      email: 'alice@example.com',
      secondFactorAgeMinutes: null,
    });

    const mapped = mapClerkEvent('session.created', SESSION_EVENT, ATTRIBUTES);
    if (mapped === null) throw new Error('expected the session event to map');
    await identity.mirror.applyEvent('msg_session', mapped);

    return { id: user.id, identity, events, eraser, audit, directory };
  }

  /**
   * Everything a completed deletion must be true of, in one place.
   *
   * **This is the test that stops the two paths drifting apart again.** Both
   * call it, so a step added to one and not the other fails here rather than
   * being discovered by a person who trusted us to delete their data.
   */
  async function assertFullyDeleted(
    context: Awaited<ReturnType<typeof populated>>,
  ): Promise<void> {
    const { id, events, eraser, audit, directory } = context;

    // The other modules' personal data was asked for by name.
    expect(eraser.erased).toEqual([id]);

    // Our own: the rows survive as the retainable security log, stripped.
    expect(events.all()).toHaveLength(1);
    expect(events.all()[0]?.activity).toEqual({
      ipAddress: null,
      browserName: null,
      browserVersion: null,
      deviceType: null,
      isMobile: null,
    });

    const row = await directory.findById(id);
    expect(row?.deletedAt).toBeInstanceOf(Date);
    // Answers "when did they ask", which is what an enquiry puts.
    expect(row?.deletionRequestedAt).toBeInstanceOf(Date);
    expect(row?.email).toBe(tombstoneEmail(id));

    // Recorded, with differing digests, and holding no address either side.
    const entry = audit.log
      .entries()
      .find((candidate) => candidate.action === 'account.deletion_requested');
    expect(entry).toBeDefined();
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
    expect(JSON.stringify(audit.log.entries())).not.toContain('alice@example.com');
  }

  it('erases when the person uses our own route', async () => {
    const context = await populated();
    await context.identity.accountData.requestDeletion({
      userId: context.id,
      ipAddress: '203.0.113.7',
      sessionId: 'sess_3HDhyL6953Z755UaiBQzqU9maQA',
    });

    await assertFullyDeleted(context);
  });

  it('erases when the deletion arrives as a webhook from Clerk', async () => {
    // The path that did nothing. Clerk's own account screen deletes the user
    // directly, so this is the delivery that arrives with no prior request of
    // ours — and it must do the identical work.
    const context = await populated();
    await context.identity.mirror.applyEvent('msg_deleted', {
      type: 'user.deleted',
      clerkUserId: 'user_a',
    });

    await assertFullyDeleted(context);
  });

  it('can fail: without the shared call the webhook path erases nothing', async () => {
    // Guards the assertion above against passing for the wrong reason. The
    // profile and the sign-in activity are demonstrably present *before* the
    // webhook lands, so an empty erasure afterwards would be a real change
    // rather than an empty fixture.
    const context = await populated();

    expect(context.eraser.erased).toEqual([]);
    expect(context.events.all()[0]?.activity.deviceType).toBe('Windows');

    await context.identity.mirror.applyEvent('msg_deleted', {
      type: 'user.deleted',
      clerkUserId: 'user_a',
    });

    expect(context.eraser.erased).toEqual([context.id]);
    expect(context.events.all()[0]?.activity.deviceType).toBeNull();
  });

  it('does not erase twice when our route runs and the webhook follows', async () => {
    // The ordinary sequence: we erase, the web app deletes the credential,
    // Clerk's webhook arrives afterwards. The second pass must be a no-op, or
    // the trail gains a second deletion nobody performed.
    const context = await populated();
    await context.identity.accountData.requestDeletion({
      userId: context.id,
      ipAddress: null,
      sessionId: null,
    });
    await context.identity.mirror.applyEvent('msg_deleted', {
      type: 'user.deleted',
      clerkUserId: 'user_a',
    });

    expect(context.eraser.erased).toEqual([context.id]);
    expect(
      context.audit.log
        .entries()
        .filter((entry) => entry.action === 'account.deletion_requested'),
    ).toHaveLength(1);
  });

  it('records the account as its own actor when Clerk starts it', async () => {
    // They did ask — just not here. Recording no actor would say the system
    // deleted somebody on nobody's behalf, which is a different and wronger
    // claim. The address is null because we never saw the client.
    const context = await populated();
    await context.identity.mirror.applyEvent('msg_deleted', {
      type: 'user.deleted',
      clerkUserId: 'user_a',
    });

    const entry = context.audit.log
      .entries()
      .find((candidate) => candidate.action === 'account.deletion_requested');

    expect(entry?.actorId).toBe(context.id);
    expect(entry?.ipAddress).toBeNull();
  });

  it('is a success for an account we never mirrored', async () => {
    const context = await populated();
    await expect(
      context.identity.mirror.applyEvent('msg_unknown', {
        type: 'user.deleted',
        clerkUserId: 'user_nobody',
      }),
    ).resolves.toBe(true);
  });
});

/**
 * The identity services a test needs, built over one set of doubles.
 *
 * **Slice H4 split `IdentityService` four ways**, and this keeps these tests
 * reading as they did: a block that deliberately names an audit fake, an eraser
 * or an export source still names only that. What it stops naming is the five
 * collaborators it never cared about — they were only ever there because one
 * class held four responsibilities.
 *
 * Every service is built over the **same** directory and the same erasure, which
 * is not a convenience: the mirror and the subject-rights service must agree
 * about a row, and separate instances would let a test pass while the two
 * deletion paths did different things (slice 1.5c is why that matters).
 */
function identityFor(
  options: {
    directory?: InMemoryUserDirectory;
    ledger?: InMemoryWebhookLedger;
    audit?: AuditService;
    eraser?: PersonalDataEraser;
    source?: StubDataSource;
    events?: InMemoryAuthenticationEvents;
    logger?: Logger;
  } = {},
) {
  const directory = options.directory ?? new InMemoryUserDirectory();
  const audit = options.audit ?? createAuditFakes().service;
  const events = options.events ?? new InMemoryAuthenticationEvents();
  const erasure = new AccountErasure(
    directory,
    audit,
    options.eraser ?? new RecordingEraser(),
    events,
  );

  return {
    mirror: new IdentityService(
      directory,
      options.ledger ?? new InMemoryWebhookLedger(),
      audit,
      events,
      erasure,
      options.logger ?? createRecordingLogger().logger,
    ),
    accountData: new AccountDataService(
      directory,
      audit,
      options.source ?? new StubDataSource(),
      new StubListingDataSource(),
      events,
      erasure,
    ),
  };
}
