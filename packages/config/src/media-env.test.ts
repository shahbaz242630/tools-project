import { describe, expect, it } from 'vitest';
import { EnvironmentError } from './env.js';
import { loadMediaEnv, mediaStorageFrom } from './media-env.js';

const COMPLETE = {
  MEDIA_S3_ENDPOINT: 'https://account.eu.r2.cloudflarestorage.com',
  MEDIA_S3_BUCKET: 'rental-staging-media',
  MEDIA_S3_ACCESS_KEY_ID: 'a'.repeat(32),
  MEDIA_S3_SECRET_ACCESS_KEY: 'b'.repeat(64),
};

describe('loading the object-store configuration', () => {
  it('accepts a complete set', () => {
    expect(() => loadMediaEnv(COMPLETE)).not.toThrow();
  });

  it('accepts nothing at all, which is how local development runs', () => {
    // The rule that keeps a developer's machine from writing into the bucket a
    // deployed environment is serving from — the object-storage form of "never
    // point local development at a shared database".
    expect(mediaStorageFrom(loadMediaEnv({}))).toBeNull();
  });

  it.each([
    'MEDIA_S3_ENDPOINT',
    'MEDIA_S3_BUCKET',
    'MEDIA_S3_ACCESS_KEY_ID',
    'MEDIA_S3_SECRET_ACCESS_KEY',
  ])('refuses a set missing only %s', (absent) => {
    const partial = { ...COMPLETE };
    delete partial[absent as keyof typeof COMPLETE];

    // Half-configured is the dangerous state: it reads as "media is set up" to
    // anybody looking at the env file and behaves as "media is off" at runtime.
    expect(() => loadMediaEnv(partial)).toThrow(EnvironmentError);
  });

  it('names every missing value, not just the first', () => {
    const error = (() => {
      try {
        loadMediaEnv({ MEDIA_S3_BUCKET: 'rental-staging-media' });
        return null;
      } catch (thrown) {
        return thrown as Error;
      }
    })();

    expect(error?.message).toContain('MEDIA_S3_ENDPOINT');
    expect(error?.message).toContain('MEDIA_S3_ACCESS_KEY_ID');
    expect(error?.message).toContain('MEDIA_S3_SECRET_ACCESS_KEY');
  });

  it('refuses an endpoint that is not a URL', () => {
    expect(() =>
      loadMediaEnv({ ...COMPLETE, MEDIA_S3_ENDPOINT: 'account.eu.r2.example' }),
    ).toThrow(EnvironmentError);
  });
});

describe('resolving the store', () => {
  it('hands back the four values when they are all present', () => {
    expect(mediaStorageFrom(loadMediaEnv(COMPLETE))).toEqual({
      endpoint: COMPLETE.MEDIA_S3_ENDPOINT,
      bucket: COMPLETE.MEDIA_S3_BUCKET,
      accessKeyId: COMPLETE.MEDIA_S3_ACCESS_KEY_ID,
      secretAccessKey: COMPLETE.MEDIA_S3_SECRET_ACCESS_KEY,
    });
  });

  it('refuses to run a production environment with no object store', () => {
    /*
     * ADR 0030's shape: refuse to boot rather than degrade invisibly. A
     * deployed environment with no store accepts no photographs and shows none,
     * while every health check passes — the exact failure this project has been
     * bitten by twice (the missing INTERNAL_TRIGGER_SECRET, and
     * TRUSTED_PROXY_HOPS never reaching the web container).
     */
    expect(() => mediaStorageFrom(loadMediaEnv({ NODE_ENV: 'production' }))).toThrow(
      /NODE_ENV=production/,
    );
  });

  it('still resolves in production when it is configured', () => {
    expect(
      mediaStorageFrom(loadMediaEnv({ ...COMPLETE, NODE_ENV: 'production' })),
    ).not.toBeNull();
  });
});
