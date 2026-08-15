import { Postcode } from '@platform/core';

/**
 * The district we would publish, derived from what somebody has actually typed.
 *
 * **This exists because the listing forms used to name a district nobody had
 * entered.** Both of them carried the sentence "Only the first part — `BS7` — is
 * ever published" with `BS7` written into the markup, copied from the
 * placeholder. It happened to be right for an owner in Horfield and wrong for
 * everybody else: session 43 typed `BS1 5TR` and was told their district was
 * `BS7`. The saved data was correct throughout — only the reassurance was false,
 * which is the worst way for it to be wrong, because a promise about privacy is
 * the one thing a reader has no way to check.
 *
 * **A component rather than a copied branch**, because the same mistake is one
 * paste away in the next form that collects an address, and there are already
 * three. `DistrictPreview` in `profile-form.tsx` does the same job in the
 * profile's own words; the two are deliberately not merged, because a listing is
 * *published* and a profile is *shown*, and flattening that would lose a
 * distinction somebody chose.
 *
 * **The fallback is the honest one.** `Postcode.outwardCode` throws on anything
 * it does not recognise, so validity is checked first and a half-typed postcode
 * gets the general sentence rather than a guess or an error.
 */
export function OutwardCodePreview({ postcode }: { readonly postcode: string }) {
  const typed = postcode.trim();

  if (typed !== '' && Postcode.isValid(typed)) {
    return (
      <>
        Only the first part — <strong>{Postcode.outwardCode(typed)}</strong> — is ever
        published.
      </>
    );
  }

  return <>Only the first part — the bit before the space — is ever published.</>;
}
