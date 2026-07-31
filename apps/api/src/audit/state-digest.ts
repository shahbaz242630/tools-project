import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Reducing a piece of state to a fingerprint the audit log can store.
 *
 * BRD §6.2 records a *hash* of the state before and after a change, rather than
 * the state itself — so the log proves that something changed without becoming
 * a second, longer-lived copy of the personal data it audits. That matters more
 * than it first appears: §10.1 retains security logs for a year hot and six
 * years cold, while the underlying record is erasable on request. Storing
 * values here would quietly invert that.
 *
 * **Keyed, not a bare hash, and that is a deliberate departure from the word
 * the BRD uses.** A display name has a tiny value space — anyone holding this
 * table could hash their way through a list of plausible names and recover it,
 * which would make the digest protection theatre. An HMAC under a key the
 * database does not hold still compares equal for equal inputs, which is all
 * change-detection needs, and tells an offline attacker nothing. ADR 0017.
 */

/**
 * Purpose separation. The same master secret also encrypts addresses, and using
 * one key for two jobs means a weakness in either implicates both. HKDF gives
 * an independent key per purpose from one secret the operator has to manage —
 * the alternative was a second environment variable, which is a real
 * operational cost for a two-person team and one more thing to lose.
 *
 * Versioned, so a future change to what is digested can rotate this string
 * rather than silently making old and new entries incomparable.
 */
const PURPOSE = 'audit-state-digest-v1';

const DIGEST = 'sha256';
const KEY_BYTES = 32;

export interface StateDigest {
  /** A digest of `state`, stable across key order and process restarts. */
  of(state: unknown): string;
}

/**
 * Canonical JSON: object keys sorted, recursively.
 *
 * Without this, `{a, b}` and `{b, a}` digest differently and every audit entry
 * claims a change that never happened — the failure would look like the audit
 * log working, which is the worst kind.
 *
 * `undefined` members are dropped, matching `JSON.stringify`, so an absent
 * field and an explicitly-undefined one are the same state. `null` is kept,
 * because "cleared" is a real change from "was set".
 */
function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    // Order is meaningful in an array and is preserved. Sorting here would
    // hide a reordering, which for something like a permissions list is
    // precisely the change worth auditing.
    return value.map(canonicalise);
  }

  // A structural check rather than `instanceof Date`, which the project bans
  // for a good reason and which is also wrong across realms — a Date from
  // another context fails it and would be canonicalised as an empty object.
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return (value as { toISOString: () => string }).toISOString();
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, member]) => [key, canonicalise(member)]),
  );
}

export function createStateDigest(masterKeyBase64: string): StateDigest {
  const master = Buffer.from(masterKeyBase64, 'base64');

  // Checked here as well as in the env schema, for the same reason the field
  // encryptor checks: the schema guards configuration, this guards every other
  // caller — tests especially, where a short key gets introduced by accident.
  if (master.length !== KEY_BYTES) {
    throw new Error(
      `Digest key must be ${String(KEY_BYTES)} bytes, got ${String(master.length)}`,
    );
  }

  // No salt. HKDF's salt defends against a low-entropy input; ours is 32 random
  // bytes, and a per-call salt would make two digests of the same state differ,
  // destroying the only property this needs to have.
  const key = Buffer.from(
    hkdfSync(DIGEST, master, Buffer.alloc(0), Buffer.from(PURPOSE, 'utf8'), KEY_BYTES),
  );

  return {
    of(state: unknown): string {
      return createHmac(DIGEST, key)
        .update(JSON.stringify(canonicalise(state)) ?? 'undefined')
        .digest('hex');
    },
  };
}
