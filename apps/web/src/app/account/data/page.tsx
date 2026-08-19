import Link from 'next/link';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Download your data',
  robots: { index: false, follow: false },
};

export default function DataExportPage() {
  return (
    <main>
      <h1>Download your data</h1>

      <p>
        A copy of everything we hold about you, as a JSON file. It is generated when you
        click the link, so it is always current.
      </p>

      <section aria-labelledby="contents">
        <h2 id="contents">What the file contains</h2>
        {/*
          **This list is a transparency surface, not a summary** (§10.1), so
          understating it is a compliance defect rather than a copy nit — and it
          understated it for three slices. Until the Phase 0–3 audit it named the
          account, the profile, the address and the activity, and stopped there.
          `AccountDataService.exportFor` had meanwhile grown two more bulk
          disclosures: the sign-in history in 1.7, which carries IP addresses,
          devices and Clerk session ids, and Catalogue's listings section in
          2.5a, which carries **a collection address per listing**. Somebody with
          four listings has five addresses in that file and this page told them
          about one.

          **The rule this leaves behind: a module that contributes a
          `PersonalDataSource` section adds a line here in the same slice.** The
          port makes the export impossible to forget; nothing makes the page
          impossible to forget, so it is written down instead.
        */}
        <ul>
          <li>Your account — email address, when you joined</li>
          <li>Your profile — display name and phone number</li>
          <li>
            {/* Said explicitly because it is the one file where this is true, and
                somebody should know before they email it to themselves. The same
                reasoning is what puts the two below it on the list at all. */}
            <strong>Your full address</strong>, including the parts we store encrypted
          </li>
          <li>Your account activity — what happened, when, and from where</li>
          <li>
            <strong>Your sign-in history</strong> — the IP address, browser and device
            for each sign-in, and the session id it can be matched against
          </li>
          <li>
            <strong>Every listing you have created</strong>, each with the collection
            address you gave for it — including listings that are still drafts
          </li>
          {/*
            **Added in 4.8d with the section itself, and the pairing is the
            point.** This list is the disclosure: it is what somebody reads to
            decide whether to download a file, and a file that contains more than
            the list says is a §10.1 answer that under-states itself. Nothing
            would have failed — the export was correct and the page describing it
            was not — and it was found by reading this page after the section
            shipped.
          */}
          <li>
            <strong>Everything you have booked or been booked for</strong> — the hires
            you asked for, what other people booked on your listings, and the prices you
            were quoted and did not take up, each with the postcode you gave
          </li>
        </ul>
      </section>

      <p>
        Because it contains your home address, the collection address of every listing,
        the postcode you gave for each hire and the places you have signed in from,
        treat the file the way you would treat a bank statement. Downloading it is
        recorded in your account activity.
      </p>

      <p>
        {/* A plain link, so it works without JavaScript. The route sets
            Content-Disposition, which is why it is a route and not an action. */}
        <a href="/account/data/download" download>
          Download my data
        </a>
      </p>

      <p>
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
