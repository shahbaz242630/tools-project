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
    render(
      <BrowseSearch
        postcode=""
        radiusMiles={5}
        error={null}
        category={null}
        categories={[]}
      />,
    );

    const options = screen
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);

    expect(options).toEqual(SEARCH_RADII_MILES.map(String));
  });

  it('defaults to the narrowest radius', () => {
    render(
      <BrowseSearch
        postcode=""
        radiusMiles={5}
        error={null}
        category={null}
        categories={[]}
      />,
    );

    expect(screen.getByLabelText('Within')).toHaveValue('5');
  });

  it('keeps the radius that was searched, rather than resetting it', () => {
    render(
      <BrowseSearch
        postcode="BS7 8AA"
        radiusMiles={50}
        error={null}
        category={null}
        categories={[]}
      />,
    );

    expect(screen.getByLabelText('Within')).toHaveValue('50');
  });

  it('keeps the postcode in the field, so results do not clear the search', () => {
    render(
      <BrowseSearch
        postcode="BS7 8AA"
        radiusMiles={5}
        error={null}
        category={null}
        categories={[]}
      />,
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
      <BrowseSearch
        postcode=""
        radiusMiles={5}
        error={null}
        category={null}
        categories={[]}
      />,
    );
    const form = container.querySelector('form');

    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/browse');
  });

  it('uses the contract’s own parameter names', () => {
    // A renamed field sends a parameter the API ignores, and the failure is an
    // empty results page rather than an error — the quietest kind there is.
    render(
      <BrowseSearch
        postcode=""
        radiusMiles={5}
        error={null}
        category={null}
        categories={[]}
      />,
    );

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
        categories={[]}
      />,
    );

    const field = screen.getByLabelText('Where are you looking?');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Postcode must be a valid UK postcode.');
  });

  it('marks nothing invalid when there is no problem', () => {
    render(
      <BrowseSearch
        postcode="BS7 8AA"
        radiusMiles={5}
        error={null}
        category={null}
        categories={[]}
      />,
    );

    expect(screen.getByLabelText('Where are you looking?')).not.toHaveAttribute(
      'aria-invalid',
    );
  });

  it('is a search landmark, so it can be skipped to', () => {
    render(
      <BrowseSearch
        postcode=""
        radiusMiles={5}
        error={null}
        category={null}
        categories={[]}
      />,
    );

    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  /**
   * The category control (slice 3.2b).
   *
   * **The value of "All categories" is the empty string, and that is the whole
   * reason the contract accepts an empty `category=`.** A plain GET form submits
   * every named control, so choosing it sends `category=` — and a schema that
   * refused that would 400 the most ordinary search on the page. These two facts
   * are separated by three files, which is exactly how they come apart.
   */
  describe('choosing a category', () => {
    const CATEGORIES = [
      { slug: 'outdoor-gardening', name: 'Outdoor and gardening' },
      { slug: 'power-tools', name: 'Power tools' },
    ];

    it('offers every category, with "all" first and selected by default', () => {
      render(
        <BrowseSearch
          postcode=""
          radiusMiles={5}
          category={null}
          categories={CATEGORIES}
          error={null}
        />,
      );

      const control = screen.getByLabelText('Category');
      const options = [...(control as HTMLSelectElement).options].map((option) => [
        option.value,
        option.text,
      ]);

      expect(options).toEqual([
        ['', 'All categories'],
        ['outdoor-gardening', 'Outdoor and gardening'],
        ['power-tools', 'Power tools'],
      ]);
      expect(control).toHaveValue('');
    });

    it('keeps the category that was searched, rather than resetting it', () => {
      render(
        <BrowseSearch
          postcode="BS7 8AA"
          radiusMiles={5}
          category="power-tools"
          categories={CATEGORIES}
          error={null}
        />,
      );

      expect(screen.getByLabelText('Category')).toHaveValue('power-tools');
    });

    it('uses the contract’s own parameter name', () => {
      // A renamed field sends a parameter the API ignores, and the failure is a
      // filter that silently does nothing — the quietest kind there is.
      render(
        <BrowseSearch
          postcode=""
          radiusMiles={5}
          category={null}
          categories={CATEGORIES}
          error={null}
        />,
      );

      expect(screen.getByLabelText('Category')).toHaveAttribute('name', 'category');
    });

    /*
     * **Renders no control at all rather than an empty one.** Two callers reach
     * this: the landing hero, which asks the one question it must, and Browse
     * when the category read failed. A `select` whose only option is "All
     * categories" is a control that cannot do anything — BRD §15's dead control
     * with the lights on.
     */
    it('renders no control when there are no categories', () => {
      render(
        <BrowseSearch
          postcode=""
          radiusMiles={5}
          category={null}
          categories={[]}
          error={null}
        />,
      );

      expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    });

    /*
     * **And the filter still survives that**, which is the case worth pinning:
     * a category read that fails must not silently widen a search the URL says
     * is narrow.
     */
    it('still carries a filter when the control could not be drawn', () => {
      const { container } = render(
        <BrowseSearch
          postcode="BS7 8AA"
          radiusMiles={5}
          category="power-tools"
          categories={[]}
          error={null}
        />,
      );

      expect(container.querySelector('input[name="category"]')).toHaveValue(
        'power-tools',
      );
    });

    it('does not render both a control and a hidden field', () => {
      // Two inputs of the same name submit twice, and the page takes the first —
      // so the person's choice would lose to the value they were changing.
      const { container } = render(
        <BrowseSearch
          postcode="BS7 8AA"
          radiusMiles={5}
          category="power-tools"
          categories={CATEGORIES}
          error={null}
        />,
      );

      expect(container.querySelectorAll('[name="category"]')).toHaveLength(1);
    });
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
          categories={[]}
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
          categories={[]}
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
          categories={[]}
        />,
      );

      expect(container.querySelector('input[name="page"]')).toBeNull();
    });
  });
});
