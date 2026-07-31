import type { ExportedProfile } from '@platform/contracts';

/**
 * A module's contribution to somebody's data export.
 *
 * The mirror image of `PersonalDataEraser`, and deliberately so: a module that
 * can be erased but not exported is a module somebody will forget when the next
 * subject-access request arrives. Adding one without the other should feel
 * obviously incomplete, which is easier when the two ports sit side by side.
 *
 * Identity & Access assembles the document because it owns the account; each
 * other module supplies its own section, because it is the one that knows what
 * it holds and how to make it readable — the address, for instance, has to be
 * decrypted, and only the profiles module has the encryptor.
 */
export interface PersonalDataSource {
  /**
   * Everything this module holds about `userId`, in export form.
   *
   * Null when it holds nothing, which is different from holding an empty
   * record and is worth preserving in a file somebody may read years later.
   */
  exportFor(userId: string): Promise<ExportedProfile>;
}
