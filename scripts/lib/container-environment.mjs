/**
 * Reading configuration out of the compose file and the env file on the box.
 *
 * Pure string work, in its own module so it can be tested without importing
 * `deploy.mjs` — which calls `main()` at import time, so a test that reached for
 * it would run the deploy's entry point as a side effect of loading a function.
 *
 * These back the deploy's "do the running containers carry what is on disk"
 * check. It exists because of 25 August 2026, when two variables were right in
 * `staging.env`, right in the compose file, and correctly resolved by
 * `docker compose config` — and empty inside the running API, because the
 * containers predated the edit. Health, readiness and the image tag all said the
 * deploy had worked. `docker exec printenv` was the only thing that could tell.
 */

/**
 * Variables the compose file passes straight through under the same name.
 *
 * Only those, because only for those does "the env file says X" mean "the
 * container must say X". Where compose builds a value — `POSTGRES_URL` from
 * parts, say — the container's key and the file's key are different things and
 * comparing them would be nonsense.
 */
export function passThroughKeysIn(text) {
  const keys = new Set();

  for (const line of text.split(/\r?\n/)) {
    const matched = line.match(/^ {6}([A-Z][A-Z0-9_]*):\s*\$\{([A-Z][A-Z0-9_]*)[:}]/);
    if (matched && matched[1] === matched[2]) keys.add(matched[1]);
  }

  return keys;
}

/** `KEY=value` pairs with a non-empty value. Quotes and comments ignored. */
export function envFileValuesIn(text) {
  const values = new Map();

  for (const line of text.split(/\r?\n/)) {
    const matched = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!matched) continue;
    const value = matched[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (value !== '') values.set(matched[1], value);
  }

  return values;
}
