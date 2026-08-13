/**
 * How Clerk's own screens are made to look like the rest of the site (slice D8).
 *
 * **The prebuilt components, themed — not custom forms.** The handoff offers
 * both: rebuild sign-in with Clerk Elements, or keep `<SignIn/>` and theme it.
 * Elements would mean owning the password field, the OAuth button, the
 * verification step, the error strings and every future factor Clerk adds — a
 * surface where a mistake is an authentication bug rather than a visual one, on
 * the one flow this application cannot afford to get wrong. Theming is the
 * smaller commitment and the reversible one.
 *
 * **These values are the design tokens, written out.** They cannot read
 * `globals.css`: Clerk takes them as JavaScript and applies them to elements
 * inside its own tree, before our stylesheet has anything to say about them. So
 * this file is a second home for four colours, which is a cost worth naming —
 * if a token here disagrees with `globals.css`, the sign-in page is the page
 * that will look wrong, and nothing will fail.
 *
 * The font is referenced by family name rather than through the CSS variable
 * `next/font` publishes, because Clerk composes this into inline styles where
 * `var(--font-instrument-sans)` resolves against the wrong scope. The family is
 * loaded by then, so naming it works; the fallback is there for the moment
 * before it is.
 */
/*
 * **Not typed as `Appearance`, because that lives in `@clerk/types`** — a
 * transitive package this app does not declare, and the repository rule is to
 * ask before adding a dependency. It is checked where it is used instead: the
 * `appearance` prop on `<ClerkProvider>` gives the same error on a wrong key,
 * at the point that actually matters.
 */

/** `--accent`, as `globals.css` defines it. */
const ACCENT = 'oklch(0.4 0.09 255)';

export const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: ACCENT,
    colorText: '#1c1b19',
    colorBackground: '#ffffff',
    colorInputBackground: '#ffffff',
    colorDanger: '#9a3b2e',
    borderRadius: '10px',
    fontFamily: '"Instrument Sans", ui-sans-serif, system-ui, sans-serif',
  },
  elements: {
    card: {
      borderRadius: '16px',
      border: '1px solid #eceae5',
      boxShadow: '0 8px 28px rgb(28 27 25 / 6%)',
    },
    /*
     * Clerk's own footer advertises Clerk. It is left alone deliberately: the
     * free plan's terms require the branding, and hiding it with CSS would be
     * breaking an agreement in a way that looks like a styling choice.
     */
  },
};
