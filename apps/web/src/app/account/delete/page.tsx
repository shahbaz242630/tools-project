import Link from 'next/link';
import { DeletionExplanation } from '../../../components/deletion-explanation';
import { DeletionForm } from '../../../components/deletion-form';

/** Never prerendered — it acts on whoever is signed in. */
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Delete your account',
  robots: { index: false, follow: false },
};

export default function DeleteAccountPage() {
  return (
    <main>
      <h1>Delete your account</h1>

      <DeletionExplanation />
      <DeletionForm />

      <p>
        <Link href="/account">Back to your account</Link>
      </p>
    </main>
  );
}
