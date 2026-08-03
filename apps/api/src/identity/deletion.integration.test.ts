import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CLERK_EVENTS_PATH,
  CLIENT_IP_HEADER,
  ME_ACTIVITY_PATH,
  ME_DELETION_PATH,
  ME_PATH,
  ME_EXPORT_PATH,
  ME_PROFILE_PATH,
  adminActivityPath,
  adminUserPath,
  adminUserViewSchema,
  activityResponseSchema,
  dataExportSchema,
  exportFilename,
  deletionResponseSchema,
  publicProfilePath,
} from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import { createCatalogueFakes } from '../catalogue/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import {
  InMemoryAccountLookup,
  InMemoryProfileStore,
} from '../profiles/testing/fakes.js';
import { IdentityService } from './identity.service.js';
import {
  FakeSessionVerifier,
  InMemoryAdminApprovalStore,
  InMemoryUserDirectory,
  InMemoryWebhookLedger,
} from './testing/fakes.js';
import { InMemoryAuthenticationEvents } from './testing/fakes.js';

/**
 * Account deletion against the real application, with identity and profiles
 * wired to each other exactly as the composition root wires them.
 *
 * The service tests prove each half. This proves the halves are connected: an
 * eraser that works perfectly and was never passed to `IdentityService` leaves
 * every profile in place, and no unit test can see that.
 */

const ALICE = {
  clerkUserId: 'user_alice',
  sessionId: 'sess_a',
  email: 'alice@example.com',
};
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };
const ADMIN = {
  clerkUserId: 'user_admin',
  sessionId: 'sess_ad',
  email: 'admin@example.com',
};
const ADMIN_NO_CLAIM = {
  clerkUserId: 'user_admin2',
  sessionId: 'sess_ad2',
  email: 'admin2@example.com',
};

const PROFILE = {
  displayName: 'Alice A.',
  phone: '07700 900123',
  address: {
    line1: '12 Acacia Avenue',
    line2: null,
    town: 'Bristol',
    postcode: 'BS7 8AA',
  },
};

let app: NestFastifyApplication;
let audit: AuditFakes;
let users: InMemoryUserDirectory;
let profileStore: InMemoryProfileStore;
let accounts: InMemoryAccountLookup;
let approvals: InMemoryAdminApprovalStore;

beforeEach(async () => {
  audit = createAuditFakes();
  users = new InMemoryUserDirectory();
  approvals = new InMemoryAdminApprovalStore();
  profileStore = new InMemoryProfileStore();
  accounts = new InMemoryAccountLookup();

  const sessionVerifier = new FakeSessionVerifier()
    .accept('alice-token', ALICE)
    .accept('bob-token', BOB)
    // A second factor verified five minutes ago.
    .accept('admin-token', { ...ADMIN, secondFactorAgeMinutes: 5 })
    // Deliberately no `secondFactorAgeMinutes` — the shape a token from an
    // instance that was never provisioned with the claim arrives in.
    .accept('admin-no-claim', ADMIN_NO_CLAIM);

  // The real cycle: identity erases through a port that reaches profiles, and
  // profiles asks identity whether an account is active. Wired here the same
  // way main.ts does it.
  const profiles: ProfilesService = new ProfilesService(
    profileStore,
    accounts,
    audit.service,
  );
  const identity: IdentityService = new IdentityService(
    users,
    new InMemoryWebhookLedger(),
    audit.service,
    { erase: (actor) => profiles.eraseFor(actor) },
    { exportFor: (userId) => profiles.exportFor(userId) },
    { summaryFor: (userId) => profiles.adminSummaryFor(userId) },
    approvals,
    new InMemoryAuthenticationEvents(),
    createRecordingLogger().logger,
  );

  // Stands in for the transaction the real store performs, so approving a
  // proposal in these tests really does change the role.
  approvals.apply = (approval) => {
    const target = users.all().find((row) => row.id === approval.action.userId);
    if (target !== undefined) users.seed({ ...target, role: approval.action.role });
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        checks: [],
        logger: createRecordingLogger().logger,
        identity: { sessionVerifier, service: identity },
        profiles,
        audit: audit.service,
        catalogue: createCatalogueFakes().service,
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const saveProfile = (token: string, ip?: string) =>
  app.inject({
    method: 'PUT',
    url: ME_PROFILE_PATH,
    headers: {
      ...auth(token),
      ...(ip === undefined ? {} : { [CLIENT_IP_HEADER]: ip }),
    },
    payload: PROFILE as never,
  });

const requestDeletion = (token?: string, ip?: string) =>
  app.inject({
    method: 'POST',
    url: ME_DELETION_PATH,
    headers: {
      ...(token === undefined ? {} : auth(token)),
      ...(ip === undefined ? {} : { [CLIENT_IP_HEADER]: ip }),
    },
  });

/**
 * A deletion that started at Clerk rather than with us.
 *
 * Driven through the real internal route the web app forwards to, not through
 * the service — the point of slice 1.5c is that this path does the same work,
 * and a test that called the service directly would skip the wiring.
 */
const deleteAtClerk = (clerkUserId: string, deliveryId = 'msg_deleted') =>
  app.inject({
    method: 'POST',
    url: CLERK_EVENTS_PATH,
    payload: { deliveryId, type: 'user.deleted', data: { id: clerkUserId } },
  });

/** Provision the account behind a token, then make it an administrator. */
async function promote(token: string): Promise<string> {
  const id = await idOf(token);
  users.promote(id);
  return id;
}

async function idOf(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: ME_PATH,
    headers: auth(token),
  });
  return (response.json() as { id: string }).id;
}

describe('POST /me/deletion-request', () => {
  it('rejects an unauthenticated request', async () => {
    // The most important 401 in the application: an unauthenticated delete
    // would be a way to remove other people's accounts.
    expect((await requestDeletion()).statusCode).toBe(401);
    expect(users.all()).toHaveLength(0);
  });

  it('deletes the caller’s account and answers plainly', async () => {
    await saveProfile('alice-token');
    const response = await requestDeletion('alice-token', '203.0.113.7');

    expect(response.statusCode).toBe(200);
    expect(deletionResponseSchema.parse(response.json())).toEqual({
      outcome: 'deleted',
    });
  });

  it('erases the profile, not merely hides it', async () => {
    // The debt slice 1.4 knowingly left. Until now the row survived and only
    // the disclosure check kept it off the internet.
    const aliceId = await idOf('alice-token');
    accounts.add(aliceId);
    await saveProfile('alice-token');
    expect(profileStore.all()).toHaveLength(1);

    await requestDeletion('alice-token');

    expect(profileStore.all()).toHaveLength(0);
  });

  it('stops the public profile resolving', async () => {
    const aliceId = await idOf('alice-token');
    accounts.add(aliceId);
    await saveProfile('alice-token');
    expect(
      (await app.inject({ method: 'GET', url: publicProfilePath(aliceId) })).statusCode,
    ).toBe(200);

    await requestDeletion('alice-token');

    expect(
      (await app.inject({ method: 'GET', url: publicProfilePath(aliceId) })).statusCode,
    ).toBe(404);
  });

  it('locks the account out even though the credential still exists', async () => {
    // Clerk is deleted afterwards by the web app, so between the two there is a
    // window where a valid session token exists for a deleted account. The
    // guard has to refuse it, or the window is a way back in.
    await requestDeletion('alice-token');

    expect(
      (await app.inject({ method: 'GET', url: ME_PATH, headers: auth('alice-token') }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: ME_PROFILE_PATH,
          headers: auth('alice-token'),
        })
      ).statusCode,
    ).toBe(401);
  });

  it('is idempotent over HTTP', async () => {
    // A retry after a dropped connection must succeed, not be told it is too
    // late — the caller cannot sign in again to check.
    await requestDeletion('alice-token');

    // A second attempt cannot authenticate at all now, which is itself the
    // correct answer to "is it already done".
    expect((await requestDeletion('alice-token')).statusCode).toBe(401);
  });

  it('leaves other accounts untouched', async () => {
    const bobId = await idOf('bob-token');
    accounts.add(bobId);
    await saveProfile('bob-token');
    await saveProfile('alice-token');

    await requestDeletion('alice-token');

    expect(profileStore.all().map((row) => row.userId)).toEqual([bobId]);
    expect(
      (await app.inject({ method: 'GET', url: ME_PATH, headers: auth('bob-token') }))
        .statusCode,
    ).toBe(200);
  });
});

describe('what survives a deletion', () => {
  it('keeps the audit trail, holding no personal data', async () => {
    // §10.1 retains security logs a year hot and six years cold. The entries
    // survive the erasure they describe precisely because they hold digests
    // rather than values (ADR 0017).
    await saveProfile('alice-token');
    await requestDeletion('alice-token', '203.0.113.7');

    const actions = audit.log.entries().map((entry) => entry.action);
    expect(actions).toContain('account.provisioned');
    expect(actions).toContain('profile.created');
    expect(actions).toContain('profile.erased');
    expect(actions).toContain('account.deletion_requested');

    const serialised = JSON.stringify(audit.log.entries());
    expect(serialised).not.toContain('Alice A.');
    expect(serialised).not.toContain('alice@example.com');
    expect(serialised).not.toContain('Acacia');
    expect(serialised).not.toContain('900123');
  });

  it('keeps the account row, tombstoned, for the ledger to reference', async () => {
    const aliceId = await idOf('alice-token');
    await requestDeletion('alice-token');

    const user = users.all().find((row) => row.id === aliceId);
    expect(user).toBeDefined();
    expect(user?.email).toBe(`deleted+${aliceId}@deleted.invalid`);
    expect(user?.deletedAt).toBeInstanceOf(Date);
    expect(user?.deletionRequestedAt).toBeInstanceOf(Date);
  });

  it('makes the trail unreadable to its owner, who can no longer authenticate', async () => {
    // Worth stating: the retained trail is not readable by the deleted person.
    // Reading it is an administrative capability, which arrives with the admin
    // role and its own audit entries.
    await requestDeletion('alice-token');

    const response = await app.inject({
      method: 'GET',
      url: ME_ACTIVITY_PATH,
      headers: auth('alice-token'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('frees the email address for genuine re-registration', async () => {
    // A retained unique row would lock somebody out of the platform forever.
    // Signing up again with the same address must work — here, as a new Clerk
    // account resolving to a fresh mirror row.
    await requestDeletion('alice-token');

    const verifier = new FakeSessionVerifier();
    expect(verifier).toBeDefined();

    const { user } = await users.upsert({
      clerkUserId: 'user_alice_again',
      email: 'alice@example.com',
    });

    expect(user.email).toBe('alice@example.com');
    expect(user.deletedAt).toBeNull();
  });
});

describe('a deletion that starts at Clerk erases the same data', () => {
  /**
   * Slice 1.5c.
   *
   * Clerk's account screen has been mounted at `/account/email` since slice 1.7
   * and carries its own "Delete account" button. Until this slice the
   * `user.deleted` webhook tombstoned the email and nothing else, so a person
   * deleting there was told their data was gone while the profile row, the
   * encrypted street lines and the sign-in history all survived.
   *
   * These run against the real application and an in-memory profile store, so
   * they prove the routing and the ordering. That the street line is genuinely
   * gone from an `addresses` row is the profiles store's own database test —
   * both paths call the identical eraser, so it is the same proof.
   */
  it('removes the profile and the address rows', async () => {
    await saveProfile('alice-token');
    const aliceId = await idOf('alice-token');

    // Present first, so an empty result afterwards is a change rather than an
    // empty fixture.
    expect(profileStore.all().map((row) => row.userId)).toEqual([aliceId]);

    const response = await deleteAtClerk('user_alice');
    expect(response.json()).toEqual({ outcome: 'applied' });

    expect(profileStore.all()).toEqual([]);
  });

  it('leaves no profile row behind for anyone', async () => {
    // `all()` rather than a lookup by id: a lookup proves this person's row is
    // gone, and the store holding somebody's orphaned row is the failure that
    // would not show up that way.
    await saveProfile('alice-token');
    await deleteAtClerk('user_alice');

    expect(profileStore.all()).toEqual([]);
  });

  it('tombstones the account and records when it was asked for', async () => {
    const aliceId = await idOf('alice-token');
    await deleteAtClerk('user_alice');

    const user = users.all().find((row) => row.id === aliceId);
    expect(user?.email).toBe(`deleted+${aliceId}@deleted.invalid`);
    expect(user?.deletedAt).toBeInstanceOf(Date);
    // Was null before this slice. A data-protection enquiry asks when they
    // asked, and a deletion that began at Clerk was still asked for.
    expect(user?.deletionRequestedAt).toBeInstanceOf(Date);
  });

  it('writes the same trail our own route writes', async () => {
    await saveProfile('alice-token');
    await deleteAtClerk('user_alice');

    const actions = audit.log.entries().map((entry) => entry.action);
    expect(actions).toContain('profile.erased');
    expect(actions).toContain('account.deletion_requested');

    const serialised = JSON.stringify(audit.log.entries());
    expect(serialised).not.toContain('Alice A.');
    expect(serialised).not.toContain('Acacia');
    expect(serialised).not.toContain('900123');
  });

  it('refuses the deleted account a session afterwards', async () => {
    // Provisioned first. Without it the webhook finds no mirror row, correctly
    // does nothing, and the `/me` below creates a fresh account and answers
    // 200 — which is right, and would have made this test pass for the wrong
    // reason had it been asserting the other way.
    await idOf('alice-token');

    await deleteAtClerk('user_alice');

    const response = await app.inject({
      method: 'GET',
      url: ME_PATH,
      headers: auth('alice-token'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('is idempotent across a redelivery', async () => {
    await saveProfile('alice-token');
    await deleteAtClerk('user_alice', 'msg_first');
    const after = audit.log.entries().length;

    // A different delivery id, so the webhook ledger does not dedupe it — the
    // guard that matters is the already-deleted check inside the service.
    await deleteAtClerk('user_alice', 'msg_second');

    expect(audit.log.entries()).toHaveLength(after);
  });
});

describe('the activity trail of a deletion', () => {
  it('records the erasure before the account change', async () => {
    // Order in the trail mirrors order in the operation, which is what makes
    // it evidence rather than a summary.
    await saveProfile('alice-token');
    await requestDeletion('alice-token');

    const actions = audit.log.entries().map((entry) => entry.action);
    expect(actions.indexOf('profile.erased')).toBeLessThan(
      actions.indexOf('account.deletion_requested'),
    );
  });

  it('is visible to another account only as their own empty trail', async () => {
    await requestDeletion('alice-token');

    const response = await app.inject({
      method: 'GET',
      url: ME_ACTIVITY_PATH,
      headers: auth('bob-token'),
    });

    const { entries } = activityResponseSchema.parse(response.json());
    expect(entries.every((entry) => entry.action === 'account.provisioned')).toBe(true);
  });
});

describe('GET /me/export', () => {
  const exportFor = (token?: string, ip?: string) =>
    app.inject({
      method: 'GET',
      url: ME_EXPORT_PATH,
      headers: {
        ...(token === undefined ? {} : auth(token)),
        ...(ip === undefined ? {} : { [CLIENT_IP_HEADER]: ip }),
      },
    });

  it('rejects an unauthenticated request', async () => {
    // The single most important 401 in the codebase after deletion: this route
    // returns a decrypted home address.
    expect((await exportFor()).statusCode).toBe(401);
  });

  it('rejects a token it cannot verify', async () => {
    expect((await exportFor('forged-token')).statusCode).toBe(401);
  });

  it('returns everything held about the caller, address included', async () => {
    await saveProfile('alice-token');

    const response = await exportFor('alice-token', '203.0.113.7');
    expect(response.statusCode).toBe(200);

    const document = dataExportSchema.parse(response.json());
    expect(document.account.email).toBe('alice@example.com');
    expect(document.profile?.displayName).toBe('Alice A.');
    // Decrypted, and this is the only response in the application that carries
    // a street line in full (ADR 0019).
    expect(document.profile?.address?.line1).toBe('12 Acacia Avenue');
    expect(document.profile?.address?.postcode).toBe('BS7 8AA');
  });

  it('returns only the caller’s own data, never another’s', async () => {
    // Both accounts have profiles; each export must contain exactly one of
    // them. There is no id in the path, so there is no ownership check to
    // forget — this asserts the structural guarantee holds over HTTP.
    await saveProfile('alice-token');
    await saveProfile('bob-token');

    const alice = dataExportSchema.parse((await exportFor('alice-token')).json());
    const bob = dataExportSchema.parse((await exportFor('bob-token')).json());

    expect(alice.account.email).toBe('alice@example.com');
    expect(bob.account.email).toBe('bob@example.com');
    expect(alice.account.id).not.toBe(bob.account.id);
  });

  it('ignores a query parameter naming somebody else', async () => {
    const bobId = await idOf('bob-token');
    await saveProfile('bob-token');

    const response = await app.inject({
      method: 'GET',
      url: `${ME_EXPORT_PATH}?userId=${bobId}`,
      headers: auth('alice-token'),
    });

    const document = dataExportSchema.parse(response.json());
    expect(document.account.id).not.toBe(bobId);
    expect(document.account.email).toBe('alice@example.com');
  });

  it('records the disclosure against the caller', async () => {
    await exportFor('alice-token', '198.51.100.4');

    const entry = audit.log.entries().find((e) => e.action === 'account.exported');
    expect(entry).toMatchObject({ targetType: 'user', ipAddress: '198.51.100.4' });
  });

  it('is refused for a deleted account', async () => {
    // The guard refuses the session, so a deleted person cannot pull a copy of
    // data that no longer exists. Worth pinning: an export route that outlived
    // deletion would be a way to read a tombstone.
    await saveProfile('alice-token');
    await requestDeletion('alice-token');

    expect((await exportFor('alice-token')).statusCode).toBe(401);
  });

  it('names a dated file, so two exports do not collide', async () => {
    const document = dataExportSchema.parse((await exportFor('alice-token')).json());
    expect(exportFilename(document.exportedAt)).toMatch(
      /^account-data-\d{4}-\d{2}-\d{2}\.json$/,
    );
  });
});

describe('GET /admin/users/:userId/activity', () => {
  const REASON = 'support ticket 4821, account access query';

  const asAdmin = (token: string, userId: string, reason = REASON) =>
    app.inject({
      method: 'GET',
      url: adminActivityPath(userId, reason),
      headers: auth(token),
    });

  it('rejects an unauthenticated request', async () => {
    expect(
      (await app.inject({ method: 'GET', url: adminActivityPath('x', REASON) }))
        .statusCode,
    ).toBe(401);
  });

  it('refuses an ordinary user', async () => {
    // 403 rather than 404: they already know the URL, and hiding it makes a
    // genuine permissions bug indistinguishable from a typo.
    const bobId = await idOf('bob-token');
    expect((await asAdmin('alice-token', bobId)).statusCode).toBe(403);
  });

  it('refuses an administrator with no verified second factor', async () => {
    // The ordinary case — an admin signed in with a password alone. MFA is
    // required of administrators (BRD §8.1), enforced at the guard so it
    // cannot be forgotten on a route.
    const bobId = await idOf('bob-token');
    await promote('alice-token');

    expect((await asAdmin('alice-token', bobId)).statusCode).toBe(403);
  });

  it('refuses an administrator whose token carries no factor claim', async () => {
    // The failure that matters most: an instance provisioned without the claim
    // emits correctly-signed tokens carrying no proof of a second factor.
    // Treating that as satisfied would open the admin surface silently.
    const bobId = await idOf('bob-token');
    await promote('admin-no-claim');

    expect((await asAdmin('admin-no-claim', bobId)).statusCode).toBe(403);
  });

  it('allows an administrator with a recent second factor', async () => {
    const bobId = await idOf('bob-token');
    await promote('admin-token');

    const response = await asAdmin('admin-token', bobId);
    expect(response.statusCode).toBe(200);
    expect(
      activityResponseSchema.parse(response.json()).entries.length,
    ).toBeGreaterThan(0);
  });

  it.each([
    ['absent', ''],
    ['too short', 'because'],
    ['only whitespace', '            '],
  ])('refuses a reason that is %s', async (_label, reason) => {
    // BRD §8.13 requires a reason on every admin action. The length bound does
    // not judge quality — nothing stops somebody typing nonsense — but it does
    // stop an empty box being submitted by habit.
    const bobId = await idOf('bob-token');
    await promote('admin-token');

    const response = await app.inject({
      method: 'GET',
      url: `/admin/users/${bobId}/activity?reason=${encodeURIComponent(reason)}`,
      headers: auth('admin-token'),
    });

    expect(response.statusCode).toBe(400);
  });

  it('records the disclosure with its reason, before performing it', async () => {
    const bobId = await idOf('bob-token');
    const adminId = await promote('admin-token');

    await asAdmin('admin-token', bobId);

    const entry = audit.log.entries().find((e) => e.action === 'admin.activity_viewed');
    expect(entry).toMatchObject({
      actorId: adminId,
      targetType: 'user',
      targetId: bobId,
      reason: REASON,
    });
  });

  it('never serves the account holder’s session ids to an administrator', async () => {
    // The one place this route deliberately shows less than the person's own
    // page. A session id groups an account's actions into sittings, so a trail
    // full of them describes when and how often somebody uses the platform —
    // the location-and-device history ADR 0025 refused support, and outside the
    // narrowest-thing-that-helps projection of ADR 0022.
    //
    // Asserted against the **raw body**, not the parsed object. The schema
    // permits the field, so parsing first would carry a leak straight through
    // and this test would pass for the wrong reason.
    const bobId = await idOf('bob-token');
    await promote('admin-token');

    const response = await asAdmin('admin-token', bobId);

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/sess_/);

    // Withheld, not merely absent. Without this the assertion above passes just
    // as well when no session was ever recorded on Bob's own entries.
    const own = audit.log.entries().find((e) => e.actorId === bobId);
    expect(own?.sessionId).toMatch(/^sess_/);
  });

  it('records nothing when the reason was refused', async () => {
    // The read did not happen, so the trail must not claim it did.
    const bobId = await idOf('bob-token');
    await promote('admin-token');

    await asAdmin('admin-token', bobId, 'no');

    expect(
      audit.log.entries().filter((e) => e.action === 'admin.activity_viewed'),
    ).toHaveLength(0);
  });

  it('shows the subject who looked at their account, and why', async () => {
    // Most of the point of recording a reason: the person it happened to can
    // read it on their own activity page. The entry is stored against the
    // *administrator* as actor, so reaching Bob depends entirely on the trail
    // being read from the target side too — which is what this asserts.
    const bobId = await idOf('bob-token');
    await promote('admin-token');
    await asAdmin('admin-token', bobId);

    const response = await app.inject({
      method: 'GET',
      url: ME_ACTIVITY_PATH,
      headers: auth('bob-token'),
    });

    const { entries } = activityResponseSchema.parse(response.json());
    const disclosure = entries.find((e) => e.action === 'admin.activity_viewed');

    expect(disclosure).toMatchObject({ by: 'administrator', reason: REASON });
  });

  it('does not give the subject the administrator’s address', async () => {
    // The address on that entry belongs to the administrator, not to Bob.
    // Handing a support worker's address to the account they were asked to
    // investigate is the kind of leak only noticed after it matters.
    const bobId = await idOf('bob-token');
    await promote('admin-token');

    await app.inject({
      method: 'GET',
      url: adminActivityPath(bobId, REASON),
      headers: { ...auth('admin-token'), [CLIENT_IP_HEADER]: '198.51.100.9' },
    });

    const { entries } = activityResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: ME_ACTIVITY_PATH,
          headers: auth('bob-token'),
        })
      ).json(),
    );

    const disclosure = entries.find((e) => e.action === 'admin.activity_viewed');
    expect(disclosure?.ipAddress).toBeNull();

    // And the address really was recorded — this is withholding, not an empty
    // column. Asserting only the null above would pass just as well if the
    // header had never been read.
    expect(
      audit.log.entries().find((e) => e.action === 'admin.activity_viewed'),
    ).toMatchObject({ ipAddress: '198.51.100.9' });
  });

  it('keeps the subject’s own address on their own actions', async () => {
    // The counterpart to the test above: withholding applies to somebody
    // else's entries, not to a person's own, where the address is the whole
    // value of the record.
    await saveProfile('bob-token', '203.0.113.20');

    const { entries } = activityResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: ME_ACTIVITY_PATH,
          headers: auth('bob-token'),
        })
      ).json(),
    );

    expect(entries.find((e) => e.action === 'profile.created')).toMatchObject({
      by: 'subject',
      ipAddress: '203.0.113.20',
    });
  });

  it('returns the target’s entries, not the administrator’s own', async () => {
    const bobId = await idOf('bob-token');
    await saveProfile('bob-token');
    await promote('admin-token');

    const { entries } = activityResponseSchema.parse(
      (await asAdmin('admin-token', bobId)).json(),
    );

    // Bob provisioned and created a profile; the admin did neither.
    expect(entries.map((e) => e.action)).toContain('profile.created');
  });

  it('shows support the same history the account holder sees', async () => {
    // A support view that showed less than the person can see themselves makes
    // every enquiry start with the two sides describing different histories.
    const bobId = await idOf('bob-token');
    await saveProfile('bob-token');
    await promote('admin-token');
    await asAdmin('admin-token', bobId);

    const adminView = activityResponseSchema.parse(
      (await asAdmin('admin-token', bobId)).json(),
    );
    const ownView = activityResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: ME_ACTIVITY_PATH,
          headers: auth('bob-token'),
        })
      ).json(),
    );

    // The admin's second read is recorded before it returns, so their view
    // carries one entry the earlier own-view fetch cannot. Compare the actions
    // present rather than the counts.
    expect(new Set(adminView.entries.map((e) => e.action))).toEqual(
      new Set(ownView.entries.map((e) => e.action)),
    );
  });

  it('answers 404 for a malformed account id, and records nothing', async () => {
    // `audit_logs.targetId` is a uuid column and the disclosure is recorded
    // before the read, so an unvalidated path parameter would throw on the
    // insert — and a fail-closed audit write turns that into a 500 on the
    // action it was meant to record.
    await promote('admin-token');

    const response = await asAdmin('admin-token', 'banana');

    expect(response.statusCode).toBe(404);
    expect(
      audit.log.entries().filter((e) => e.action === 'admin.activity_viewed'),
    ).toHaveLength(0);
  });
});

describe('GET /admin/users/:userId', () => {
  const REASON = 'support ticket 4821, cannot sign in';

  const viewAs = (token: string, userId: string, reason = REASON) =>
    app.inject({
      method: 'GET',
      url: adminUserPath(userId, reason),
      headers: auth(token),
    });

  it('rejects an unauthenticated request', async () => {
    expect(
      (await app.inject({ method: 'GET', url: adminUserPath('x', REASON) })).statusCode,
    ).toBe(401);
  });

  it('refuses an ordinary user', async () => {
    const bobId = await idOf('bob-token');
    expect((await viewAs('alice-token', bobId)).statusCode).toBe(403);
  });

  it('refuses an administrator with no verified second factor', async () => {
    // MFA is required of administrators at the guard, for the role rather than
    // the route, so a new admin route cannot exist without it (ADR 0021).
    const bobId = await idOf('bob-token');
    await promote('alice-token');

    expect((await viewAs('alice-token', bobId)).statusCode).toBe(403);
  });

  it('refuses an administrator whose token carries no factor claim', async () => {
    const bobId = await idOf('bob-token');
    await promote('admin-no-claim');

    expect((await viewAs('admin-no-claim', bobId)).statusCode).toBe(403);
  });

  it.each([
    ['absent', ''],
    ['too short', 'because'],
    ['only whitespace', '            '],
  ])('refuses a reason that is %s', async (_label, reason) => {
    const bobId = await idOf('bob-token');
    await promote('admin-token');

    expect((await viewAs('admin-token', bobId, reason)).statusCode).toBe(400);
  });

  it('answers with the account and the profile summary', async () => {
    const bobId = await idOf('bob-token');
    await saveProfile('bob-token');
    await promote('admin-token');

    const view = adminUserViewSchema.parse((await viewAs('admin-token', bobId)).json());

    expect(view.account).toMatchObject({ id: bobId, email: 'bob@example.com' });
    expect(view.profile).toMatchObject({
      displayName: PROFILE.displayName,
      hasPhone: true,
      address: { town: 'Bristol', outwardCode: 'BS7' },
    });
  });

  it('never carries a street line, a full postcode or a phone number', async () => {
    // Asserted against the **raw body**, not the parsed object. Zod strips
    // unknown keys, so parsing first would hide the very leak this is looking
    // for and the test would pass for the wrong reason (slice 1.4's lesson).
    const bobId = await idOf('bob-token');
    await saveProfile('bob-token');
    await promote('admin-token');

    const body = (await viewAs('admin-token', bobId)).body;

    expect(body).not.toContain(PROFILE.address.line1);
    expect(body).not.toContain(PROFILE.address.postcode);
    // The stored number is normalised to E.164, so check both forms.
    expect(body).not.toContain(PROFILE.phone);
    expect(body).not.toContain('+447700900123');
    // ...and the district really is there, so the assertions above are not
    // passing merely because the profile was empty.
    expect(body).toContain('BS7');
  });

  it('says a profile is absent rather than inventing an empty one', async () => {
    const bobId = await idOf('bob-token');
    await promote('admin-token');

    const view = adminUserViewSchema.parse((await viewAs('admin-token', bobId)).json());
    expect(view.profile).toBeNull();
  });

  it('shows a deleted account, with its timestamps', async () => {
    // The opposite of the public profile route, deliberately. Support is asked
    // about a deleted account precisely because it was deleted, and the
    // anti-enumeration reasoning does not apply to a named administrator in an
    // audit trail.
    const bobId = await idOf('bob-token');
    await saveProfile('bob-token');
    await requestDeletion('bob-token');
    await promote('admin-token');

    const view = adminUserViewSchema.parse((await viewAs('admin-token', bobId)).json());

    expect(view.account.deletedAt).not.toBeNull();
    expect(view.account.deletionRequestedAt).not.toBeNull();
    // Erased in 1.5b, so there is nothing left to summarise.
    expect(view.profile).toBeNull();
  });

  it('records the disclosure with its reason, before performing it', async () => {
    const bobId = await idOf('bob-token');
    const adminId = await promote('admin-token');

    await viewAs('admin-token', bobId);

    expect(
      audit.log.entries().find((e) => e.action === 'admin.user_viewed'),
    ).toMatchObject({
      actorId: adminId,
      targetType: 'user',
      targetId: bobId,
      reason: REASON,
    });
  });

  it('records a lookup that found nothing', async () => {
    // A well-formed id for an account that does not exist. The administrator
    // asked, and a trail holding only the successful lookups is the wrong half.
    await promote('admin-token');

    const response = await viewAs(
      'admin-token',
      '11111111-1111-4111-8111-111111111111',
    );

    expect(response.statusCode).toBe(404);
    expect(
      audit.log.entries().filter((e) => e.action === 'admin.user_viewed'),
    ).toHaveLength(1);
  });

  it('records nothing when the reason was refused', async () => {
    const bobId = await idOf('bob-token');
    await promote('admin-token');

    await viewAs('admin-token', bobId, 'no');

    expect(
      audit.log.entries().filter((e) => e.action === 'admin.user_viewed'),
    ).toHaveLength(0);
  });

  it('answers 404 for a malformed account id, and records nothing', async () => {
    await promote('admin-token');

    expect((await viewAs('admin-token', 'banana')).statusCode).toBe(404);
    expect(
      audit.log.entries().filter((e) => e.action === 'admin.user_viewed'),
    ).toHaveLength(0);
  });

  it('shows the subject who looked at their account, and why', async () => {
    // The same control the activity disclosure has, on the wider disclosure.
    const bobId = await idOf('bob-token');
    await promote('admin-token');
    await viewAs('admin-token', bobId);

    const { entries } = activityResponseSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: ME_ACTIVITY_PATH,
          headers: auth('bob-token'),
        })
      ).json(),
    );

    expect(entries.find((e) => e.action === 'admin.user_viewed')).toMatchObject({
      by: 'administrator',
      reason: REASON,
      ipAddress: null,
    });
  });
});
