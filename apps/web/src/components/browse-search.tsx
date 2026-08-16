import { MAX_SEARCH_KEYWORD_LENGTH, SEARCH_RADII_MILES } from '@platform/contracts';
import type { PublicCategory, SearchRadiusMiles } from '@platform/contracts';
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
  category,
  categories,
  keyword,
  keywordField,
  error,
  className,
}: {
  /** What was searched for, so the field is not cleared by its own results. */
  readonly postcode: string;
  readonly radiusMiles: SearchRadiusMiles;
  /**
   * Which category the search is narrowed to, or null for all (slice 3.2a).
   *
   * **It survives every submission**, whether or not there is a control for it.
   * A form that dropped it would mean changing the radius silently widened the
   * search to every category — a control quietly undoing a filter the address
   * bar still claims, which is worse than having no filter at all because it
   * looks like it worked.
   */
  readonly category: string | null;
  /**
   * What the filter may be set to (slice 3.2b).
   *
   * **Empty means no control, and that is a real state rather than a
   * placeholder.** Two callers pass it empty on purpose: the landing hero, which
   * asks the one question it must and would otherwise put a second decision in
   * front of somebody who has not made the first (3.1e's reasoning); and Browse
   * itself when the category read failed, because search does not depend on this
   * list and a page that refused to render results over an unpopulated `select`
   * would turn a cosmetic outage into a total one.
   *
   * **The filter still survives an empty list** — through the hidden field
   * below — so a URL carrying a category is not silently widened by a category
   * read that happened to fail.
   */
  readonly categories: readonly PublicCategory[];
  /**
   * The words the search is narrowed by, or null for none (slice 3.3b).
   *
   * Echoed back into the field so a search that found nothing does not also
   * clear what was typed — the same reason `postcode` is echoed, and it matters
   * more here: retyping a postcode is eight characters and retyping a phrase is
   * the moment somebody gives up.
   *
   * **This is the *trimmed* value the API answered**, not the raw parameter.
   * `BrowseResults` reads it from the response for that reason; this form is
   * handed the parsed query, which has already been through the same schema.
   */
  readonly keyword: string | null;
  /**
   * Whether to draw a control for it (slice 3.3b).
   *
   * **Required rather than defaulted, because the two callers genuinely differ
   * and a default would decide it for whichever one was written second.** Browse
   * draws it; the landing hero deliberately does not.
   *
   * The hero's reasoning is slice 3.1e's, unchanged: it asks the one question
   * that must be answered before anything can happen, and a second box in front
   * of somebody who has not yet given us a postcode is a second decision to make
   * on a page whose whole job is to get them to a search. A keyword is optional
   * in a way a postcode is not. **Adding it to the hero is a reasonable product
   * change and a deliberate one** — it is not something to slip in here.
   *
   * There is no hidden-field branch, which is where this differs from
   * `categories`: the hero is an entry point and has no keyword to preserve,
   * because nothing that links to it carries one.
   */
  readonly keywordField: boolean;
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
      /*
        **The keyword modifier is part of the base class rather than something a
        caller passes**, so a form that draws the field cannot be laid out as
        though it did not. `className` stays what it was in 3.1e — the hero's
        own layout, applied on top.
      */
      className={[
        styles.search,
        keywordField ? styles.searchWithKeyword : undefined,
        className,
      ]
        .filter((name) => name !== undefined)
        .join(' ')}
      action={BROWSE_PATH}
      method="get"
      role="search"
    >
      {keywordField && (
        <div className={styles.keywordField}>
          <label htmlFor="keyword">What are you looking for?</label>
          {/*
            **Optional, and the only field on this form that is.** A search with
            no words is the ordinary case — it is what "show me everything near
            me" looks like — so this is never `required` and an empty box is not
            an error. `searchKeywordSchema` swallows the empty `keyword=` that a
            plain GET form submits for exactly that case.

            **A placeholder deliberately naming nothing in the fixture.** The
            postcode field learned this the hard way in 3.1b: its placeholder was
            the local fixture's own postcode, which made the disclosure check on
            the rendered page unreadable because a grep could not tell a leak
            from an example. "Pressure washer" is a plausible tool and is not the
            title of anything we have.

            **No `type="search"`.** It renders a browser-supplied clear button
            whose behaviour and appearance differ per engine, and this form has
            no JavaScript to react to it — clearing the box without submitting
            would leave the results and the field disagreeing.
          */}
          <input
            id="keyword"
            /*
              The contract's parameter name, for the postcode's reason below: a
              name this component invented would be a parameter the API ignores,
              and the failure is a search that quietly returns everything.
            */
            name="keyword"
            type="text"
            defaultValue={keyword ?? ''}
            placeholder="e.g. pressure washer"
            /*
              The opposite of the postcode's settings, and deliberately: this is
              ordinary prose, so autocorrect and sentence casing are help rather
              than hindrance. `maxLength` mirrors the contract's bound so the
              browser refuses what the API would, rather than letting somebody
              type a paragraph and be told no afterwards.
            */
            maxLength={MAX_SEARCH_KEYWORD_LENGTH}
            autoComplete="off"
          />
        </div>
      )}

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

      {categories.length > 0 ? (
        <div className={styles.categoryField}>
          <label htmlFor="category">Category</label>
          {/*
            **"All categories" is an option, not the absence of one**, and its
            value is the empty string — which is exactly why the contract accepts
            an empty `category=` as meaning every category. A plain GET form
            submits every named control, so choosing this sends `category=`, and
            a schema that refused it would 400 the most ordinary search on the
            page. That is the case `searchCategorySchema` exists to swallow.

            **First in the list**, because it is the default and because a filter
            somebody has to scroll to un-set is a filter they end up stuck in.
          */}
          <select id="category" name="category" defaultValue={category ?? ''}>
            <option value="">All categories</option>
            {categories.map((option) => (
              <option key={option.slug} value={option.slug}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        /*
          **No control, but the filter still travels** — a hidden field, which is
          what this was in 3.2a before there was a `select`. Reached in two ways:
          the landing hero, which passes no categories on purpose, and Browse
          when the category read failed. In both, dropping a category the URL
          carries would silently widen the search on the next submission.

          Rendered only when there is a category, rather than always with an
          empty value: emitting `category=` for an unfiltered search would mint a
          second URL for it, which is §8.17's duplicate-content problem arriving
          through a form. The `select` above has the opposite treatment because
          it is a control a person operates, and it needs a way to say "all".
        */
        category !== null && <input type="hidden" name="category" value={category} />
      )}

      {/*
        **No `page` in either branch**, deliberately: submitting the form is a
        new search, and carrying page four into it would land somebody in the
        middle of a set they have not seen the start of. `widerSearchHref` drops
        the page for the same reason.
      */}

      <button type="submit" className={styles.searchSubmit}>
        Search
      </button>
    </form>
  );
}
