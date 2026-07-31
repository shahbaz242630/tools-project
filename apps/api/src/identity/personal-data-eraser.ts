import type { Actor } from '../audit/audit-log.js';

/**
 * Everything the platform holds about a person, from the identity module's
 * point of view.
 *
 * Identity & Access owns accounts (BRD §5.1) and therefore owns the deletion
 * *request* — but it owns almost none of the personal data that request is
 * about. So it states what it needs, in one sentence, and the composition root
 * supplies something that can do it.
 *
 * Today that is the profiles module. When listings, messages and condition
 * reports arrive, each will hold personal data of its own and the composition
 * root will compose several erasers into one. **Nothing in this module changes
 * when that happens**, which is the entire reason it is a port and not a call
 * into `ProfilesService`.
 */
export interface PersonalDataEraser {
  /**
   * Remove everything personal held about `actor.userId`.
   *
   * Takes the actor rather than a bare id because each module writes its own
   * audit entry for what it removed, and an audit entry needs to know who asked.
   *
   * **Must be idempotent.** A retry after a partial failure has to be able to
   * finish the job, and erasing what is already gone is a success.
   */
  erase(actor: Actor): Promise<void>;
}
