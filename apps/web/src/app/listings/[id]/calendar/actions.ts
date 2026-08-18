'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  parseAvailabilityBlockRequest,
  ContractViolationError,
} from '@platform/contracts';
import { clientIpFrom } from '../../../../lib/client-ip';
import { asStandaloneSentence } from '../../../../lib/contract-issues';
import { listingCalendarPath } from '../../../../lib/page-paths';
import { blockPeriod, unblockPeriod } from '../../../../lib/availability';
import { webEnv } from '../../../../lib/env';
import { INITIAL_CALENDAR_STATE, calendarError } from './calendar-state';
import type { CalendarActionState } from './calendar-state';

/**
 * Declaring a period unavailable (BRD §8.5, slice 4.3b).
 *
 * **The dates are parsed here with the contract's own schema**, unlike the
 * publish action next door which deliberately checks nothing. The distinction is
 * what the rule depends on: publishing is judged against a pinned category
 * schema this page does not hold, so a second implementation would drift. "The
 * last day cannot come before the first" depends on nothing but the two values
 * in front of us, and telling somebody that after a round trip is a worse way to
 * find out.
 *
 * **What is *not* checked here is everything with a clock in it** — already
 * finished, too far ahead, too long. Those are the API's, they arrive as 422,
 * and they are rendered verbatim. A copy of them here would be a second place
 * the rule lives and the easier of the two to forget when the number changes.
 */
export async function blockPeriodAction(
  _previous: CalendarActionState,
  form: FormData,
): Promise<CalendarActionState> {
  /*
   * **Read once, and carried back on every refusal below.** React 19 resets an
   * uncontrolled form when its action completes, so a return that does not
   * include these empties both date fields behind the explanation of why they
   * were refused — which is how the person is left retyping dates that were
   * nearly right. Found by pressing the button; it is the fourth time this
   * codebase has met it.
   */
  const submitted = {
    startDate: String(form.get('startDate') ?? '').trim(),
    endDate: String(form.get('endDate') ?? '').trim(),
    reason: String(form.get('reason') ?? ''),
  };

  const listingId = String(form.get('listingId') ?? '').trim();
  if (listingId === '') {
    return calendarError(
      'That listing could not be identified. Reload the page and try again.',
      submitted,
    );
  }

  let period;
  try {
    period = parseAvailabilityBlockRequest(submitted);
  } catch (error) {
    if (error instanceof ContractViolationError) {
      // The field name is stripped: `endDate: the last day cannot fall before
      // the first` is a sentence about our JSON, and the person is looking at a
      // control labelled "Last day".
      return calendarError(
        asStandaloneSentence(error.issues, 'Those dates were not accepted.'),
        submitted,
      );
    }
    throw error;
  }

  const { getToken } = await auth();
  const outcome = await blockPeriod(
    webEnv().API_BASE_URL,
    await getToken(),
    listingId,
    period,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  switch (outcome.kind) {
    case 'loaded':
      /*
       * The page is a server component reading the month, so it has to be told
       * the row changed — without this the owner adds a period, the request
       * succeeds, and the calendar redraws from cache without it, which reads
       * exactly like a button that does nothing (the defect 2.8a fixed on the
       * publish button).
       *
       * **A page path, never the API path.** `revalidatePath` silently does
       * nothing when handed one that matches no route — see `page-paths.ts`.
       */
      revalidatePath(listingCalendarPath(listingId));
      return INITIAL_CALENDAR_STATE;

    case 'refused':
      // The API's own sentence, unprefixed. Nothing is broken and nothing was
      // half-done: the platform declined a period, in words written for the
      // person who chose it.
      return calendarError(outcome.reason, submitted);

    case 'not-found':
      return calendarError('That listing no longer exists.', submitted);

    case 'forbidden':
      // Unreachable while the route is `@AllowsSuspended()` — blocking dates
      // offers strangers *less*, which ADR 0024 permits. Kept rather than folded
      // into the generic branch: if somebody removes that decorator, this is the
      // difference between an explanation and "API answered 403".
      return calendarError(
        'You cannot change this listing while your account is suspended.',
        submitted,
      );

    case 'signed-out':
      /*
       * **The state first, the likeliest cause second** — the wording every
       * other action in this app settled on, because "your session has expired"
       * is a claim about a session we cannot vouch for and was being shown to
       * people who never had one.
       */
      return calendarError(
        'You are not signed in, so those dates were not blocked and the listing ' +
          'is unchanged. Your session may have expired — sign in again and add ' +
          'them once more.',
        submitted,
      );

    case 'invalid':
      return calendarError(outcome.issues.join('; '), submitted);

    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      // `stale-category` cannot arrive here — no category is pinned by a
      // calendar — and it is in the union because this shares the listings
      // client. Grouped with the generic failures rather than given a sentence
      // that would describe something that did not happen.
      return calendarError(`That did not complete — ${outcome.reason}`, submitted);
  }
}

/**
 * Removing a period.
 *
 * The mirror of the action above and deliberately shorter: there is nothing
 * typed in, so nothing to validate and no 422 to translate. What is left is the
 * two ids, the request, and the ways it can be refused.
 */
export async function unblockPeriodAction(
  _previous: CalendarActionState,
  form: FormData,
): Promise<CalendarActionState> {
  const listingId = String(form.get('listingId') ?? '').trim();
  const blockId = String(form.get('blockId') ?? '').trim();
  if (listingId === '' || blockId === '') {
    return calendarError(
      'That period could not be identified. Reload the page and try again.',
    );
  }

  const { getToken } = await auth();
  const outcome = await unblockPeriod(
    webEnv().API_BASE_URL,
    await getToken(),
    listingId,
    blockId,
    undefined,
    clientIpFrom((await headers()).get('x-forwarded-for')),
  );

  switch (outcome.kind) {
    case 'loaded':
      revalidatePath(listingCalendarPath(listingId));
      return INITIAL_CALENDAR_STATE;

    case 'not-found':
      // Both "already gone" and "not yours" arrive here, because the API refuses
      // to distinguish them. The sentence has to be true of both, so it says
      // what is on the calendar now rather than what happened.
      return calendarError(
        'That period is no longer on this calendar. Reload the page to see what is.',
      );

    case 'forbidden':
      // Reachable, unlike its twin above: unblocking puts dates back on offer,
      // which is a write ADR 0024 suspends.
      return calendarError(
        'You cannot put these dates back while your account is suspended. They ' +
          'are still blocked, so nobody can book them.',
      );

    case 'signed-out':
      return calendarError(
        'You are not signed in, so that period was not removed and those dates ' +
          'are still blocked. Your session may have expired — sign in again and ' +
          'remove it once more.',
      );

    case 'invalid':
      return calendarError(outcome.issues.join('; '));

    case 'stale-category':
    case 'unreachable':
    case 'malformed':
      return calendarError(`That did not complete — ${outcome.reason}`);
  }
}
