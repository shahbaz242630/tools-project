import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeletionExplanation } from './deletion-explanation';

/**
 * These assertions exist because BRD §10.1 makes the explanation a requirement:
 * the workflow *must* distinguish erasable personal data from retained records
 * and explain the distinction. A page that quietly stopped saying so would
 * still work and would no longer comply, which is exactly the kind of
 * regression a test has to catch.
 */
describe('DeletionExplanation', () => {
  it('names what is erased', () => {
    render(<DeletionExplanation />);

    expect(screen.getByText(/what is deleted/i)).toBeInTheDocument();
    expect(screen.getByText(/display name/i)).toBeInTheDocument();
    expect(screen.getByText(/phone number/i)).toBeInTheDocument();
    expect(screen.getByText(/encrypted street lines/i)).toBeInTheDocument();
  });

  it('names what is retained, and why', () => {
    render(<DeletionExplanation />);

    expect(screen.getByText(/what we have to keep/i)).toBeInTheDocument();
    // The two retained things, each with its reason — the "why" is the part
    // §10.1 asks for, and the part somebody would otherwise find alarming.
    expect(screen.getByText(/six years/i)).toBeInTheDocument();
    expect(screen.getByText(/security log/i)).toBeInTheDocument();
  });

  it('explains that the security log holds fingerprints, not details', () => {
    // Otherwise "we keep a log of your account" reads as "we keep your data".
    render(<DeletionExplanation />);
    expect(screen.getByText(/one-way fingerprints/i)).toBeInTheDocument();
  });

  it('says the email is replaced and the address freed for re-registration', () => {
    render(<DeletionExplanation />);

    expect(screen.getByText(/replaced/i)).toBeInTheDocument();
    expect(screen.getByText(/sign up again/i)).toBeInTheDocument();
  });

  it('warns that it is immediate and irreversible', () => {
    // There is no grace period because there is no scheduler to build one on.
    // Discovering that afterwards would be worse than being told.
    render(<DeletionExplanation />);

    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/no grace period/i)).toBeInTheDocument();
  });

  it('does not promise that everything is deleted', () => {
    // The claim the platform cannot keep. If this ever appears, the page is
    // making a promise the ledger obligation contradicts.
    render(<DeletionExplanation />);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/everything (you|we) hold will be (deleted|erased)/i);
    expect(text).toMatch(/have to keep/i);
  });
});
