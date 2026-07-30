import { beforeEach, describe, expect, it } from 'vitest';
import {
  AccountDeletedError,
  IdentityService,
  tombstoneEmail,
} from './identity.service.js';
import type { VerifiedSession } from './session-verifier.js';
import { InMemoryUserDirectory, InMemoryWebhookLedger } from './testing/fakes.js';
import { UserConflictError } from './user-directory.js';

const SESSION: VerifiedSession = {
  clerkUserId: 'user_1',
  sessionId: 'sess_1',
  email: 'alice@example.com',
};

let users: InMemoryUserDirectory;
let ledger: InMemoryWebhookLedger;
let service: IdentityService;

beforeEach(() => {
  users = new InMemoryUserDirectory();
  ledger = new InMemoryWebhookLedger();
  service = new IdentityService(users, ledger);
});

describe('resolveSession', () => {
  it('creates the mirror row on first sight', async () => {
    // Clerk delivers user.created asynchronously. Without provisioning here,
    // someone who signs up and is redirected straight in meets an error until
    // the webhook lands — a race they would hit on their very first request.
    const user = await service.resolveSession(SESSION);

    expect(user).toMatchObject({
      clerkUserId: 'user_1',
      email: 'alice@example.com',
      role: 'USER',
      deletedAt: null,
    });
  });

  it('returns the same row on subsequent requests', async () => {
    const first = await service.resolveSession(SESSION);
    const second = await service.resolveSession(SESSION);

    expect(second.id).toBe(first.id);
    expect(users.all()).toHaveLength(1);
  });

  it('defaults a new account to the least privilege', async () => {
    expect((await service.resolveSession(SESSION)).role).toBe('USER');
  });

  it('converges a stale email without waiting for a webhook', async () => {
    await service.resolveSession(SESSION);

    // The token is Clerk-signed and therefore current. A mirror that disagrees
    // means user.updated was missed or is still in flight, and a redelivery may
    // never come.
    const updated = await service.resolveSession({
      ...SESSION,
      email: 'alice.new@example.com',
    });

    expect(updated.email).toBe('alice.new@example.com');
    expect(users.all()).toHaveLength(1);
  });

  it('refuses a session belonging to a deleted account', async () => {
    await service.resolveSession(SESSION);
    await service.applyEvent('msg_1', { type: 'user.deleted', clerkUserId: 'user_1' });

    await expect(service.resolveSession(SESSION)).rejects.toBeInstanceOf(
      AccountDeletedError,
    );
  });

  it('does not resurrect a deleted account by signing in', async () => {
    const user = await service.resolveSession(SESSION);
    await service.applyEvent('msg_1', { type: 'user.deleted', clerkUserId: 'user_1' });

    await service.resolveSession(SESSION).catch(() => undefined);

    const row = await users.findByClerkUserId('user_1');
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.email).toBe(tombstoneEmail(user.id));
  });
});

describe('applyEvent', () => {
  it('applies an upsert and reports it applied', async () => {
    const applied = await service.applyEvent('msg_1', {
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

    expect(await service.applyEvent('msg_1', event)).toBe(true);
    expect(await service.applyEvent('msg_1', event)).toBe(false);
    expect(users.all()).toHaveLength(1);
  });

  it('does not let a redelivery undo a later change', async () => {
    // The failure this prevents: create arrives, update arrives, then the
    // create is retried and reverts the address. Idempotency is keyed on the
    // delivery, so the retry is dropped rather than re-applied.
    await service.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice@example.com',
    });
    await service.applyEvent('msg_2', {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice.new@example.com',
    });
    await service.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice@example.com',
    });

    expect((await users.findByClerkUserId('user_1'))?.email).toBe(
      'alice.new@example.com',
    );
  });

  it('updates the address of an existing mirror row', async () => {
    await service.applyEvent('msg_1', {
      type: 'user.upserted',
      clerkUserId: 'user_1',
      email: 'alice@example.com',
    });
    await service.applyEvent('msg_2', {
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
    await service.applyEvent('msg_1', { type: 'user.deleted', clerkUserId: 'user_1' });

    // A row claimed but never marked is a delivery we accepted and failed to
    // apply — the state worth alerting on once there is somewhere to alert.
    expect(ledger.unprocessed()).toEqual([]);
  });

  describe('deletion', () => {
    it('soft-deletes and tombstones the address', async () => {
      const user = await service.resolveSession(SESSION);

      await service.applyEvent('msg_1', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });

      const row = await users.findByClerkUserId('user_1');
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(row?.email).toBe(tombstoneEmail(user.id));
    });

    it('keeps the row, because the ledger will reference it', async () => {
      await service.resolveSession(SESSION);
      await service.applyEvent('msg_1', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });

      // Hard deletion is not available to us: from Phase 2 listings, bookings
      // and immutable ledger entries point here, and the ledger can never lose
      // its counterparty.
      expect(users.all()).toHaveLength(1);
    });

    it('frees the real address for genuine re-registration', async () => {
      await service.resolveSession(SESSION);
      await service.applyEvent('msg_1', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });

      // A retained unique row would lock that person out of the platform
      // permanently. This is the case the tombstone exists for.
      const returning = await service.resolveSession({
        clerkUserId: 'user_2',
        sessionId: 'sess_2',
        email: 'alice@example.com',
      });

      expect(returning.email).toBe('alice@example.com');
      expect(users.all()).toHaveLength(2);
    });

    it('treats deleting an unknown account as a success', async () => {
      // The mirror already reflects the requested state, which is all a
      // retrying caller cares about.
      await expect(
        service.applyEvent('msg_1', { type: 'user.deleted', clerkUserId: 'ghost' }),
      ).resolves.toBe(true);
    });

    it('treats a second deletion as a success without re-tombstoning', async () => {
      const user = await service.resolveSession(SESSION);
      await service.applyEvent('msg_1', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });
      const first = await users.findByClerkUserId('user_1');

      await service.applyEvent('msg_2', {
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
      const user = await service.resolveSession(SESSION);
      await service.applyEvent('msg_1', {
        type: 'user.deleted',
        clerkUserId: 'user_1',
      });

      await service.applyEvent('msg_2', {
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
    await service.resolveSession(SESSION);

    await expect(
      service.resolveSession({
        clerkUserId: 'user_2',
        sessionId: 'sess_2',
        email: 'alice@example.com',
      }),
    ).rejects.toBeInstanceOf(UserConflictError);
  });

  it('treats a differently-cased address as the same one', async () => {
    // The column is citext, so this is the database's answer. The fake models
    // it so the rule is tested here rather than only in the integration suite.
    await service.resolveSession(SESSION);

    await expect(
      service.resolveSession({
        clerkUserId: 'user_2',
        sessionId: 'sess_2',
        email: 'ALICE@EXAMPLE.COM',
      }),
    ).rejects.toBeInstanceOf(UserConflictError);
  });
});
