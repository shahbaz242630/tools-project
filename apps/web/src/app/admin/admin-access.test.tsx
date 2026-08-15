import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdminAccessNotice, accessFrom } from './admin-access';

/**
 * **The defect this pins:** four admin pages drew enabled write controls to
 * callers the API was certain to refuse — the exact thing slice 2.1 fixed on
 * `/admin/categories`, still present on approvals, users, activity and listing
 * moderation. Two of those performed no read at all, so nothing on the page
 * could refuse before the button did.
 */
describe('accessFrom', () => {
  it('treats a successful read as permission, because it is the same guard', () => {
    expect(accessFrom({ kind: 'loaded' })).toEqual({ kind: 'permitted' });
  });

  it.each(['signed-out', 'forbidden'])('passes %s through unchanged', (kind) => {
    expect(accessFrom({ kind })).toEqual({ kind });
  });

  it('does not read a failure as permission', () => {
    // The direction that matters. Anything other than a clean read has to land
    // on the side that withholds the control, because a page that guesses "yes"
    // is the dead control all over again.
    expect(accessFrom({ kind: 'unreachable', reason: 'socket hang up' })).toEqual({
      kind: 'unknown',
      reason: 'socket hang up',
    });
  });

  it('names an outcome it did not expect rather than swallowing it', () => {
    expect(accessFrom({ kind: 'not-found' })).toEqual({
      kind: 'unknown',
      reason: 'unexpected response (not-found)',
    });
  });
});

describe('AdminAccessNotice', () => {
  it('distinguishes a missing second factor from a missing session', () => {
    render(<AdminAccessNotice access={{ kind: 'forbidden' }} controls="the form" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('second factor');
    expect(alert).toHaveTextContent('the form');
    expect(alert).not.toHaveTextContent('expired');
  });

  it('does not claim a session expired when there may never have been one', () => {
    render(<AdminAccessNotice access={{ kind: 'signed-out' }} controls="the form" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('You are not signed in');
    expect(alert).toHaveTextContent('may have expired');
  });

  it('says nothing changed when it could not tell', () => {
    render(
      <AdminAccessNotice
        access={{ kind: 'unknown', reason: 'no response within 5000ms' }}
        controls="the switches"
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('could not check');
    expect(alert).toHaveTextContent('no response within 5000ms');
    expect(alert).toHaveTextContent('Nothing has been changed');
  });
});
