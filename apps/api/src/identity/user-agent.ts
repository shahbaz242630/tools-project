/**
 * Reading a browser and a device out of a user-agent string.
 *
 * **This exists because the webhook does not carry what the Backend API does.**
 * Clerk's `Session` object from the Backend API has a `latest_activity` holding
 * a parsed browser, device, city and country. The *webhook* has none of it — it
 * carries `event_attributes.http_request` with a raw user agent and an IP, and
 * nothing else. Slice 1.11a was written against the wrong one of those two
 * shapes (ADR 0025's correction).
 *
 * **The raw string is deliberately not stored.** A full user agent is a
 * fingerprint, and BRD §10's minimisation says hold what has a purpose. The
 * purpose here is a person recognising their own sign-in — "Edge on Windows"
 * does that; the version of AppleWebKit does not. So it is parsed on the way in
 * and discarded, the same trade ADR 0016 made storing a postal district rather
 * than an address.
 *
 * **Deliberately crude, and that is a decision rather than a shortcut.** Proper
 * user-agent parsing needs a maintained database of thousands of strings; every
 * library that does it well is a dependency that has to be kept current forever
 * to stay accurate. What this needs to answer is narrower: would the person
 * recognise this as them. Getting "Edge on Windows" right for the overwhelming
 * majority and returning null for the rest is worth more than a dependency, and
 * null renders honestly as "not recorded".
 */

export interface ParsedUserAgent {
  readonly browserName: string | null;
  readonly browserVersion: string | null;
  readonly deviceType: string | null;
  readonly isMobile: boolean | null;
}

export const UNKNOWN_USER_AGENT: ParsedUserAgent = {
  browserName: null,
  browserVersion: null,
  deviceType: null,
  isMobile: null,
};

/**
 * Order matters and is the whole subtlety of this table.
 *
 * Edge reports itself as `Chrome/… Edg/…` and Chrome reports itself as
 * `Safari/…`, so a naive check in the wrong order labels every Edge user as
 * Chrome and every Chrome user as Safari. Most specific first.
 *
 * **The major version only**, deliberately. A real Edge string carries
 * `150.0.0.0`; the trailing build numbers add nothing to "would you recognise
 * this sign-in" and are exactly the fingerprinting detail the note above says
 * to discard. `150` distinguishes a current browser from a badly out-of-date
 * one, which is the only security question the version answers.
 */
const BROWSERS: readonly { readonly name: string; readonly token: RegExp }[] = [
  { name: 'Edge', token: /Edg(?:e|A|iOS)?\/(\d+)/ },
  { name: 'Opera', token: /OPR\/(\d+)/ },
  { name: 'Samsung Internet', token: /SamsungBrowser\/(\d+)/ },
  { name: 'Firefox', token: /(?:Firefox|FxiOS)\/(\d+)/ },
  { name: 'Chrome', token: /(?:Chrome|CriOS)\/(\d+)/ },
  { name: 'Safari', token: /Version\/(\d+).*Safari\// },
];

/**
 * Platforms, most specific first for the same reason.
 *
 * An iPad reports `Macintosh` in desktop mode and Android tablets report
 * `Android` without `Mobile`, so the mobile flag is derived separately from the
 * platform rather than inferred from it.
 */
const PLATFORMS: readonly { readonly name: string; readonly token: RegExp }[] = [
  { name: 'Android', token: /Android/ },
  { name: 'iPhone', token: /iPhone/ },
  { name: 'iPad', token: /iPad/ },
  { name: 'Windows', token: /Windows NT/ },
  { name: 'macOS', token: /Macintosh|Mac OS X/ },
  { name: 'Linux', token: /Linux/ },
];

export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  if (typeof userAgent !== 'string' || userAgent.trim() === '') {
    return UNKNOWN_USER_AGENT;
  }

  let browserName: string | null = null;
  let browserVersion: string | null = null;
  for (const browser of BROWSERS) {
    const match = browser.token.exec(userAgent);
    if (match !== null) {
      browserName = browser.name;
      browserVersion = match[1] ?? null;
      break;
    }
  }

  let deviceType: string | null = null;
  for (const platform of PLATFORMS) {
    if (platform.token.test(userAgent)) {
      deviceType = platform.name;
      break;
    }
  }

  // Null rather than false when nothing was recognised: "we could not tell" and
  // "it was a desktop" are different claims, and only one of them is honest
  // about a string we failed to parse.
  const isMobile =
    deviceType === null ? null : /Mobile|iPhone|Android|iPad|Tablet/.test(userAgent);

  return { browserName, browserVersion, deviceType, isMobile };
}
