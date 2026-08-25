/**
 * Environment for the object store that holds listing media.
 *
 * **A separate schema, for the reason `loadPersonalDataEnv` is separate.** The
 * worker shares `loadEnv`, and it has no business holding a credential that can
 * write to — or delete from — the bucket serving every listing photograph on
 * the platform. Folding these into the shared loader would hand that to every
 * future process, and would stop the worker booting without them.
 *
 * The API loads this. Nothing else does.
 *
 * **Optional as a group, and that is deliberate.** Local development runs
 * against the in-memory fake and must not need a live bucket — pointing a
 * developer's machine at staging's store is the object-storage form of the rule
 * that local development never shares a database. So an absent set is a valid
 * configuration meaning "no object store", and the API refuses *uploads* rather
 * than refusing to boot. What is not valid is a half-filled set: that is
 * somebody who meant to configure it, and it fails loudly here.
 */

import { z } from 'zod';
import { EnvironmentError } from './env.js';
import type { EnvSource } from './env.js';

const shape = z.object({
  NODE_ENV: z.string().optional(),

  /**
   * The S3 endpoint for the bucket's jurisdiction.
   *
   * **Configuration rather than a constructed string, because the
   * jurisdiction changes it.** An EU-jurisdiction R2 bucket answers at
   * `<account>.eu.r2.cloudflarestorage.com`; the default endpoint omits the
   * `.eu.` and does not reach it. Deriving this from an account id would work
   * until the first bucket chosen for data residency — which is ours.
   */
  MEDIA_S3_ENDPOINT: z.url().optional(),

  MEDIA_S3_BUCKET: z.string().min(1).optional(),

  /**
   * The credential. **Object-scoped and bucket-scoped, never account-admin.**
   *
   * The token this is issued from can read, write and list objects in one
   * named bucket. It deliberately cannot create or delete buckets or change
   * bucket configuration, so the worst a leaked API process can do is corrupt
   * the media of listings it could already read.
   */
  MEDIA_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  MEDIA_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

/**
 * Every variable this schema declares, derived from it rather than restated.
 *
 * See `SERVER_ENV_KEYS` in `env.ts` for why these exist: the deployed compose
 * file enumerates variables by name and passes no env file through, so a
 * variable added here reaches a deployed process only if that file was edited
 * too. It has been forgotten twice.
 */
export const MEDIA_ENV_KEYS: readonly string[] = Object.keys(shape.shape);

const schema = shape.superRefine((env, ctx) => {
  const fields = [
    'MEDIA_S3_ENDPOINT',
    'MEDIA_S3_BUCKET',
    'MEDIA_S3_ACCESS_KEY_ID',
    'MEDIA_S3_SECRET_ACCESS_KEY',
  ] as const;

  const present = fields.filter((field) => env[field] !== undefined);
  if (present.length === 0 || present.length === fields.length) return;

  // Half-configured is the dangerous state: it reads as "media is set up" to
  // anybody looking at the env file, and behaves as "media is off" at
  // runtime. Name the missing ones rather than the present ones — the
  // question being answered is "what do I still have to set".
  const missing = fields.filter((field) => env[field] === undefined);
  ctx.addIssue({
    code: 'custom',
    path: [missing[0] ?? 'MEDIA_S3_ENDPOINT'],
    message:
      `is required once any MEDIA_S3_* value is set. Missing: ${missing.join(', ')}. ` +
      'Leave all four unset to run against the in-memory store, which is what ' +
      'local development should do — a developer machine must never write to a ' +
      'shared bucket.',
  });
});

export type MediaEnv = z.infer<typeof schema>;

/** The four values, or null when no object store is configured. */
export interface MediaStorage {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export function loadMediaEnv(source: EnvSource = process.env): MediaEnv {
  const result = schema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentError(
      result.error.issues.map((issue) => {
        const name = issue.path.join('.') || '(root)';
        return issue.code === 'invalid_type' && issue.message === 'Required'
          ? `${name} is required but not set`
          : `${name}: ${issue.message}`;
      }),
    );
  }

  return result.data;
}

/**
 * The configured store, or null.
 *
 * Null is a supported answer and the composition root turns it into the
 * in-memory store. It is **not** supported under `NODE_ENV=production`: a
 * deployed environment silently serving no images, with every upload refused
 * and nothing failing, is precisely ADR 0030's argument for refusing to boot
 * rather than defaulting quietly.
 */
export function mediaStorageFrom(env: MediaEnv): MediaStorage | null {
  if (
    env.MEDIA_S3_ENDPOINT === undefined ||
    env.MEDIA_S3_BUCKET === undefined ||
    env.MEDIA_S3_ACCESS_KEY_ID === undefined ||
    env.MEDIA_S3_SECRET_ACCESS_KEY === undefined
  ) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'MEDIA_S3_* is unset under NODE_ENV=production. A deployed environment ' +
          'with no object store accepts no photographs and shows none, while every ' +
          'health check passes — so this refuses to start rather than degrading ' +
          'invisibly. Set all four, or run with NODE_ENV unset for local development.',
      );
    }

    return null;
  }

  return {
    endpoint: env.MEDIA_S3_ENDPOINT,
    bucket: env.MEDIA_S3_BUCKET,
    accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID,
    secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY,
  };
}
