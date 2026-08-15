'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { clientIpFrom } from '../../../lib/client-ip';
import { readProfileForm } from '../../../lib/profile-form';
import { saveMyProfile } from '../../../lib/profile';
import { webEnv } from '../../../lib/env';

import type { ProfileFormState } from './state';

export async function saveProfileAction(
  _previous: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  // Validated before the request, against the same contract the API enforces.
  // A round trip to be told the postcode is malformed is one the person should
  // not have to wait for — and the API validates again regardless, because a
  // check in a form is a convenience, never a control.
  const parsed = readProfileForm(form);
  if (parsed.kind === 'invalid') {
    return { status: 'invalid', issues: parsed.issues, message: null };
  }

  const { getToken } = await auth();

  // The audit entry for this save records where it came from, so the address
  // has to travel with the request that causes it.
  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));

  const outcome = await saveMyProfile(
    webEnv().API_BASE_URL,
    await getToken(),
    parsed.input,
    undefined,
    clientIp,
  );

  switch (outcome.kind) {
    case 'saved':
      // The page reads the profile on each request, so this is what makes the
      // form redisplay normalised values — `bs7 8aa` coming back as `BS7 8AA`
      // is how somebody sees that it was understood.
      revalidatePath('/account/profile');
      return { status: 'saved', issues: [], message: null };

    case 'invalid':
      // The API disagreed with the form. Reachable when the two are briefly on
      // different versions mid-deploy, which is exactly when a person needs to
      // be told what is wrong rather than "something went wrong".
      return { status: 'invalid', issues: outcome.issues, message: null };

    case 'signed-out':
      // **Not "your session has expired"**, which claims a session this person
      // may never have had. Reaching a server action means the page rendered,
      // so an expiry is the likeliest cause — but it is a guess, and the state
      // is what the reader needs first.
      return {
        status: 'error',
        issues: [],
        message:
          'You are not signed in, so nothing was saved. Your session may have ' +
          'expired — sign in again and your changes will save.',
      };

    case 'forbidden':
      /*
       * The suspended case, and the whole reason `forbidden` exists.
       *
       * `GET /me/profile` opts in to `@AllowsSuspended` and this `PUT`
       * deliberately does not (ADR 0024), so before this branch a suspended
       * person read "Your profile was not saved — API answered 403" and had no
       * way to know that was a decision rather than a fault. The reason an
       * administrator wrote is on their account page, verbatim, which is where
       * this sends them rather than repeating it here — one place holds it.
       */
      return {
        status: 'error',
        issues: [],
        message:
          'Your profile was not saved, because your account cannot be changed at ' +
          'the moment. If it has been suspended, the reason is on your account page.',
      };

    case 'unreachable':
    case 'malformed':
      // Explicitly *not* "saved". A form that says it saved when it did not is
      // how somebody closes the tab believing their address is stored.
      return {
        status: 'error',
        issues: [],
        message: `Your profile was not saved — ${outcome.reason}`,
      };
  }
}
