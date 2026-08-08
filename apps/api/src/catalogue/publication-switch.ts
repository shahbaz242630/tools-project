/**
 * What Catalogue needs to know about whether publishing is switched on.
 *
 * **Stated by the consumer, answered by the feature-flags module** — the same
 * shape as `ListingLocator`, which Catalogue states and Search & Location
 * answers, and as `AccountLookup`, which Profiles states and Identity answers.
 * Catalogue does not own flags and does not import that module; the composition
 * root wires the two together (BRD §5.1).
 *
 * **Narrower than the flag service on purpose.** The feature-flags module can
 * list every flag, switch one and record why; Catalogue may ask one question.
 * Handing it the whole service would let a later slice switch a flag from inside
 * a listing operation — a state change with no administrator and no reason
 * behind it, which is exactly what §9's audit requirement exists to prevent.
 * A port with one method cannot be misused that way.
 */
export interface PublicationSwitch {
  /**
   * Whether owners may publish listings right now.
   *
   * **Must not throw, for any reason.** A flag read that can fail is one every
   * call site has to wrap, and the first to forget turns a database blip into a
   * 500 on a path that worked perfectly before anybody added a flag to it. The
   * implementation answers with the flag's declared default when it cannot
   * reach the store — which for this flag is *enabled*, so an outage does not
   * silently stop every owner publishing.
   */
  isPublicationEnabled(): Promise<boolean>;
}
