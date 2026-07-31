/**
 * What deleting an account actually does.
 *
 * **This is a requirement, not copy.** BRD §10.1: *"the deletion workflow must
 * distinguish erasable personal data from retained transactional records and
 * explain the distinction to the user."* We cannot erase everything — the
 * account row has to survive for the ledger to reference from Phase 5, and
 * security logs are retained for six years — so saying "your account will be
 * deleted" and leaving it there would be a promise the platform does not keep.
 *
 * Kept as its own component so it can be tested directly, and so that a change
 * to what we retain forces a visible change to what we tell people.
 */
export function DeletionExplanation() {
  return (
    <>
      <section aria-labelledby="erased">
        <h2 id="erased">What is deleted</h2>
        <ul>
          <li>Your display name</li>
          <li>Your phone number</li>
          <li>Your address, including the encrypted street lines</li>
          <li>Your public profile, which stops being reachable immediately</li>
        </ul>
        <p>
          These are removed outright, not hidden. They will not be in any backup taken
          afterwards.
        </p>
      </section>

      <section aria-labelledby="retained">
        <h2 id="retained">What we have to keep, and why</h2>
        <ul>
          <li>
            <strong>Your email address is replaced</strong> with a placeholder rather
            than kept. That also frees the real address, so you can sign up again later
            if you want to.
          </li>
          <li>
            <strong>An empty account record.</strong> It holds no personal details and
            exists so that financial records can keep referring to something. UK law
            requires those to be kept for six years.
          </li>
          <li>
            <strong>A security log of actions on your account</strong> — when it was
            created, when things changed, when you asked to be deleted. It records that
            something happened and never what it was: the entries hold one-way
            fingerprints, not your details.
          </li>
        </ul>
      </section>

      <section aria-labelledby="cannot">
        <h2 id="cannot">Before you continue</h2>
        <p>
          {/* Said plainly because it is true and there is no scheduler to build a
              grace period on. Discovering it afterwards would be worse. */}
          <strong>This happens immediately and cannot be undone.</strong> There is no
          grace period and no way for us to restore your details afterwards.
        </p>
      </section>
    </>
  );
}
