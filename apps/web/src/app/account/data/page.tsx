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
        <ul>
          <li>Your account — email address, when you joined</li>
          <li>Your profile — display name and phone number</li>
          <li>
            {/* Said explicitly because it is the one file where this is true, and
                somebody should know before they email it to themselves. */}
            <strong>Your full address</strong>, including the parts we store encrypted
          </li>
          <li>Your account activity — what happened, when, and from where</li>
        </ul>
      </section>

      <p>
        Because it contains your address, treat the file the way you would treat a bank
        statement. Downloading it is recorded in your account activity.
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
