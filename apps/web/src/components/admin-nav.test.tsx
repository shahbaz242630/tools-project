import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ADMIN_SURFACES, AdminNav } from './admin-nav';

/**
 * **The defect this pins:** six administrative pages each carried their own
 * hand-written list of links to the other five, and three of them had already
 * lost an entry — `/admin/approvals` had no Feature flags, and `/admin/categories`
 * and `/admin/feature-flags` had no Activity. A missing link is invisible on a
 * surface nobody can browse to, so nothing surfaced the drift.
 */
describe('AdminNav', () => {
  it('offers every administrative surface, on every page', () => {
    render(<AdminNav current="/admin/categories" />);

    for (const surface of ADMIN_SURFACES) {
      expect(screen.getByText(surface.label)).toBeInTheDocument();
    }
  });

  it.each(ADMIN_SURFACES.map((surface) => surface.href))(
    'links to every other surface from %s',
    (current) => {
      render(<AdminNav current={current} />);

      for (const surface of ADMIN_SURFACES) {
        if (surface.href === current) continue;
        expect(screen.getByRole('link', { name: surface.label })).toHaveAttribute(
          'href',
          surface.href,
        );
      }
    },
  );

  it('marks where you are rather than dropping it from the list', () => {
    render(<AdminNav current="/admin/users" />);

    // Present, so the set of six reads the same everywhere — and not a link,
    // because a link to the page you are on is a control that does nothing.
    expect(screen.getByText('Account lookup')).toHaveAttribute('aria-current', 'page');
    expect(
      screen.queryByRole('link', { name: 'Account lookup' }),
    ).not.toBeInTheDocument();
  });

  it('always offers the way back out', () => {
    render(<AdminNav current="/admin/listings" />);

    expect(screen.getByRole('link', { name: 'All administration' })).toHaveAttribute(
      'href',
      '/admin',
    );
    expect(screen.getByRole('link', { name: 'Back to your account' })).toHaveAttribute(
      'href',
      '/account',
    );
  });

  it('does not link the index to itself', () => {
    render(<AdminNav current="/admin" />);

    expect(screen.getByText('Administration')).toHaveAttribute('aria-current', 'page');
    expect(
      screen.queryByRole('link', { name: 'All administration' }),
    ).not.toBeInTheDocument();
  });

  it('links everything when the caller names no page', () => {
    render(<AdminNav />);

    expect(screen.getAllByRole('link')).toHaveLength(ADMIN_SURFACES.length + 2);
  });

  it('describes each surface by what it is for', () => {
    // The blurbs are what `/admin` renders. An empty one would make the index a
    // list of six words nobody can choose between.
    for (const surface of ADMIN_SURFACES) {
      expect(surface.blurb.length).toBeGreaterThan(40);
    }
  });
});
