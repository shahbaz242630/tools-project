import { render, screen } from '@testing-library/react';
import { SEARCH_RADII_MILES } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { BrowseSearch } from './browse-search';

describe('the search controls', () => {
  it('offers exactly the five radii BRD §8.4 names, and no others', () => {
    /*
     * **The closed vocabulary is a privacy control, not a tidy `select`.** An
     * arbitrary radius lets somebody binary-search a listing's distance from an
     * origin they chose — 1 mile, then 2, then 3 — which is the trilateration
     * attack §8.4.1 opens by describing. This asserts the whole list rather than
     * a sample, so adding a sixth option fails here.
     */
    render(<BrowseSearch postcode="" radiusMiles={5} error={null} category={null} />);

    const options = screen
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);

    expect(options).toEqual(SEARCH_RADII_MILES.map(String));
  });

  it('defaults to the narrowest radius', () => {
    render(<BrowseSearch postcode="" radiusMiles={5} error={null} category={null} />);

    expect(screen.getByLabelText('Within')).toHaveValue('5');
  });

  it('keeps the radius that was searched, rather than resetting it', () => {
    render(
      <BrowseSearch postcode="BS7 8AA" radiusMiles={50} error={null} category={null} />,
    );

    expect(screen.getByLabelText('Within')).toHaveValue('50');
  });

  it('keeps the postcode in the field, so results do not clear the search', () => {
    render(
      <BrowseSearch postcode="BS7 8AA" radiusMiles={5} error={null} category={null} />,
    );

    expect(screen.getByLabelText('Where are you looking?')).toHaveValue('BS7 8AA');
  });

  it('submits to the browse page as a GET, so results are shareable', () => {
    /*
     * **A plain GET form and no JavaScript.** It is what makes the result URL
     * bookmarkable, the back button work, and the page usable before hydration —
     * which matters most on the one page a stranger meets first.
     */
    const { container } = render(
      <BrowseSearch postcode="" radiusMiles={5} error={null} category={null} />,
    );
    const form = container.querySelector('form');

    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/browse');
  });

  it('uses the contract’s own parameter names', () => {
    // A renamed field sends a parameter the API ignores, and the failure is an
    // empty results page rather than an error — the quietest kind there is.
    render(<BrowseSearch postcode="" radiusMiles={5} error={null} category={null} />);

    expect(screen.getByLabelText('Where are you looking?')).toHaveAttribute(
      'name',
      'postcode',
    );
    expect(screen.getByLabelText('Within')).toHaveAttribute('name', 'radiusMiles');
  });

  it('shows a problem against the field rather than at the top of the page', () => {
    render(
      <BrowseSearch
        postcode="nonsense"
        radiusMiles={5}
        error="Postcode must be a valid UK postcode."
        category={null}
      />,
    );

    const field = screen.getByLabelText('Where are you looking?');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Postcode must be a valid UK postcode.');
  });

  it('marks nothing invalid when there is no problem', () => {
    render(
      <BrowseSearch postcode="BS7 8AA" radiusMiles={5} error={null} category={null} />,
    );

    expect(screen.getByLabelText('Where are you looking?')).not.toHaveAttribute(
      'aria-invalid',
    );
  });

  it('is a search landmark, so it can be skipped to', () => {
    render(<BrowseSearch postcode="" radiusMiles={5} error={null} category={null} />);

    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  /**
   * Carrying the category across a submission (slice 3.2a).
   *
   * **The filter is reachable by URL before it has a control**, so this form is
   * the one place it can be silently lost: change the radius, submit, and a
   * search that claimed one category quietly becomes a search of all of them.
   * That failure renders perfectly and reports nothing, which is why it is
   * pinned here rather than left to 3.2b's `select`.
   */
  describe('the category it was searched with', () => {
    it('is carried through the form, so changing the radius does not drop it', () => {
      const { container } = render(
        <BrowseSearch
          postcode="BS7 8AA"
          radiusMiles={5}
          category="outdoor-gardening"
          error={null}
        />,
      );

      expect(container.querySelector('input[name="category"]')).toHaveValue(
        'outdoor-gardening',
      );
    });

    /*
     * **Absent rather than empty.** `?category=` means the same as no parameter
     * at all, but emitting it would put a second URL in front of every
     * unfiltered search — §8.17's duplicate-content problem arriving through a
     * form rather than through a link.
     */
    it('emits no category field at all when there is no filter', () => {
      const { container } = render(
        <BrowseSearch
          postcode="BS7 8AA"
          radiusMiles={5}
          category={null}
          error={null}
        />,
      );

      expect(container.querySelector('input[name="category"]')).toBeNull();
    });

    /*
     * **And no page field either.** Submitting the form is a new search, so
     * carrying page four into it would land somebody in the middle of a set they
     * have not seen the start of.
     */
    it('never carries a page, because submitting is a new search', () => {
      const { container } = render(
        <BrowseSearch
          postcode="BS7 8AA"
          radiusMiles={5}
          category="outdoor-gardening"
          error={null}
        />,
      );

      expect(container.querySelector('input[name="page"]')).toBeNull();
    });
  });
});
