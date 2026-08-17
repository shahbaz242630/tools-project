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
import { readTransportOptions } from '../../../lib/transport-options';
import { createCategory, reconfigureCategory } from '../../../lib/admin-categories';
import type { AdminCategoryOutcome } from '../../../lib/admin-categories';
import { webEnv } from '../../../lib/env';
import { INITIAL_CATEGORY_STATE } from './state';
import type { CategoryActionState } from './state';
import { asSentence } from '../../../lib/contract-issues';
import { readFeePolicy } from '../../../lib/fee-policy';

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
 * The category's maximum hire length, as typed (§8.5.3, slice 4.4a).
 *
 * **`NaN` for anything unparseable rather than a fallback to 88**, and the
 * absence of that fallback is the decision. A default here would mean a blank or
 * mangled field silently became *the most permissive value the law allows* —
 * which is the wrong direction for a bound whose whole purpose is to stop the
 * platform arranging a regulated agreement. `maximumRentalDaysSchema` refuses
 * `NaN`, so the administrator is told, and the API refuses it again.
 */
function readMaximumRentalDays(form: FormData): number {
  return Number(String(form.get('maximumRentalDays') ?? '').trim());
}

/**
 * How long an owner has to answer a request (§8.6, slice 4.5a).
 *
 * Read exactly as the cap above is, and for the same reason: an absent or
 * unparseable field becomes `NaN`, the contract refuses it with a message naming
 * the field, and the administrator is told rather than being given a default they
 * did not choose.
 */
function readRequestExpiryHours(form: FormData): number {
  return Number(String(form.get('requestExpiryHours') ?? '').trim());
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
      // The state first, the likeliest cause second — see the note in
      // `admin/approvals/actions.ts`.
      return {
        status: 'error',
        message:
          'You are not signed in. Your session may have expired — sign in again ' +
          'and try once more.',
      };

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

/**
 * The four fee fields, as typed.
 *
 * Read here rather than in the component for the reason every other value on
 * this form is: the browser is not the boundary. The contract validates the
 * result again below and the API validates it a third time.
 */
function readFeePolicyFrom(form: FormData) {
  return readFeePolicy({
    ownerCommission: String(form.get('ownerCommission') ?? ''),
    renterFee: String(form.get('renterFee') ?? ''),
    minimumBookingTotal: String(form.get('minimumBookingTotal') ?? ''),
    minimumPlatformFee: String(form.get('minimumPlatformFee') ?? ''),
  });
}

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

  const transport = readTransportOptions(form.get('transportOptions'));
  if (transport.kind === 'unreadable') {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: transport.message,
    };
  }

  const fees = readFeePolicyFrom(form);
  if (!fees.ok) {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: fees.message,
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
    transportOptions: transport.options,
    feePolicy: fees.value,
    maximumRentalDays: readMaximumRentalDays(form),
    requestExpiryHours: readRequestExpiryHours(form),
  });
  if (!parsed.success) {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: parsed.error.issues.map(asSentence).join('; '),
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

  const transport = readTransportOptions(form.get('transportOptions'));
  if (transport.kind === 'unreadable') {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: transport.message,
    };
  }

  const fees = readFeePolicyFrom(form);
  if (!fees.ok) {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: fees.message,
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
    transportOptions: transport.options,
    feePolicy: fees.value,
    maximumRentalDays: readMaximumRentalDays(form),
    requestExpiryHours: readRequestExpiryHours(form),
  });
  if (!parsed.success) {
    return {
      ...INITIAL_CATEGORY_STATE,
      ...typed,
      status: 'error',
      message: parsed.error.issues.map(asSentence).join('; '),
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
