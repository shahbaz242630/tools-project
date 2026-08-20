/**
 * Whether a renter may pay for a booking right now (slice 5.2c).
 *
 * **Stated by Booking, answered by the feature-flags module** — the same shape
 * and the same argument as `PublicationSwitch`: Booking does not own flags and
 * does not import that module, and a port with one method cannot be used to
 * *switch* a flag from inside a booking operation, which would be a state change
 * with no administrator and no reason behind it.
 *
 * ## Why this flag exists, which is not the usual reason
 *
 * `listing.publication` is a **kill switch** over functionality that works.
 * This is the other kind the declaration anticipates: a flag over a capability
 * that is **incomplete**, and it defaults **off**.
 *
 * The incompleteness is precise. 5.2c builds everything on our side of the wire —
 * the route, §7's transitions, the ledger posting — and **there is no payment
 * provider adapter**, because 5.2e needs a Stripe account that does not exist
 * yet. So the honest state of the platform is that a renter cannot pay, and the
 * question is only whether that is *visible*.
 *
 * **Refusing at the flag is what keeps it visible and reversible.** The
 * alternative — wiring a provider that always fails — would move a booking to
 * `PAYMENT_FAILED` for a reason that has nothing to do with the renter's card,
 * which is a lie told in a state machine and a state a renter cannot get out of
 * by fixing anything. The alternative to *that* — omitting the route until the
 * adapter exists — is CLAUDE.md's dead control by another name, and it would
 * leave 5.2c untestable through the stack it actually runs in.
 *
 * **The refusal happens before the booking moves.** Nothing is written, nothing
 * is charged, and turning the flag on is the whole of what 5.2e has to do to make
 * this live — no deploy, and reversible from the admin surface if the first real
 * payment goes wrong.
 */
export interface PaymentSwitch {
  /**
   * Whether paying for a booking is switched on.
   *
   * **Must not throw, for any reason** — `PublicationSwitch` argues this at
   * length. The implementation answers with the flag's declared default when it
   * cannot reach the store, which for this flag is *off*: an outage that made
   * payment silently available would be worse than one that made it unavailable.
   */
  isPaymentEnabled(): Promise<boolean>;
}
