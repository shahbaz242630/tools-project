import { describe, expect, it } from 'vitest';
import { DecryptionError, createFieldEncryptor } from './field-encryption.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const CONTEXT = 'user-3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const encryptor = createFieldEncryptor(KEY);

describe('createFieldEncryptor', () => {
  it.each([
    ['a 16-byte key', Buffer.alloc(16).toString('base64')],
    ['an empty key', ''],
    ['a passphrase', Buffer.from('hunter2').toString('base64')],
  ])('refuses %s', (_label, key) => {
    // Checked here as well as in the env schema: the schema guards
    // configuration, this guards every other caller — tests especially, which
    // is where a short key gets introduced by accident.
    expect(() => createFieldEncryptor(key)).toThrow(/32 bytes/);
  });
});

describe('round trip', () => {
  it('recovers the plaintext', () => {
    const envelope = encryptor.encrypt('12 Acacia Avenue', CONTEXT);
    expect(encryptor.decrypt(envelope, CONTEXT)).toBe('12 Acacia Avenue');
  });

  it('recovers JSON, which is what the address store actually stores', () => {
    const detail = JSON.stringify({ line1: '12 Acacia Avenue', line2: 'Flat 3' });
    expect(encryptor.decrypt(encryptor.encrypt(detail, CONTEXT), CONTEXT)).toBe(detail);
  });

  it('handles an empty string', () => {
    expect(encryptor.decrypt(encryptor.encrypt('', CONTEXT), CONTEXT)).toBe('');
  });

  it('handles characters outside ASCII', () => {
    // Addresses in Wales and Scotland routinely carry them, and a UTF-8
    // round-trip bug shows up as mojibake on somebody's own profile page.
    const value = 'Ffordd Pen Llech, Harlech — Gwynedd';
    expect(encryptor.decrypt(encryptor.encrypt(value, CONTEXT), CONTEXT)).toBe(value);
  });
});

describe('the envelope', () => {
  it('is versioned, so a future key rotation can tell which key applies', () => {
    expect(encryptor.encrypt('anything', CONTEXT)).toMatch(/^v1:/);
  });

  it('contains no plaintext', () => {
    const envelope = encryptor.encrypt('12 Acacia Avenue', CONTEXT);
    expect(envelope).not.toContain('Acacia');
    expect(Buffer.from(envelope, 'utf8').toString('utf8')).not.toContain('Acacia');
  });

  it('differs every time for the same input', () => {
    // A fresh IV per encryption. Deriving it from the plaintext instead would
    // make two people at the same address produce identical ciphertext, which
    // leaks that they match without decrypting anything.
    const first = encryptor.encrypt('12 Acacia Avenue', CONTEXT);
    const second = encryptor.encrypt('12 Acacia Avenue', CONTEXT);
    expect(first).not.toBe(second);
    expect(encryptor.decrypt(second, CONTEXT)).toBe('12 Acacia Avenue');
  });
});

describe('failure', () => {
  it('refuses a value encrypted under a different key', () => {
    const envelope = createFieldEncryptor(OTHER_KEY).encrypt(
      '12 Acacia Avenue',
      CONTEXT,
    );
    expect(() => encryptor.decrypt(envelope, CONTEXT)).toThrow(DecryptionError);
  });

  it('refuses a ciphertext moved onto another row', () => {
    // The reason the owner is bound in as additional authenticated data.
    // Without it, anyone with database write access could copy one person's
    // encrypted address onto another's row and the application would decrypt
    // it happily — the bytes are valid, they are just in the wrong place.
    const envelope = encryptor.encrypt('12 Acacia Avenue', CONTEXT);
    expect(() => encryptor.decrypt(envelope, 'user-somebody-else')).toThrow(
      DecryptionError,
    );
  });

  it('refuses a tampered ciphertext', () => {
    // GCM authenticates as well as encrypts, so an edited value fails rather
    // than decrypting to something else. That matters because this value is
    // read back to be shown to a person.
    const envelope = encryptor.encrypt('12 Acacia Avenue', CONTEXT);
    const [version, iv, tag, ciphertext] = envelope.split(':');
    const flipped = Buffer.from(ciphertext ?? '', 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;

    expect(() =>
      encryptor.decrypt(
        [version, iv, tag, flipped.toString('base64')].join(':'),
        CONTEXT,
      ),
    ).toThrow(DecryptionError);
  });

  it('refuses a tampered authentication tag', () => {
    const envelope = encryptor.encrypt('12 Acacia Avenue', CONTEXT);
    const [version, iv, , ciphertext] = envelope.split(':');
    const forged = Buffer.alloc(16, 1).toString('base64');

    expect(() =>
      encryptor.decrypt([version, iv, forged, ciphertext].join(':'), CONTEXT),
    ).toThrow(DecryptionError);
  });

  it.each([
    ['plaintext that was never encrypted', '12 Acacia Avenue'],
    ['an empty string', ''],
    ['a future envelope version', 'v2:aXY=:dGFn:Y2lwaGVy'],
    ['too few parts', 'v1:aXY=:dGFn'],
  ])('refuses %s', (_label, stored) => {
    expect(() => encryptor.decrypt(stored, CONTEXT)).toThrow(DecryptionError);
  });

  it('never echoes the stored value in the error', () => {
    // An error string carrying the ciphertext ends up in a log, which is the
    // one place the encrypted column exists to keep it out of.
    const envelope = encryptor.encrypt('12 Acacia Avenue', CONTEXT);
    try {
      encryptor.decrypt(envelope, 'wrong-context');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(envelope);
    }
  });
});
