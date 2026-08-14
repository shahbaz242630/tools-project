import { SEARCH_RADII_MILES } from '@platform/contracts';
import type { SearchRadiusMiles } from '@platform/contracts';
import { BROWSE_PATH } from '../lib/page-paths';
import styles from './browse.module.css';

/**
 * The search controls (slice 3.1b).
 *
 * **A plain `GET` form with no JavaScript at all**, and that is the design
 * rather than a limitation. Three things follow from it and each would have to
 * be rebuilt if this became a client component: the result URL is shareable and
 * bookmarkable, the back button works, and the page functions before hydration —
 * which matters most here, because this is the entry point for somebody who has
 * never been to the site and is the page a crawler meets (§8.17).
 *
 * **It posts to the API's own route shape**, `/browse?postcode=…&radiusMiles=…`,
 * so the query string the browser builds is the one the page parses with the
 * contract's schema. The field names are the contract's, not this component's.
 *
 * **From slice 3.1e it is also the landing page's hero pill**, which is why it
 * takes a `className` rather than being copied. A second search form would be a
 * second place for `postcode` to drift into `location` — and the failure mode of
 * that drift is an empty results page rather than an error, which is the
 * quietest kind. Everything worth getting right lives here once: the contract's
 * field names, §8.4's closed radius vocabulary, the placeholder that is
 * deliberately nobody's postcode, and the error shown against its own field.
 */
export function BrowseSearch({
  postcode,
  radiusMiles,
  error,
  className,
}: {
  /** What was searched for, so the field is not cleared by its own results. */
  readonly postcode: string;
  readonly radiusMiles: SearchRadiusMiles;
  /** What was wrong with it, shown against the field rather than at the top. */
  readonly error: string | null;
  /**
   * Layout only — the hero lays this out differently from the search page.
   *
   * `| undefined` explicitly, because `exactOptionalPropertyTypes` is on and a
   * CSS module's class is typed `string | undefined`: without it, passing
   * `styles.heroSearch` is a type error rather than the ordinary thing it is.
   */
  readonly className?: string | undefined;
}) {
  return (
    <form
      className={
        className === undefined ? styles.search : `${styles.search} ${className}`
      }
      action={BROWSE_PATH}
      method="get"
      role="search"
    >
      <div className={styles.searchField}>
        <label htmlFor="postcode">Where are you looking?</label>
        <input
          id="postcode"
          /*
            The contract's parameter name. Renaming it here would send a
            parameter the API ignores, and the failure is an empty results page
            rather than an error — the quietest kind.
          */
          name="postcode"
          type="text"
          defaultValue={postcode}
          /*
            **Deliberately a postcode no listing will ever have.** SW1A 1AA is
            Buckingham Palace — famous enough to read as an example rather than
            as somebody's address. It started as `BS7 8AA`, which is the local
            fixture's own postcode, and that made the disclosure check on the
            rendered page unreadable: a grep for the listing's postcode matched
            this placeholder and could not tell a leak from an example.
          */
          placeholder="e.g. SW1A 1AA"
          autoComplete="postal-code"
          /*
            `autoCapitalize` and `spellCheck` because a postcode is neither a
            sentence nor a word: a phone keyboard offering autocorrect on "BS7"
            is how somebody ends up searching for "BS& 8AA".
          */
          autoCapitalize="characters"
          spellCheck={false}
          required
          aria-describedby={error === null ? undefined : 'postcode-error'}
          aria-invalid={error === null ? undefined : true}
        />
        {error !== null && (
          <p id="postcode-error" className={styles.fieldError} role="alert">
            {error}
          </p>
        )}
      </div>

      <div className={styles.radiusField}>
        <label htmlFor="radiusMiles">Within</label>
        {/*
          **A `select` of exactly BRD §8.4's five values, and not a slider or a
          free number.** The closed vocabulary is a privacy control rather than a
          UI simplification — an arbitrary radius lets somebody binary-search a
          listing's distance from an origin they chose. The options are read from
          the contract, so this cannot drift from what the API accepts.
        */}
        <select id="radiusMiles" name="radiusMiles" defaultValue={String(radiusMiles)}>
          {SEARCH_RADII_MILES.map((miles) => (
            <option key={miles} value={String(miles)}>
              {miles} miles
            </option>
          ))}
        </select>
      </div>

      <button type="submit" className={styles.searchSubmit}>
        Search
      </button>
    </form>
  );
}
