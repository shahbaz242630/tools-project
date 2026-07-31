/**
 * Environment for encrypting personal data at rest.
 *
 * A separate schema for the reason `loadIdentityEnv` is separate: the worker
 * shares `loadEnv` and has no business holding a key that decrypts home
 * addresses. Folding this into the shared loader would hand every future
 * process the ability to read them, and would stop the worker booting without
 * one — the exact coupling that made a queue consumer demand a JWT key.
 *
 * The API loads this. Nothing else does.
 */

import { z } from 'zod';
import { EnvironmentError } from './env.js';
import type { EnvSource } from './env.js';

/**
 * A base64 AES-256 key, validated for length without decoding it.
 *
 * 32 bytes encodes to exactly 43 base64 characters plus one `=` of padding, so
 * the shape is checkable arithmetically. Done this way deliberately: `Buffer`
 * is Node-only and this package is also imported by the web app, where pulling
 * a Node global into the bundle is a build failure that points at the wrong
 * file entirely.
 *
 * Checked at startup rather than at first use. A key that is 16 bytes because
 * someone generated it with the wrong command otherwise surfaces as a
 * `createCipheriv` throw on whichever unlucky request first saves an address.
 */
const aes256Key = z
  .string()
  .regex(
    /^[A-Za-z0-9+/]{43}=$/,
    'must be a base64-encoded 32-byte key — generate one with: openssl rand -base64 32',
  );

const schema = z.object({
  /**
   * Encrypts the identifying part of a stored address (BRD §6.2, "encrypted
   * detail").
   *
   * Street lines are the difference between "somebody in BS7" and a front door,
   * and unlike the postcode nothing operational needs them queryable — they are
   * read back only to show a person their own address, or to release it to a
   * counterparty once a booking authorises it. Encrypting them means a database
   * backup, a stolen dump or a mis-scoped read leaks postal districts rather
   * than addresses.
   *
   * **This key is not recoverable and there is no plaintext copy.** Losing it
   * loses every stored address; leaking it undoes the protection retroactively
   * for any backup an attacker also holds. It belongs in the secret manager,
   * never in an image, and it must differ between staging and production.
   */
  PERSONAL_DATA_ENCRYPTION_KEY: aes256Key,
});

export type PersonalDataEnv = z.infer<typeof schema>;

/** Parse and validate, reporting every problem rather than only the first. */
export function loadPersonalDataEnv(source: EnvSource = process.env): PersonalDataEnv {
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
