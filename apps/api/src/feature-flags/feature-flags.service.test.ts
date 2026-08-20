import { beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAGS } from '@platform/contracts';
import { FLAG_CACHE_TTL_MS } from './feature-flags.service.js';
import { createFeatureFlagFakes } from './testing/fakes.js';
import type { FeatureFlagFakes } from './testing/fakes.js';
import type { Actor } from '../audit/audit-log.js';

const ADMIN: Actor = {
  userId: '00000000-0000-4000-8000-00000000000a',
  ipAddress: '203.0.113.7',
  sessionId: 'sess_admin',
};

const REASON = 'Stopping publications while we investigate a report';

/** The only flag this build declares. Its declared default is on. */
const FLAG = 'listing.publication';

let fakes: FeatureFlagFakes;

beforeEach(() => {
  fakes = createFeatureFlagFakes();
});

describe('reading a flag', () => {
  it('uses the declared default when nothing has been switched', async () => {
    // `listing.publication` defaults to **on**, because it is a kill switch over
    // functionality that works. A fresh platform publishes.
    expect(await fakes.service.isEnabled(FLAG)).toBe(true);
    expect(fakes.store.all()).toHaveLength(0);
  });

  it('uses the override once one exists', async () => {
    fakes.store.seed(FLAG, false);
    expect(await fakes.service.isEnabled(FLAG)).toBe(false);
  });

  it('ignores a row whose key this build no longer declares', async () => {
    // A flag removed from the code leaves its row behind. It must not come back
    // to life as a switch that gates nothing, and it must not disturb the flags
    // that are real.
    fakes.store.seed('listing.something_deleted', false);

    expect(await fakes.service.isEnabled(FLAG)).toBe(true);
    /*
     * **Against the declaration rather than a literal count** (slice 5.2c, when a
     * second flag was declared and three tests in this file failed on the number
     * one). The claim was never about there being one flag — it is that a row for
     * a key this build no longer declares contributes nothing to the list.
     */
    expect(await fakes.service.list()).toHaveLength(FEATURE_FLAGS.length);
    expect((await fakes.service.list()).map((flag) => flag.key)).not.toContain(
      'listing.something_deleted',
    );
  });
});

describe('the fail-safe', () => {
  it('answers with the declared default when the store cannot be read', async () => {
    // The property the whole design turns on. A flag read that threw would make
    // every call site wrap it, and the first to forget would turn a database
    // blip into a 500 on a path that worked before anybody added a flag.
    fakes.store.failsWith(new Error('connection terminated unexpectedly'));

    await expect(fakes.service.isEnabled(FLAG)).resolves.toBe(true);
  });

  it('reports the failure rather than swallowing it', async () => {
    fakes.store.failsWith(new Error('connection terminated unexpectedly'));
    await fakes.service.isEnabled(FLAG);

    // Error, not warn: the platform is running on defaults and nobody switching
    // a flag can affect it. Nothing looks broken, which is exactly why it has
    // to be said out loud.
    const errors = fakes.logger.at('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('feature flag read failed, using declared default');
    expect(errors[0]?.fields).toMatchObject({ key: FLAG, defaultEnabled: true });
  });

  it('falls back to the default even when the override said otherwise', async () => {
    // The uncomfortable half, stated so nobody is surprised by it: an outage
    // returns a flag to its default, so a kill switch that was **off** comes
    // back **on** if the database becomes unreachable and the cache has expired.
    //
    // It is the right trade for this flag and it is why the direction of each
    // default is a per-flag decision. The alternative — remembering the last
    // known value indefinitely — means a process that has never read the table
    // behaves differently from one that has, which is worse than a rule you can
    // state in one sentence.
    fakes.store.seed(FLAG, false);
    expect(await fakes.service.isEnabled(FLAG)).toBe(false);

    fakes.advance(FLAG_CACHE_TTL_MS);
    fakes.store.failsWith(new Error('connection terminated unexpectedly'));

    expect(await fakes.service.isEnabled(FLAG)).toBe(true);
  });

  it('propagates a failure to the admin list rather than showing defaults', async () => {
    // The opposite choice from `isEnabled`, deliberately. A code path needs an
    // answer it can act on; an administrator needs the truth or an error. A page
    // quietly showing defaults during an outage would invite somebody to
    // conclude a flag had switched itself back on.
    fakes.store.failsWith(new Error('connection terminated unexpectedly'));

    await expect(fakes.service.list()).rejects.toThrow('connection terminated');
  });
});

describe('the cache', () => {
  it('does not re-read the store within the TTL', async () => {
    await fakes.service.isEnabled(FLAG);

    // Changed underneath, without going through `set`. The cached answer stands
    // until it expires — which is the point of the cache and the cost of it.
    fakes.store.seed(FLAG, false);
    fakes.advance(FLAG_CACHE_TTL_MS - 1);

    expect(await fakes.service.isEnabled(FLAG)).toBe(true);
  });

  it('re-reads once the TTL has passed', async () => {
    await fakes.service.isEnabled(FLAG);
    fakes.store.seed(FLAG, false);
    fakes.advance(FLAG_CACHE_TTL_MS);

    expect(await fakes.service.isEnabled(FLAG)).toBe(false);
  });

  it('is dropped by a switch, so the switcher sees their own change at once', async () => {
    // §9 asks for *rapid* disablement. An administrator who throws a switch and
    // then reads a stale value is looking at something indistinguishable from a
    // write that failed — and during an incident they will throw it again.
    await fakes.service.isEnabled(FLAG);

    await fakes.service.set(ADMIN, FLAG, false, REASON);

    // No clock movement. The next read is the truth immediately.
    expect(await fakes.service.isEnabled(FLAG)).toBe(false);
  });

  it('does not cache the admin list', async () => {
    await fakes.service.isEnabled(FLAG);
    fakes.store.seed(FLAG, false);

    // Read through, with no clock movement — the administrator sees the row.
    const listed = await fakes.service.list();
    expect(listed[0]?.enabled).toBe(false);
  });
});

describe('the admin list', () => {
  it('lists every declared flag, including ones never switched', async () => {
    // Driven by the declaration rather than by the rows: the page has to offer
    // every switch that exists, not only the ones somebody has already used.
    const listed = await fakes.service.list();

    expect(listed).toHaveLength(FEATURE_FLAGS.length);
    expect(listed.map((flag) => flag.key)).toEqual(
      FEATURE_FLAGS.map((declaration) => declaration.key),
    );
    expect(listed[0]).toMatchObject({
      key: FLAG,
      enabled: true,
      defaultEnabled: true,
      source: 'default',
      changedAt: null,
      changedById: null,
    });
  });

  it('says where the value came from, and who changed it', async () => {
    // "On because nobody touched it" and "on because somebody switched it on"
    // are different facts, and only one has a person behind it. During an
    // incident that is the first thing worth knowing.
    await fakes.service.set(ADMIN, FLAG, false, REASON);

    const listed = await fakes.service.list();
    expect(listed[0]).toMatchObject({
      enabled: false,
      defaultEnabled: true,
      source: 'override',
      changedById: ADMIN.userId,
    });
    expect(listed[0]?.changedAt).not.toBeNull();
  });

  it('still reports an override that matches the default as an override', async () => {
    // Switching a flag back to its default value is a decision somebody made,
    // and the list says so. Collapsing it to `default` would erase the fact that
    // a human looked at it — which is why the store has no delete.
    await fakes.service.set(ADMIN, FLAG, true, 'Publishing is safe again');

    // The flag under test, found by key rather than by position — a second
    // declared flag must not make this about ordering.
    const listed = await fakes.service.list();
    expect(listed.find((flag) => flag.key === FLAG)).toMatchObject({
      enabled: true,
      defaultEnabled: true,
      source: 'override',
    });
  });

  it('carries the prose an administrator needs mid-incident', async () => {
    const listed = await fakes.service.list();

    expect(listed[0]?.label).toBe('Publishing listings');
    expect(listed[0]?.gates).toContain('emergency stop');
  });
});

describe('switching a flag', () => {
  it('stores the override and returns the new state', async () => {
    const updated = await fakes.service.set(ADMIN, FLAG, false, REASON);

    expect(updated).toMatchObject({ key: FLAG, enabled: false, source: 'override' });
    expect(fakes.store.all()).toMatchObject([{ key: FLAG, enabled: false }]);
  });

  it('audits it with the before and after state, and the reason', async () => {
    await fakes.service.set(ADMIN, FLAG, false, REASON);

    const entries = fakes.audit.log.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actorId: ADMIN.userId,
      action: 'feature_flag.changed',
      targetType: 'feature_flag',
      reason: REASON,
    });
    // The override row's uuid, not the key — `audit_logs.targetId` is a uuid
    // column, which is the entire reason the row carries a synthetic id when
    // `key` would have been a perfectly good primary key. The key travels in
    // the digested state instead, exactly as a category's slug does.
    expect(entries[0]?.targetId).toBe(fakes.store.all()[0]?.id);
    // Both digests present and different — the entry has to say what it *was*,
    // or a reviewer cannot tell a change from a no-op.
    expect(entries[0]?.beforeHash).not.toBeNull();
    expect(entries[0]?.afterHash).not.toBeNull();
    expect(entries[0]?.beforeHash).not.toBe(entries[0]?.afterHash);
  });

  it('logs it as well as auditing it', async () => {
    // The one place duplication is right: the trail is read afterwards, the log
    // is what somebody is watching *during* the incident.
    await fakes.service.set(ADMIN, FLAG, false, REASON);

    const warnings = fakes.logger.at('warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('feature flag changed');
    expect(warnings[0]?.fields).toMatchObject({
      key: FLAG,
      from: true,
      to: false,
      changedById: ADMIN.userId,
    });
  });

  it('is idempotent, and records the second call as its own decision', async () => {
    await fakes.service.set(ADMIN, FLAG, false, REASON);
    const again = await fakes.service.set(ADMIN, FLAG, false, 'Confirming it is off');

    // A kill switch that errored because it was already thrown is one that makes
    // an incident worse. One row, two entries: the state is the same and both
    // decisions are on the record.
    expect(again).toMatchObject({ enabled: false });
    expect(fakes.store.all()).toHaveLength(1);
    expect(fakes.audit.log.entries()).toHaveLength(2);
  });

  it('refuses a key this build does not declare, and stores nothing', async () => {
    const result = await fakes.service.set(ADMIN, 'listing.invented', false, REASON);

    // Null so the route can answer 404. Storing it would put a switch on the
    // admin page that gates nothing — the dead control the closed vocabulary
    // exists to prevent.
    expect(result).toBeNull();
    expect(fakes.store.all()).toHaveLength(0);
    expect(fakes.audit.log.entries()).toHaveLength(0);
  });
});
