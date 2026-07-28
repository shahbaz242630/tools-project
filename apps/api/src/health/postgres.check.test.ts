import { describe, expect, it, vi } from 'vitest';
import { PostgresCheck } from './postgres.check.js';
import type { DatabasePing } from './postgres.check.js';

describe('PostgresCheck', () => {
  it('identifies itself as postgres', () => {
    expect(new PostgresCheck({ ping: () => Promise.resolve() }).name).toBe('postgres');
  });

  it('resolves when the database answers', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    await expect(new PostgresCheck({ ping }).probe()).resolves.toBeUndefined();
    expect(ping).toHaveBeenCalledOnce();
  });

  it('rejects when the database refuses the credentials', async () => {
    const database: DatabasePing = {
      ping: () => Promise.reject(new Error('password authentication failed')),
    };
    await expect(new PostgresCheck(database).probe()).rejects.toThrow(
      'password authentication failed',
    );
  });

  it('does not swallow the driver error', async () => {
    // The caller logs this. Replacing it with a generic message here would
    // leave the log unable to distinguish a wrong password from a dead host.
    const database: DatabasePing = {
      ping: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.5:5432')),
    };
    await expect(new PostgresCheck(database).probe()).rejects.toThrow('10.0.0.5');
  });

  it('imposes no timeout of its own', async () => {
    // Bounding the probe is the readiness service's job. Doing it here as well
    // would make the effective timeout the smaller of two numbers set in
    // different files.
    let settled = false;
    void new PostgresCheck({ ping: () => new Promise(() => {}) }).probe().then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
  });
});
