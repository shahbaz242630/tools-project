import { describe, expect, it } from 'vitest';
import { createStateDigest } from './state-digest.js';

const KEY = Buffer.alloc(32, 3).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 4).toString('base64');

const digest = createStateDigest(KEY);

describe('createStateDigest', () => {
  it.each([
    ['a 16-byte key', Buffer.alloc(16).toString('base64')],
    ['an empty key', ''],
  ])('refuses %s', (_label, key) => {
    expect(() => createStateDigest(key)).toThrow(/32 bytes/);
  });
});

describe('stability', () => {
  it('is the same for the same state', () => {
    const state = { displayName: 'Sarah M.', phone: '+447700900123' };
    expect(digest.of(state)).toBe(digest.of({ ...state }));
  });

  it('is the same across key order', () => {
    // Without canonicalisation `{a, b}` and `{b, a}` differ, and every audit
    // entry would claim a change that never happened — a failure that looks
    // exactly like the audit log working.
    expect(digest.of({ a: 1, b: 2 })).toBe(digest.of({ b: 2, a: 1 }));
  });

  it('is the same across key order at depth', () => {
    expect(digest.of({ outer: { a: 1, b: 2 } })).toBe(
      digest.of({ outer: { b: 2, a: 1 } }),
    );
  });

  it('is stable across processes, so entries stay comparable over time', () => {
    // A fresh instance with the same key, standing in for a redeployed API.
    // Anything process-local in the derivation — a random salt, a per-boot
    // secret — would make yesterday's entries incomparable with today's.
    expect(createStateDigest(KEY).of({ x: 1 })).toBe(digest.of({ x: 1 }));
  });

  it('treats an absent member and an undefined one as the same state', () => {
    expect(digest.of({ a: 1, b: undefined })).toBe(digest.of({ a: 1 }));
  });

  it('digests a Date by its instant, not by object identity', () => {
    const iso = '2026-07-31T09:00:00.000Z';
    expect(digest.of({ at: new Date(iso) })).toBe(digest.of({ at: new Date(iso) }));
  });
});

describe('sensitivity', () => {
  it('changes when a value changes', () => {
    expect(digest.of({ displayName: 'Sarah M.' })).not.toBe(
      digest.of({ displayName: 'Sarah Mitchell' }),
    );
  });

  it('distinguishes a cleared field from an absent one', () => {
    // "Was set, now null" is a real change worth auditing; "never mentioned"
    // is not. Collapsing them would hide somebody deleting their phone number.
    expect(digest.of({ phone: null })).not.toBe(digest.of({}));
  });

  it('notices a reordered array', () => {
    // Order is meaningful in a list — a permissions array especially — so it is
    // preserved rather than sorted. Sorting would hide exactly the change most
    // worth catching.
    expect(digest.of([1, 2])).not.toBe(digest.of([2, 1]));
  });

  it('distinguishes a number from the string of it', () => {
    expect(digest.of({ a: 1 })).not.toBe(digest.of({ a: '1' }));
  });
});

describe('the key', () => {
  it('produces a different digest under a different key', () => {
    expect(createStateDigest(OTHER_KEY).of({ x: 1 })).not.toBe(digest.of({ x: 1 }));
  });

  it('is not a bare hash of the state', async () => {
    // The reason this is keyed at all. A display name has a tiny value space,
    // so an unkeyed digest is recoverable offline by anyone holding the table —
    // they would hash a list of plausible names and compare. This asserts the
    // digest is not the obvious unkeyed construction.
    const { createHash } = await import('node:crypto');
    const bare = createHash('sha256')
      .update(JSON.stringify({ x: 1 }))
      .digest('hex');

    expect(digest.of({ x: 1 })).not.toBe(bare);
  });

  it('derives its key rather than using the master secret directly', async () => {
    // Purpose separation: the same secret also encrypts addresses. Using it
    // unmodified for two jobs means a weakness in either implicates both.
    const { createHmac } = await import('node:crypto');
    const direct = createHmac('sha256', Buffer.from(KEY, 'base64'))
      .update(JSON.stringify({ x: 1 }))
      .digest('hex');

    expect(digest.of({ x: 1 })).not.toBe(direct);
  });
});

describe('shape', () => {
  it('is a 64-character hex string', () => {
    expect(digest.of({ anything: true })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles primitives and null', () => {
    for (const value of [null, 0, '', false, 'text']) {
      expect(digest.of(value)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('contains none of the state it digested', () => {
    expect(digest.of({ displayName: 'Sarah M.' })).not.toContain('Sarah');
  });
});
