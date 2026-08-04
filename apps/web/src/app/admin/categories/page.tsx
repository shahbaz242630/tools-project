import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { activatesSellerReporting } from '@platform/contracts';
import type { AdminCategory } from '@platform/contracts';
import {
  CreateCategoryForm,
  ReconfigureCategoryForm,
} from '../../../components/category-form';
import { clientIpFrom } from '../../../lib/client-ip';
import { fetchCategories } from '../../../lib/admin-categories';
import type { AdminCategoryOutcome } from '../../../lib/admin-categories';
import { webEnv } from '../../../lib/env';

/** Never prerendered — it is admin-only, and it changes as configuration does. */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Categories',
  robots: { index: false, follow: false },
};

/**
 * Categories and their configuration — the first page of the Catalogue module.
 *
 * **The page does not check the role**, the same as every other admin page. The
 * API does, on every request, with the second factor (ADR 0021).
 *
 * What this page has to communicate, and the reason its wording is deliberate:
 * nothing here is edited in place. Saving writes a new version and keeps the old
 * one, because from Phase 4 a booking is interpreted under the version in force
 * when it was made. An administrator who thinks they corrected a value will be
 * surprised by an old booking that still behaves the old way, and the moment to
 * prevent that is here rather than in a support conversation.
 */
export default async function CategoriesPage() {
  const { getToken } = await auth();
  const token = await getToken();
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await fetchCategories(
    webEnv().API_BASE_URL,
    token,
    undefined,
    clientIp,
  );

  return (
    <main>
      <h1>Categories</h1>

      <p>
        A category is <strong>configuration, not code</strong>. Adding one needs no
        deployment, and everything a category decides — its attributes, fees, deposit
        bands and rules — is versioned, so a booking keeps the terms it was made under.
      </p>

      <p>
        Today a category carries a name, a risk level, its attribute schema — the fields
        an owner fills in when listing something in it — and whether its activity is
        reportable to HMRC. Fees, deposit bands and the rest arrive in later slices, and
        each will be one more field on the version rather than a new place to look.
      </p>

      <p>
        <strong>One setting here is not like the others.</strong> Reportable activity
        decides whether the platform owes HMRC seller tax data, registration and an
        annual return. Renting out tools and garden equipment does not; trailers, vans,
        e-bikes, mobility scooters and anything labour-based do. Choosing anything other
        than <em>none</em> needs counsel to confirm the scope first, and the form will
        ask you to confirm it.
      </p>

      <section aria-labelledby="existing">
        <h2 id="existing">Existing categories</h2>
        <CategoryList outcome={outcome} />
      </section>

      {/*
        Only offered to somebody who could actually use it.

        Found by opening the page: the list correctly said "you do not have
        access", and directly underneath it sat a complete, enabled form
        inviting the same person to create a category. Every test passed,
        because each half was right on its own — the form does not know what
        the read above it discovered, and nothing had asked them to agree.

        A control that cannot work must not be presented as though it can. The
        message from the read already explains why it is absent.
      */}
      {outcome.kind === 'loaded' ? (
        <section aria-labelledby="create">
          <h2 id="create">Add a category</h2>
          <CreateCategoryForm />
        </section>
      ) : null}

      <p>
        <Link href="/admin/approvals">Role changes</Link> ·{' '}
        <Link href="/admin/users">Look up an account</Link> ·{' '}
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}

/**
 * Countable, because "1 attributes" is the kind of detail that makes an
 * administrator distrust everything else on the page.
 */
function attributeSummary(count: number): string {
  if (count === 0) return 'no attributes';
  return count === 1 ? '1 attribute' : `${String(count)} attributes`;
}

/**
 * Every failure gets its own sentence.
 *
 * A single "something went wrong" would make an expired session, a missing
 * second factor and an unreachable API look identical — and only one of those
 * is fixed by signing in again.
 */
function CategoryList({
  outcome,
}: {
  readonly outcome: AdminCategoryOutcome<readonly AdminCategory[]>;
}) {
  switch (outcome.kind) {
    case 'signed-out':
      return (
        <p role="alert">
          Your session has expired. <Link href="/sign-in">Sign in again</Link>.
        </p>
      );

    case 'forbidden':
      return (
        <p role="alert">
          You do not have access to this. Administrator access needs the role{' '}
          <strong>and</strong> a second factor verified in the last 12 hours — if you
          have one, sign in again with it.
        </p>
      );

    case 'not-found':
      return <p role="alert">That is not available.</p>;

    case 'taken':
    case 'invalid':
      return <p role="alert">The request was rejected.</p>;

    case 'unreachable':
    case 'malformed':
      return <p role="alert">Categories could not be loaded — {outcome.reason}</p>;

    case 'loaded':
      break;
  }

  if (outcome.value.length === 0) {
    return (
      <p>
        No categories yet. Nothing can be listed until there is at least one, so this is
        the first thing to do.
      </p>
    );
  }

  return (
    <ul>
      {outcome.value.map((category) => (
        <li key={category.id}>
          <h3>{category.name}</h3>
          <p>
            <code>{category.slug}</code> · risk {category.riskLevel} ·{' '}
            {attributeSummary(category.attributes.length)} ·{' '}
            <strong>version {category.versionNumber}</strong>
          </p>
          {/*
            Shown only when it is not `none`. A line reading "not reportable" on
            every category is one nobody reads, and the whole value of this
            summary is that the exception stands out from a list where
            everything else is ordinary.
          */}
          {activatesSellerReporting(category.reportableActivity) ? (
            <p>
              <strong>Reportable to HMRC</strong> — {category.reportableActivity}.
              Seller tax data must be collected, verified and filed annually for this
              category.
            </p>
          ) : null}
          <ReconfigureCategoryForm category={category} />
        </li>
      ))}
    </ul>
  );
}
