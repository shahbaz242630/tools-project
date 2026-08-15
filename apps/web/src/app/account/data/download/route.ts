import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { exportFilename } from '@platform/contracts';
import { clientIpFrom } from '../../../../lib/client-ip';
import { fetchDataExport } from '../../../../lib/data-export';
import { webEnv } from '../../../../lib/env';

/**
 * Downloading your own data export.
 *
 * **This is the second browser-reachable non-page route in the application**,
 * after the Clerk webhook, and CLAUDE.md asks that adding one be a deliberate
 * act rather than a convenience. The reason it has to be a route handler: a
 * file download needs a `Content-Disposition` header, and a server action
 * cannot set response headers. The alternative — returning the document to a
 * client component and assembling a Blob there — needs JavaScript to work at
 * all, for something that should be a link.
 *
 * It is not an API. It returns one file to one authenticated person and takes
 * no parameters. The API itself remains unreachable from the internet; this
 * calls it server-side like every other page does.
 */
export async function GET(): Promise<Response> {
  const { getToken } = await auth();
  const token = await getToken();

  // Not `redirect()`: this is fetched as a download rather than navigated to,
  // and a redirect to a sign-in page would be saved as an HTML file called
  // account-data.json.
  if (token === null) {
    return new Response('Sign in to download your data.', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const clientIp = clientIpFrom((await headers()).get('x-forwarded-for'));
  const outcome = await fetchDataExport(
    webEnv().API_BASE_URL,
    token,
    undefined,
    clientIp,
  );

  if (outcome.kind === 'signed-out') {
    /*
     * **The state first, the likeliest cause second**, as everywhere else — an
     * expiry stated as fact is a claim about a session we cannot vouch for.
     *
     * **Written for the medium, which is why there is no link.** Everywhere
     * else this sentence appears it offers `/sign-in` to click; here the
     * response is plain text a browser either shows in a bare tab or writes to
     * disk as a file, and markup would arrive as literal angle brackets. So the
     * route back is named in words instead — and it names the account page
     * rather than the sign-in page, because reloading this URL after signing in
     * would be a second file download rather than a place to stand.
     */
    return new Response(
      'You are not signed in, so no data was exported. Your session may have ' +
        'expired — sign in again, then start the download from your account ' +
        'page.',
      {
        status: 401,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    );
  }

  if (outcome.kind === 'forbidden') {
    /*
     * **403, not 502.** The catch-all below says the API could not answer, and
     * that would be a false accusation here: it answered, and it said no. A 502
     * also invites a retry, and there is nothing on the other side of one.
     *
     * **Written for the medium, like the branch above** — plain text, so the
     * route back is named in words rather than linked, and it names the account
     * page because reloading *this* URL would start another download rather
     * than land somewhere a person can stand.
     */
    return new Response(
      'You are signed in, but your data was not exported. That is a decision ' +
        'about your account rather than a fault, so trying again will not ' +
        'change it. If your account has been suspended, the reason is on your ' +
        'account page.',
      {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    );
  }

  if (outcome.kind !== 'ready') {
    // 502 rather than 500: the failure is upstream, and saying so distinguishes
    // "the API could not answer" from "this route is broken".
    return new Response(`Your data could not be exported — ${outcome.reason}`, {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(outcome.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFilename(outcome.exportedAt)}"`,
      // The response contains a home address. `no-store` keeps it out of any
      // shared cache and out of the browser's own back-forward cache.
      'cache-control': 'no-store, max-age=0',
    },
  });
}
