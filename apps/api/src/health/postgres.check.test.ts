import { describe, expect, it, vi } from 'vitest';
import { PostgresCheck } from './postgres.check.js';
import type { SqlClient } from './postgres.check.js';

describe('PostgresCheck', () => {
  it('identifies itself as postgres', () => {
    expect(new PostgresCheck({ query: () => Promise.resolve() }).name).toBe('postgres');
  });

  it('resolves when the query succeeds', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    await expect(new PostgresCheck({ query }).probe()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('rejects when the query fails', async () => {
    const client: SqlClient = {
      query: () => Promise.reject(new Error('password authentication failed')),
    };
    await expect(new PostgresCheck(client).probe()).rejects.toThrow(
      'password authentication failed',
    );
  });

  it('does not swallow the driver error', async () => {
    // The caller logs this. Replacing it with a generic message here would
    // leave the log unable to distinguish a wrong password from a dead host.
    const client: SqlClient = {
      query: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.5:5432')),
    };
    await expect(new PostgresCheck(client).probe()).rejects.toThrow('10.0.0.5');
  });
});
