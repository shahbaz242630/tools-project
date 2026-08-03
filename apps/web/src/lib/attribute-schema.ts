import { ContractViolationError, parseCategoryAttributes } from '@platform/contracts';
import type { CategoryAttribute } from '@platform/contracts';

/**
 * Turning the schema editor's hidden field back into an attribute schema.
 *
 * Its own module rather than a helper inside the server action, for the reason
 * CLAUDE.md gives: an action is the web app's route handler, and a route handler
 * is not where logic lives. It is also the only part of the editor that can be
 * tested without a DOM.
 *
 * **An absent field is a failure, not an empty schema.** The editor always
 * renders the hidden input, including when there are no attributes, so absence
 * means something went wrong between the form and here — and guessing "they
 * meant none" would clear the schema of every listing in the category while
 * answering as though the save worked. ADR 0025's lesson, applied at the one
 * boundary where the form could lie by omission.
 */

export type AttributeSchemaOutcome =
  | { readonly kind: 'read'; readonly attributes: readonly CategoryAttribute[] }
  | { readonly kind: 'unreadable'; readonly message: string };

export function readAttributeSchema(raw: unknown): AttributeSchemaOutcome {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      kind: 'unreadable',
      message:
        'The attribute list did not reach the server. Reload the page and try again — ' +
        'saving now would clear the attributes rather than leave them alone.',
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {
      kind: 'unreadable',
      message: 'The attribute list could not be read. Reload the page and try again.',
    };
  }

  try {
    // The contract's own schema, not a second opinion about what an attribute
    // is. A separate rule here would drift from the one the API enforces, and
    // the divergence surfaces as a form that accepts what the API rejects.
    return { kind: 'read', attributes: parseCategoryAttributes(decoded) };
  } catch (error) {
    if (error instanceof ContractViolationError) {
      return { kind: 'unreadable', message: error.issues.join('; ') };
    }
    throw error;
  }
}
