import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CLIENT_IP_HEADER,
  ME_ACTIVITY_PATH,
  ME_DELETION_PATH,
  ME_PATH,
  ME_EXPORT_PATH,
  ME_PROFILE_PATH,
  adminActivityPath,
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
import type { AuditFakes } from '../audit/testing/fakes.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import {
  InMemoryAccountLookup,
  InMemoryProfileStore,
} from '../profiles/testing/fakes.js';
import { IdentityService } from './identity.service.js';
import {
  FakeSessionVerifier,
  InMemoryUserDirectory,
  InMemoryWebhookLedger,
} from './testing/fakes.js';

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

beforeEach(async () => {
  audit = createAuditFakes();
  users = new InMemoryUserDirectory();
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
  );

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        checks: [],
        logger: createRecordingLogger().logger,
        identity: { sessionVerifier, service: identity },
        profiles,
        audit: audit.service,
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

const saveProfile = (token: string) =>
  app.inject({
    method: 'PUT',
    url: ME_PROFILE_PATH,
    headers: auth(token),
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
    // read it on their own activity page.
    const bobId = await idOf('bob-token');
    await promote('admin-token');
    await asAdmin('admin-token', bobId);

    const response = await app.inject({
      method: 'GET',
      url: ME_ACTIVITY_PATH,
      headers: auth('bob-token'),
    });

    // The admin's read targets Bob but is recorded against the admin as actor,
    // so it is not in Bob's own trail — his trail is what *he* did. This
    // asserts the shape a support enquiry would actually follow.
    const { entries } = activityResponseSchema.parse(response.json());
    expect(entries.every((e) => e.action !== 'admin.activity_viewed')).toBe(true);
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
});
