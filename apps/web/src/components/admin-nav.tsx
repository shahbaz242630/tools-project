import Link from 'next/link';

/**
 * The administrative surface, in one list.
 *
 * **It was six hand-written link paragraphs before this, and they had already
 * drifted** — `/admin/approvals` had forgotten Feature flags, and `/admin/categories`
 * and `/admin/feature-flags` had each forgotten Activity. Nobody notices a
 * missing link on a page they only reach by typing a URL, which is how the drift
 * survived: the omission looks exactly like a page that does not exist.
 *
 * A plain array rather than six copies, so adding a surface is one line and
 * every page gets it. Exported because `/admin` renders the same set as its
 * index, and two lists of the same six things is how you get five.
 *
 * **A server component with an explicit `current`, not `usePathname`.** These
 * pages are all `force-dynamic` server renders; making them client components to
 * grey out one link would ship JavaScript to solve a problem the caller already
 * knows the answer to.
 */
export interface AdminSurface {
  readonly href: string;
  readonly label: string;
  /** One sentence for the index page: what this is *for*, not what it is called. */
  readonly blurb: string;
}

export const ADMIN_SURFACES: readonly AdminSurface[] = [
  {
    href: '/admin/categories',
    label: 'Categories',
    blurb:
      'What can be listed, the fields each category asks for, and what the platform ' +
      'charges. Saving writes a new version and keeps the old one.',
  },
  {
    href: '/admin/feature-flags',
    label: 'Feature flags',
    blurb:
      'Switches for capabilities that are incomplete or high-risk, and the emergency ' +
      'stops for ones that are working but should not be right now.',
  },
  {
    href: '/admin/listings',
    label: 'Listing moderation',
    blurb:
      'Decide what the platform permits of one listing, by id. Separate from what its ' +
      'owner wants, and it does not change their intent.',
  },
  {
    href: '/admin/users',
    label: 'Account lookup',
    blurb:
      'Look up an account for support, and suspend or reinstate it. Recorded against ' +
      'that account with your reason, which they can read.',
  },
  {
    href: '/admin/activity',
    label: 'Account activity lookup',
    blurb:
      'Read another account’s history for support. The same history the account ' +
      'holder sees, including a colleague’s earlier access to it.',
  },
  {
    href: '/admin/approvals',
    label: 'Role changes',
    blurb:
      'Propose and approve role changes. Takes two administrators — one proposes, a ' +
      'different one agrees.',
  },
];

/**
 * The nav at the foot of every administrative page.
 *
 * The current page is rendered as plain text rather than dropped, so the set is
 * the same six everywhere and somebody can learn it. A link that is sometimes
 * present and sometimes absent teaches nobody where they are.
 */
export function AdminNav({ current }: { readonly current?: string }) {
  return (
    <nav aria-label="Administration">
      <p>
        {ADMIN_SURFACES.map((surface, index) => (
          <span key={surface.href}>
            {index === 0 ? null : ' · '}
            {surface.href === current ? (
              <strong aria-current="page">{surface.label}</strong>
            ) : (
              <Link href={surface.href}>{surface.label}</Link>
            )}
          </span>
        ))}
      </p>
      <p>
        {current === '/admin' ? (
          <strong aria-current="page">Administration</strong>
        ) : (
          <Link href="/admin">All administration</Link>
        )}{' '}
        · <Link href="/account">Back to your account</Link>
      </p>
    </nav>
  );
}
