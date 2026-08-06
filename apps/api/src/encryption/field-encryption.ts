import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypting a single column value at rest.
 *
 * **It lived in `profiles/` until slice 2.5a, with a note saying it would move
 * the moment a second module needed it.** That moment is a listing's collection
 * address: the same envelope, the same key, a different owner. Moving it was the
 * cheaper half of the change — the expensive half is that "only the profiles
 * module has the encryptor" is no longer a true sentence anywhere, and the
 * `PersonalDataSource` docblock that said so has been corrected.
 *
 * **A folder in this application rather than a workspace package**, deliberately.
 * A package would be reachable from the worker and the web app, and neither
 * should ever hold `PERSONAL_DATA_ENCRYPTION_KEY` — the web app in particular is
 * the only process a browser reaches. Keeping it here means the key stays where
 * `main.ts` puts it. It is not in `@platform/core` for a harder reason: that
 * package is shared with the browser bundle and bans Node imports, and this file
 * is `node:crypto` from its first line.
 *
 * **What this protects against, and what it does not.** It protects a stolen
 * backup, a mis-scoped read and a leaked dump: those yield ciphertext, and the
 * key is not in the database. It does *not* protect against a compromised API
 * process, which holds the key by necessity. That is the honest boundary — the
 * threat model is offline copies of the data, not live code execution.
 *
 * AES-256-GCM, so the ciphertext is authenticated rather than merely
 * confidential: a value edited in the database fails to decrypt instead of
 * decrypting to something else. That matters more here than secrecy alone,
 * because the address is read back to be shown to a person.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;

/**
 * 96 bits — the size GCM is specified for.
 *
 * Any other length forces the mode to hash the IV into shape internally, which
 * is slower and, more importantly, undocumented behaviour to depend on.
 */
const IV_BYTES = 12;

/** Raised when a stored value cannot be recovered. Never carries the ciphertext. */
export class DecryptionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DecryptionError';
    this.cause = cause;
  }
}

export interface FieldEncryptor {
  /**
   * `context` is bound to the ciphertext as additional authenticated data —
   * it is not stored, and decryption fails without exactly the same value.
   */
  encrypt(plaintext: string, context: string): string;
  decrypt(envelope: string, context: string): string;
}

/**
 * The stored form: `v1:<iv>:<tag>:<ciphertext>`, each part base64.
 *
 * Versioned so a future key rotation can tell which key encrypted a row without
 * a separate column or a guess. The IV is stored in the clear because it is not
 * a secret — it must be unique per encryption, not unpredictable — and the
 * alternative, deriving it from the plaintext, makes identical addresses
 * produce identical ciphertext and leaks that they match.
 */
const ENVELOPE = /^v1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]*)$/;

export function createFieldEncryptor(base64Key: string): FieldEncryptor {
  const key = Buffer.from(base64Key, 'base64');

  // Checked here as well as in the env schema. The schema guards the value that
  // arrives through configuration; this guards every other caller, including
  // tests, which are exactly where a 16-byte key gets introduced by accident.
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be ${String(KEY_BYTES)} bytes, got ${String(key.length)}`,
    );
  }

  return {
    encrypt(plaintext: string, context: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);

      // Binding the row's owner into the ciphertext. Without it, somebody with
      // write access to the database could copy one person's encrypted address
      // onto another's row and the application would decrypt it happily — the
      // bytes are valid, they are simply in the wrong place. With it, that
      // swap fails the authentication tag.
      cipher.setAAD(Buffer.from(context, 'utf8'));

      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);

      return [
        VERSION,
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        ciphertext.toString('base64'),
      ].join(':');
    },

    decrypt(envelope: string, context: string): string {
      const parts = ENVELOPE.exec(envelope);

      if (parts === null) {
        // Deliberately does not echo the value. An error string containing the
        // stored ciphertext ends up in a log, which is the one place the
        // encrypted column was supposed to keep it out of.
        throw new DecryptionError('Stored value is not a recognised envelope');
      }

      const [, ivPart, tagPart, ciphertextPart] = parts;

      try {
        const decipher = createDecipheriv(
          ALGORITHM,
          key,
          Buffer.from(ivPart ?? '', 'base64'),
        );
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(Buffer.from(tagPart ?? '', 'base64'));

        return Buffer.concat([
          decipher.update(Buffer.from(ciphertextPart ?? '', 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch (error) {
        // One message for every failure — wrong key, tampered ciphertext,
        // wrong context. Distinguishing them tells an attacker which of their
        // guesses was closer, and none of the three is recoverable anyway.
        throw new DecryptionError('Stored value could not be decrypted', error);
      }
    },
  };
}
