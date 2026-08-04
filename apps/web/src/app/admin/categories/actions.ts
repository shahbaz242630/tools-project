'use server';

import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  MIN_ADMIN_REASON_LENGTH,
  categoryConfigurationSchema,
  categoryDraftSchema,
} from '@platform/contracts';
import type {
  CategoryReportableActivity,
  CategoryRiskLevel,
} from '@platform/contracts';
import { clientIpFrom } from '../../../lib/client-ip';
import { readAttributeSchema } from '../../../lib/attribute-schema';
import { createCategory, reconfigureCategory } from '../../../lib/admin-categories';
import type { AdminCategoryOutcome } from '../../../lib/admin-categories';
import { webEnv } from '../../../lib/env';

/**
 * Creating a category, and changing one.
 *
 * Validated here *and* by the API, and the API's answer is the one that counts —
 * a check in a form is a convenience, never a control. The reason the checks
 * exist at all is that a round trip to be told "slug: must be lowercase" is a
 * worse experience than being told before sending it.
 */

export interface CategoryActionState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message: string | null;
  /** Kept so a failure does not clear what was typed. */
  readonly slug: string;
  readonly name: string;
  readonly reason: string;
  /**
   * Kept for the opposite reason to the others.
   *
   * The rest are here so a rejected submit does not make somebody retype. This
   * one is here so a rejected submit does not silently *reset* — a form that
   * bounced back showing `none` when the administrator chose
   * `means_of_transport` would be telling them the safe thing about a decision
   * they did not make.
   */
  readonly reportableActivity: CategoryReportableActivity;
}

export const INITIAL_CATEGORY_STATE: CategoryActionState = {
  status: 'idle',
  message: null,
  slug: '',
  name: '',
  reason: '',
  reportableActivity: 'none',
};

/**
 * A checkbox is present or absent, never `false`.
 *
 * Read explicitly rather than with a truthiness test, so that the day the
 * control changes shape this stops compiling instead of quietly reading every
 * value as acknowledged.
 */
function readAcknowledgement(form: FormData): boolean {
  return form.get('reportingDutiesAcknowledged') !== null;
}

/**
 * Whatever was chosen, unvalidated.
 *
 * Cast rather than checked here because the contract schema below is what
 * decides — a second opinion about the vocabulary in this file would drift from
 * the one the API enforces, which is the failure the slug validation comment
 * already describes.
 */
function readReportableActivity(form: FormData): CategoryReportableActivity {
  return String(form.get('reportableActivity') ?? '') as CategoryReportableActivity;
}

function describe<T>(
  outcome: AdminCategoryOutcome<T>,
  done: string,
): { status: 'done' | 'error'; message: string } {
  switch (outcome.kind) {
    case 'loaded':
      return { status: 'done', message: done };

    case 'taken':
      // Not a malformed request. The slug is fine; something else has it.
      return { status: 'error', message: outcome.reason };

    case 'invalid':
      return { status: 'error', message: outcome.issues.join('; ') };

    case 'not-found':
      return { status: 'error', message: 'That category no longer exists.' };

    case 'forbidden':
      return {
        status: 'error',
        message:
          'You do not have access to this. Administrator access needs a second ' +
          'factor verified recently — sign in again with it if you have one.',
      };

    case 'signed-out':
      return { status: 'error', message: 'Your session has expired. Sign in again.' };

    case 'unreachable':
    case 'malformed':
      return { status: 'error', message: `That did not complete — ${outcome.reason}` };
  }
}

async function context() {
  const { getToken } = await auth();
  return {
    api: webEnv().API_BASE_URL,
    token: await getToken(),
    clientIp: clientIpFrom((await headers()).get('x-forwarded-for')),
  };
}

function tooShort(reason: string): boolean {
  return reason.length < MIN_ADMIN_REASON_LENGTH;
}

const REASON_HINT =
  `Give a reason of at least ${String(MIN_ADMIN_REASON_LENGTH)} characters. ` +
  'Configuration changes are recorded, and every booking is interpreted under ' +
  'the version in force when it was made.';

export async function createCategoryAction(
  _previous: CategoryActionState,
  form: FormData,
): Promise<CategoryActionState> {
  const slug = String(form.get('slug') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();
  const riskLevel = String(form.get('riskLevel') ?? '') as CategoryRiskLevel;
  const reason = String(form.get('reason') ?? '').trim();
  const reportableActivity = readReportableActivity(form);
  const typed = { slug, name, reason, reportableActivity };

  if (tooShort(reason)) {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: REASON_HINT,
    };
  }

  const schema = readAttributeSchema(form.get('attributes'));
  if (schema.kind === 'unreadable') {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: schema.message,
    };
  }

  // The contract's own schema, not a second opinion about what a slug is. A
  // separate rule here would drift from the one the API enforces, and the
  // divergence would surface as a form that accepts what the API rejects.
  //
  // It is also what enforces §8.14.2's confirmation before anything leaves the
  // browser. The API enforces it again, and that is the one that counts.
  const parsed = categoryDraftSchema.safeParse({
    slug,
    name,
    riskLevel,
    reportableActivity,
    reportingDutiesAcknowledged: readAcknowledgement(form),
    attributes: schema.attributes,
  });
  if (!parsed.success) {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }

  const { api, token, clientIp } = await context();
  const outcome = await createCategory(
    api,
    token,
    parsed.data,
    reason,
    undefined,
    clientIp,
  );

  const result = describe(
    outcome,
    `Created. The slug "${slug}" is permanent — it is the URL, and renaming the ` +
      'category later will not move it.',
  );

  revalidatePath('/admin/categories');
  return { ...INITIAL_CATEGORY_STATE, ...typed, ...result };
}

export async function reconfigureCategoryAction(
  _previous: CategoryActionState,
  form: FormData,
): Promise<CategoryActionState> {
  const slug = String(form.get('slug') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();
  const riskLevel = String(form.get('riskLevel') ?? '') as CategoryRiskLevel;
  const reason = String(form.get('reason') ?? '').trim();
  const reportableActivity = readReportableActivity(form);
  const typed = { slug, name, reason, reportableActivity };

  if (tooShort(reason)) {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: REASON_HINT,
    };
  }

  const schema = readAttributeSchema(form.get('attributes'));
  if (schema.kind === 'unreadable') {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: schema.message,
    };
  }

  // Parsed here as well as on create, which it was not before this slice. The
  // reason is §8.14.2's confirmation: a switch from `none` to a reportable head
  // is the change §17 names as the undetected-breach risk, and the round trip
  // that would otherwise deliver that refusal is a worse place to learn it.
  const parsed = categoryConfigurationSchema.safeParse({
    name,
    riskLevel,
    reportableActivity,
    reportingDutiesAcknowledged: readAcknowledgement(form),
    attributes: schema.attributes,
  });
  if (!parsed.success) {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }

  const { api, token, clientIp } = await context();
  const outcome = await reconfigureCategory(
    api,
    token,
    slug,
    parsed.data,
    reason,
    undefined,
    clientIp,
  );

  const result = describe(
    outcome,
    'Saved as a new version. The previous one is kept exactly as it was, because ' +
      'bookings made under it are still interpreted by it.',
  );

  revalidatePath('/admin/categories');
  return { ...INITIAL_CATEGORY_STATE, ...typed, ...result };
}
