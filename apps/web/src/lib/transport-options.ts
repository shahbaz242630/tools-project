import {
  ContractViolationError,
  parseCategoryTransportOptions,
} from '@platform/contracts';
import type { CategoryTransportOption } from '@platform/contracts';

/**
 * Turning the transport editor's hidden field back into a selection.
 *
 * Its own module beside `attribute-schema.ts`, for the reason CLAUDE.md gives:
 * an action is the web app's route handler, and a route handler is not where
 * logic lives. It is also the only part of the editor testable without a DOM.
 *
 * **An absent field is a failure, not an empty selection.** The editor always
 * renders the hidden input, including when nothing is ticked, so absence means
 * something went wrong between the form and here — and guessing "they meant
 * none" would silently stop every listing in the category being asked how the
 * item is collected, while answering as though the save worked.
 */

export type TransportOptionsOutcome =
  | { readonly kind: 'read'; readonly options: readonly CategoryTransportOption[] }
  | { readonly kind: 'unreadable'; readonly message: string };

export function readTransportOptions(raw: unknown): TransportOptionsOutcome {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      kind: 'unreadable',
      message:
        'The transport options did not reach the server. Reload the page and try ' +
        'again — saving now would clear them rather than leave them alone.',
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      kind: 'unreadable',
      message:
        'The transport options could not be read. Reload the page and try again.',
    };
  }

  try {
    // The contract's own schema, not a second opinion about what a transport
    // option is. A separate rule here would drift from the one the API enforces,
    // and the divergence surfaces as a form that accepts what the API rejects.
    return { kind: 'read', options: parseCategoryTransportOptions(decoded) };
  } catch (error) {
    if (error instanceof ContractViolationError) {
      return { kind: 'unreadable', message: error.issues.join('; ') };
    }
    throw error;
  }
}
