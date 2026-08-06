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
 * it holds and how to make it readable — an address, for instance, has to be
 * decrypted, and the module that stored it is the one holding the encryptor.
 *
 * **Parameterised by its section from slice 2.5a.** It was typed to
 * `ExportedProfile` while profiles was the only contributor, which read as
 * though the port were about profiles rather than about the pattern. Catalogue
 * now contributes a listing's collection address, and its section is a
 * different shape — so the port describes the *contract* and each caller states
 * what it supplies.
 */
export interface PersonalDataSource<TSection> {
  /**
   * Everything this module holds about `userId`, in export form.
   *
   * Sections use null for "holds nothing", which is different from holding an
   * empty record and is worth preserving in a file somebody may read years
   * later. A section that is naturally a list uses the empty list instead —
   * "you have no listings" and "we hold no listing data about you" are the same
   * statement, and inventing a null beside `[]` would be two ways to say it.
   */
  exportFor(userId: string): Promise<TSection>;
}
