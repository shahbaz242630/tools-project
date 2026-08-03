import { beforeEach, describe, expect, it } from 'vitest';
import { CategorySlugTakenError } from './category-store.js';
import { createCatalogueFakes } from './testing/fakes.js';
import type { CatalogueFakes } from './testing/fakes.js';
import type { Actor } from '../audit/audit-log.js';

const ADMIN: Actor = {
  userId: '00000000-0000-4000-8000-00000000000a',
  ipAddress: '203.0.113.7',
  sessionId: 'sess_admin',
};

const REASON = 'Opening the launch category';

let fakes: CatalogueFakes;

beforeEach(() => {
  fakes = createCatalogueFakes();
});

const draft = {
  slug: 'outdoor-gardening',
  name: 'Outdoor and gardening',
  riskLevel: 'low',
} as const;

describe('creating a category', () => {
  it('starts at version 1 and returns the configuration in force', async () => {
    const created = await fakes.service.create(ADMIN, draft, REASON);

    expect(created.slug).toBe('outdoor-gardening');
    expect(created.name).toBe('Outdoor and gardening');
    expect(created.riskLevel).toBe('low');
    expect(created.versionNumber).toBe(1);
  });

  it('records who created it and why', async () => {
    const created = await fakes.service.create(ADMIN, draft, REASON);

    const entries = fakes.audit.log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('category.created');
    expect(entries[0]?.targetType).toBe('category');
    expect(entries[0]?.targetId).toBe(created.id);
    expect(entries[0]?.actorId).toBe(ADMIN.userId);
    expect(entries[0]?.reason).toBe(REASON);
    expect(entries[0]?.sessionId).toBe('sess_admin');
  });

  it('has no before-state, because there was no previous configuration', async () => {
    await fakes.service.create(ADMIN, draft, REASON);

    // Null rather than a digest of an empty object: digesting one would claim a
    // prior version existed, and the trail would read as an edit.
    expect(fakes.audit.log.entries()[0]?.beforeHash).toBeNull();
    expect(fakes.audit.log.entries()[0]?.afterHash).not.toBeNull();
  });

  it('refuses a slug that is already taken', async () => {
    await fakes.service.create(ADMIN, draft, REASON);

    await expect(
      fakes.service.create(ADMIN, { ...draft, name: 'Something else' }, REASON),
    ).rejects.toBeInstanceOf(CategorySlugTakenError);
  });

  it('writes no audit entry when the create is refused', async () => {
    await fakes.service.create(ADMIN, draft, REASON);
    await expect(fakes.service.create(ADMIN, draft, REASON)).rejects.toThrow();

    // One entry, from the first create. An entry for a change that did not
    // happen is worse than none — it is a trail that disagrees with the data.
    expect(fakes.audit.log.entries()).toHaveLength(1);
  });

  it('fails the create when the audit write fails', async () => {
    // ADR 0017's fail-closed rule, and it matters more here than usual: these
    // rows are what every later booking is interpreted under, so a
    // configuration change nobody can attribute is not an acceptable outcome.
    fakes.audit.log.failNextRecord(new Error('audit unavailable'));

    await expect(fakes.service.create(ADMIN, draft, REASON)).rejects.toThrow(
      'audit unavailable',
    );
  });
});

describe('reconfiguring a category', () => {
  beforeEach(async () => {
    await fakes.service.create(ADMIN, draft, REASON);
  });

  it('appends a version rather than changing the existing one', async () => {
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      { name: 'Garden and outdoor', riskLevel: 'medium' },
      'Renamed after the taxonomy review',
    );

    const versions = fakes.store.versionsOf('outdoor-gardening');
    expect(versions).toHaveLength(2);
    // The first version still says exactly what it said. This is the property a
    // booking created under it depends on.
    expect(versions[0]?.name).toBe('Outdoor and gardening');
    expect(versions[0]?.riskLevel).toBe('low');
    expect(versions[1]?.name).toBe('Garden and outdoor');
    expect(versions[1]?.riskLevel).toBe('medium');
  });

  it('reads back the newest version', async () => {
    const updated = await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      { name: 'Garden and outdoor', riskLevel: 'medium' },
      'Renamed after the taxonomy review',
    );

    expect(updated?.versionNumber).toBe(2);
    expect(updated?.name).toBe('Garden and outdoor');
    expect((await fakes.service.findBySlug('outdoor-gardening'))?.versionNumber).toBe(
      2,
    );
  });

  it('keeps the slug, because it is the identity', async () => {
    const updated = await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      { name: 'Something completely different', riskLevel: 'high' },
      'Testing that the slug is stable',
    );

    // There is no route that can change it — the contract has no such field —
    // so this pins that renaming does not quietly move the URL either.
    expect(updated?.slug).toBe('outdoor-gardening');
  });

  it('records both sides of the change', async () => {
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      { name: 'Garden and outdoor', riskLevel: 'medium' },
      'Renamed after the taxonomy review',
    );

    const entry = fakes.audit.log.entries()[1];
    expect(entry?.action).toBe('category.reconfigured');
    expect(entry?.reason).toBe('Renamed after the taxonomy review');
    expect(entry?.beforeHash).not.toBeNull();
    expect(entry?.afterHash).not.toBeNull();
    // Different, because the configuration actually changed. If these matched,
    // comparing digests would be telling us nothing.
    expect(entry?.beforeHash).not.toBe(entry?.afterHash);
  });

  it('digests the configuration and not the timestamps', async () => {
    // Saving the same values again must produce equal digests. Including
    // `versionNumber` or `createdAt` would make every entry differ from the
    // last whether or not anything meaningful changed, which destroys the only
    // thing comparing digests is for.
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      { name: 'Outdoor and gardening', riskLevel: 'low' },
      'Saving the identical configuration again',
    );

    const entry = fakes.audit.log.entries()[1];
    expect(entry?.beforeHash).toBe(entry?.afterHash);
  });

  it('answers null for a category that does not exist', async () => {
    const missing = await fakes.service.reconfigure(
      ADMIN,
      'no-such-category',
      { name: 'Nothing', riskLevel: 'low' },
      'Should not be possible',
    );

    expect(missing).toBeNull();
    // No entry: nothing changed, so there is nothing to record.
    expect(fakes.audit.log.entries()).toHaveLength(1);
  });
});

describe('reading categories', () => {
  it('lists them oldest first with their current configuration', async () => {
    await fakes.service.create(ADMIN, draft, REASON);
    await fakes.service.create(
      ADMIN,
      { slug: 'cleaning-floorcare', name: 'Cleaning', riskLevel: 'low' },
      REASON,
    );
    await fakes.service.reconfigure(
      ADMIN,
      'outdoor-gardening',
      { name: 'Garden and outdoor', riskLevel: 'medium' },
      'Renamed after the taxonomy review',
    );

    const listed = await fakes.service.list();
    expect(listed.map((category) => category.slug)).toEqual([
      'outdoor-gardening',
      'cleaning-floorcare',
    ]);
    expect(listed[0]?.name).toBe('Garden and outdoor');
    expect(listed[0]?.versionNumber).toBe(2);
  });

  it('does not audit a read', async () => {
    await fakes.service.create(ADMIN, draft, REASON);
    await fakes.service.list();
    await fakes.service.findBySlug('outdoor-gardening');

    // Only the create. A category has no subject to owe an explanation to, and
    // auditing every list would bury the disclosures that do (ADR 0021).
    expect(fakes.audit.log.entries()).toHaveLength(1);
  });

  it('answers null for an unknown slug', async () => {
    expect(await fakes.service.findBySlug('no-such-category')).toBeNull();
  });
});
