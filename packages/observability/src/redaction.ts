/**
 * Redaction for anything heading into a log.
 *
 * Logs leak. They are shipped to third-party aggregators, pasted into tickets,
 * screenshotted into chat and retained long after the request is forgotten.
 * Treating the log pipeline as a place secrets must never reach is far cheaper
 * than trying to purge them afterwards.
 *
 * Two categories are redacted here, and the second is easy to overlook:
 *
 * 1. Credentials — passwords, tokens, keys, card data.
 * 2. Personal data that our own privacy design turns into a hazard. A listing's
 *    precise coordinates are deliberately withheld from the public API
 *    (BRD §8.4.1) so an owner's home address cannot be trilaterated. Logging
 *    them re-creates exactly the exposure that design prevents.
 */

export const REDACTED = '[redacted]';

/** Matched against object keys, case-insensitively, as substrings. */
const SENSITIVE_KEY_PATTERNS = [
  // Credentials and authentication
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'cookie',
  'session',
  'credential',
  'privatekey',
  'private_key',
  /*
   * The machine-to-machine trigger header (ADR 0048, slice 4.7b).
   *
   * **Here rather than only at the one call site, because it is a *key* and this is
   * where keys are judged.** It normalises to `xinternaltrigger`, which matches none
   * of the words above — so without this entry a log line carrying the header would
   * print the shared secret in full, and the redaction that exists for exactly this
   * would sail past it.
   *
   * It earns its place because the header travels in an **outbound** request, and an
   * error thrown from `fetch` can carry that request on its `cause` — which
   * `redact` deliberately recurses into. So the path from "a connection failed" to
   * "the secret is in Loki" is short, and the worker's own `failed` handler logs the
   * whole error object.
   */
  'x-internal-trigger',

  // Payment data. Never stored (BRD §8.7) but may appear in provider payloads.
  'cardnumber',
  'card_number',
  'cvv',
  'cvc',
  'pan',
  'iban',
  'sortcode',
  'sort_code',
  'accountnumber',
  'account_number',

  // Identity and tax data (BRD §8.14.2)
  'nationalinsurance',
  'national_insurance',
  'nino',
  'taxidentifier',
  'tax_identifier',
  'dateofbirth',
  'date_of_birth',
  'dob',
  'passportnumber',
  'passport_number',

  // Precise location. See the note above — this is not paranoia, it is the
  // same requirement as §8.4.1 applied to a different output channel.
  'latitude',
  'longitude',
  'coordinates',
  'addressline',
  'address_line',
];

/** Connection strings and URLs carrying inline credentials. */
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s]+@/gi;

/** Bearer tokens and similar, wherever they appear in free text. */
const BEARER_PATTERN = /\b(bearer|basic)\s+[\w\-._~+/]+=*/gi;

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s]/g, '');
  return SENSITIVE_KEY_PATTERNS.some((pattern) =>
    normalised.includes(pattern.replace(/[-_]/g, '')),
  );
}

/** Strip inline credentials from a string without destroying its usefulness. */
export function redactString(value: string): string {
  return value
    .replace(URL_CREDENTIAL_PATTERN, `$1:${REDACTED}@`)
    .replace(BEARER_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`);
}

/**
 * Deep-redact a value for logging.
 *
 * Cycles are tolerated rather than throwing: a logger that crashes on a
 * self-referencing object turns a diagnostic into an outage.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);

  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
      ...(value.cause !== undefined ? { cause: redact(value.cause, seen) } : {}),
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redact(entry, seen);
  }
  return output;
}
