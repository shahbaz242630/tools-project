import { describe, expect, it } from 'vitest';
import { RedisCheck } from './redis.check.js';

describe('RedisCheck', () => {
  it('identifies itself as redis', () => {
    expect(new RedisCheck({ ping: () => Promise.resolve('PONG') }).name).toBe('redis');
  });

  it('resolves on PONG', async () => {
    const check = new RedisCheck({ ping: () => Promise.resolve('PONG') });
    await expect(check.probe()).resolves.toBeUndefined();
  });

  it('rejects when the connection fails', async () => {
    const check = new RedisCheck({
      ping: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(check.probe()).rejects.toThrow('ECONNREFUSED');
  });

  it('rejects a reply that is not PONG', async () => {
    // Something answered, but it is not Redis — a proxy, a captive portal, or
    // the wrong port. Treating any resolved promise as success would report
    // that as ready.
    const check = new RedisCheck({ ping: () => Promise.resolve('<html>') });
    await expect(check.probe()).rejects.toThrow('unexpected PING reply');
  });
});
