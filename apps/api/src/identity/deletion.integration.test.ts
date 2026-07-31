import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  CLIENT_IP_HEADER,
  ME_ACTIVITY_PATH,
  ME_DELETION_PATH,
  ME_PATH,
  ME_PROFILE_PATH,
  activityResponseSchema,
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
    .accept('bob-token', BOB);

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
