import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, MAX_ACTIVITY_LIMIT } from './audit.service.js';
import type { Actor } from './audit-log.js';
import {
  InMemoryAuditLog,
  TEST_DIGEST_KEY,
  createAuditFakes,
} from './testing/fakes.js';
import { createStateDigest } from './state-digest.js';

const ALICE: Actor = {
  userId: '00000000-0000-4000-8000-000000000001',
  ipAddress: '203.0.113.7',
};
const BOB: Actor = { userId: '00000000-0000-4000-8000-000000000002', ipAddress: null };
const TARGET = '00000000-0000-4000-8000-0000000000aa';

let log: InMemoryAuditLog;
let service: AuditService;

beforeEach(() => {
  ({ log, service } = createAuditFakes());
});

describe('record', () => {
  it('stores the actor, the action and the target', async () => {
    await service.record({
      actor: ALICE,
      action: 'profile.updated',
      targetType: 'profile',
      targetId: TARGET,
      before: { displayName: 'Sarah M.' },
      after: { displayName: 'Sarah Mitchell' },
    });

    expect(log.entries()).toHaveLength(1);
    expect(log.entries()[0]).toMatchObject({
      actorId: ALICE.userId,
      action: 'profile.updated',
      targetType: 'profile',
      targetId: TARGET,
      ipAddress: '203.0.113.7',
    });
  });

  it('stores digests, never the values it was handed', async () => {
    // The property the whole module rests on. If a value ever reaches the
    // entry, this table becomes a second copy of personal data retained six
    // years while the original is erasable — inverting BRD §10.1.
    await service.record({
      actor: ALICE,
      action: 'profile.updated',
      targetType: 'profile',
      targetId: TARGET,
      before: { displayName: 'Sarah M.', phone: '+447700900123' },
      after: { displayName: 'Sarah Mitchell', phone: '+447700900124' },
    });

    const serialised = JSON.stringify(log.entries()[0]);
    expect(serialised).not.toContain('Sarah');
    expect(serialised).not.toContain('900123');
    expect(log.entries()[0]?.beforeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(log.entries()[0]?.afterHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records different digests when the state actually changed', async () => {
    await service.record({
      actor: ALICE,
      action: 'profile.updated',
      targetType: 'profile',
      targetId: TARGET,
      before: { displayName: 'Sarah M.' },
      after: { displayName: 'Sarah Mitchell' },
    });

    const [entry] = log.entries();
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('records equal digests when nothing actually changed', async () => {
    // A save that changed nothing is still an event worth recording, and the
    // matching digests are what say so. Suppressing the entry would lose the
    // fact that somebody opened and submitted the form.
    const state = { displayName: 'Sarah M.' };
    await service.record({
      actor: ALICE,
      action: 'profile.updated',
      targetType: 'profile',
      targetId: TARGET,
      before: state,
      after: { ...state },
    });

    const [entry] = log.entries();
    expect(entry?.beforeHash).toBe(entry?.afterHash);
  });

  it('leaves beforeHash null for a creation', async () => {
    // Absent, not empty. Digesting a missing prior state would assert a
    // previous version existed.
    await service.record({
      actor: ALICE,
      action: 'profile.created',
      targetType: 'profile',
      targetId: TARGET,
      after: { displayName: 'Sarah M.' },
    });

    expect(log.entries()[0]).toMatchObject({ beforeHash: null });
    expect(log.entries()[0]?.afterHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves afterHash null when there is no resulting state', async () => {
    await service.record({
      actor: ALICE,
      action: 'profile.updated',
      targetType: 'profile',
      targetId: TARGET,
      before: { displayName: 'Sarah M.' },
    });

    expect(log.entries()[0]).toMatchObject({ afterHash: null });
  });

  it('records a null actor for an action nobody took', async () => {
    await service.record({
      actor: null,
      action: 'account.provisioned',
      targetType: 'user',
      targetId: TARGET,
      after: { id: TARGET },
    });

    expect(log.entries()[0]).toMatchObject({ actorId: null, ipAddress: null });
  });

  it('records a null address when the actor has none', async () => {
    // Common and not a defect — the API never sees a browser directly.
    await service.record({
      actor: BOB,
      action: 'account.provisioned',
      targetType: 'user',
      targetId: TARGET,
      after: {},
    });

    expect(log.entries()[0]).toMatchObject({ actorId: BOB.userId, ipAddress: null });
  });

  it('propagates a write failure rather than swallowing it', async () => {
    // Fail closed. Catching here would let the audited action succeed with no
    // record of it, which is the one outcome this module exists to prevent.
    log.failNextRecord(new Error('connection terminated unexpectedly'));

    await expect(
      service.record({
        actor: ALICE,
        action: 'profile.updated',
        targetType: 'profile',
        targetId: TARGET,
        after: {},
      }),
    ).rejects.toThrow(/connection terminated/);
  });

  it('digests consistently with a separately constructed digest', async () => {
    // Callers hand over state and never digests, so every module's entries are
    // comparable. This pins that the service uses the shared construction
    // rather than one of its own.
    await service.record({
      actor: ALICE,
      action: 'profile.updated',
      targetType: 'profile',
      targetId: TARGET,
      after: { displayName: 'Sarah M.' },
    });

    expect(log.entries()[0]?.afterHash).toBe(
      createStateDigest(TEST_DIGEST_KEY).of({ displayName: 'Sarah M.' }),
    );
  });
});

describe('listForActor', () => {
  async function seed(count: number, actor = ALICE): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await service.record({
        actor,
        action: 'profile.updated',
        targetType: 'profile',
        targetId: TARGET,
        after: { index },
      });
    }
  }

  it('returns the actor’s own entries, newest first', async () => {
    await seed(3);
    const entries = await service.listForActor(ALICE.userId);

    expect(entries).toHaveLength(3);
    expect(entries[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(
      entries[2]!.createdAt.getTime(),
    );
  });

  it('returns nobody else’s', async () => {
    // The ownership boundary again. There is deliberately no query for another
    // actor's entries, so the check cannot be forgotten — it does not exist.
    await seed(2, ALICE);
    await seed(1, BOB);

    await expect(service.listForActor(BOB.userId)).resolves.toHaveLength(1);
  });

  it('is empty for an actor with no history', async () => {
    await expect(service.listForActor(ALICE.userId)).resolves.toEqual([]);
  });

  it('never returns the digests', async () => {
    // They are not useful to the person reading their own activity and are not
    // theirs to reason about. Serving them would put them in an HTTP response
    // for no purpose.
    await seed(1);
    const [entry] = await service.listForActor(ALICE.userId);

    expect(entry).not.toHaveProperty('beforeHash');
    expect(entry).not.toHaveProperty('afterHash');
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 2.7],
  ])('clamps a %s limit to something sane', async (_label, limit) => {
    await seed(3);
    const entries = await service.listForActor(ALICE.userId, limit);
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it('caps an unbounded request', async () => {
    // An engineering bound on one query's cost, not a business rule. Without
    // it a caller asking for everything reads an entire audit history into
    // memory to render a page of fifty rows.
    await seed(3);
    const entries = await service.listForActor(ALICE.userId, 10_000);
    expect(entries.length).toBeLessThanOrEqual(MAX_ACTIVITY_LIMIT);
  });
});
