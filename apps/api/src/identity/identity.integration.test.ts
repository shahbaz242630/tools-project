import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { CLERK_EVENTS_PATH, ME_PATH, meResponseSchema } from '@platform/contracts';
import { createRecordingLogger } from '@platform/observability/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createIdentityFakes } from './testing/fakes.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import {
  createCatalogueFakes,
  createListingFakes,
} from '../catalogue/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import type { IdentityFakes } from './testing/fakes.js';
import { createNoopMetrics } from '@platform/observability';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';

/**
 * Boots the real application — real routing, real guard, real exception filter
 * — against fakes.
 *
 * The unit tests prove each part in isolation. This proves the guard is
 * actually attached: a `canActivate` that rejects perfectly and was never wired
 * to the controller lets every request through, and no unit test can see that.
 *
 * It is also where BRD §14's Phase 1 exit gate starts being answered —
 * "automated tests prove users cannot read or modify another user's private
 * data" — because that claim is only meaningful against real routing.
 */

const ALICE = {
  clerkUserId: 'user_alice',
  sessionId: 'sess_a',
  email: 'alice@example.com',
};
const BOB = { clerkUserId: 'user_bob', sessionId: 'sess_b', email: 'bob@example.com' };

let app: NestFastifyApplication;
let fakes: IdentityFakes;

beforeEach(async () => {
  fakes = createIdentityFakes();
  fakes.sessionVerifier.accept('alice-token', ALICE).accept('bob-token', BOB);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        // A real registry is not wanted here: these tests are about routing and
        // authorisation, and a metrics backend that collected would make two
        // suites in one process share series.
        metrics: createNoopMetrics(),
        checks: [],
        logger: createRecordingLogger().logger,
        identity: { sessionVerifier: fakes.sessionVerifier, service: fakes.service },
        profiles: createProfileFakes().service,
        audit: createAuditFakes().service,
        catalogue: createCatalogueFakes().service,
        featureFlags: createFeatureFlagFakes().service,
        listings: createListingFakes().service,
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

const me = (token?: string) =>
  app.inject({
    method: 'GET',
    url: ME_PATH,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

describe('GET /me', () => {
  it('answers with the caller’s own account', async () => {
    const response = await me('alice-token');

    expect(response.statusCode).toBe(200);
    // Parsed against the shared contract, not merely inspected — the web app
    // parses the same schema, so a drift here fails on this side first.
    const body = meResponseSchema.parse(response.json());
    expect(body.email).toBe('alice@example.com');
    expect(body.role).toBe('USER');
  });

  it('provisions the mirror row on first request', async () => {
    expect(fakes.users.all()).toHaveLength(0);
    await me('alice-token');
    expect(fakes.users.all()).toHaveLength(1);
  });

  it('never exposes the Clerk identifier', async () => {
    // Our id is the platform identity. Leaking Clerk's invites it into a URL,
    // and from there into somewhere it becomes a de facto key.
    const body: unknown = (await me('alice-token')).json();
    expect(JSON.stringify(body)).not.toContain('user_alice');
  });

  it.each([
    ['no authorization header', undefined],
    ['an unknown token', 'not-a-real-token'],
  ])('rejects a request with %s', async (_case, token) => {
    expect((await me(token)).statusCode).toBe(401);
  });

  it.each([
    ['Bearer'],
    ['Bearer  '],
    ['alice-token'],
    ['Basic alice-token'],
    ['Bearer alice-token extra'],
  ])('rejects the malformed authorization header %j', async (header) => {
    const response = await app.inject({
      method: 'GET',
      url: ME_PATH,
      headers: { authorization: header },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a lower-case bearer scheme', async () => {
    // The standard says the scheme is case-insensitive, and a client sending
    // `bearer` is not an attacker.
    const response = await app.inject({
      method: 'GET',
      url: ME_PATH,
      headers: { authorization: 'bearer alice-token' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('never says why a token was rejected', async () => {
    // Distinguishing expired from malformed from wrong-signature tells whoever
    // is probing which part of their forgery to fix.
    const body = JSON.stringify((await me('not-a-real-token')).json());
    expect(body).not.toMatch(/expired|signature|unknown token|azp/i);
  });
});

describe('one account cannot read another’s', () => {
  it('gives each caller a different account', async () => {
    const alice = meResponseSchema.parse((await me('alice-token')).json());
    const bob = meResponseSchema.parse((await me('bob-token')).json());

    expect(alice.id).not.toBe(bob.id);
    expect(alice.email).toBe('alice@example.com');
    expect(bob.email).toBe('bob@example.com');
  });

  it('answers from the token, not from anything the caller asserts', async () => {
    // The web app is trusted transport, not a trusted claimant. Headers naming
    // a different user must change nothing — this is the check that would fail
    // if someone ever "optimised" the guard into reading a forwarded id.
    const response = await app.inject({
      method: 'GET',
      url: ME_PATH,
      headers: {
        authorization: 'Bearer alice-token',
        'x-user-id': 'user_bob',
        'x-user-email': 'bob@example.com',
      },
    });

    expect(meResponseSchema.parse(response.json()).email).toBe('alice@example.com');
  });

  it('rejects a session whose account has been deleted', async () => {
    await me('alice-token');
    await fakes.service.applyEvent('msg_1', {
      type: 'user.deleted',
      clerkUserId: 'user_alice',
    });

    expect((await me('alice-token')).statusCode).toBe(401);
  });
});

describe('POST the internal clerk events route', () => {
  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: CLERK_EVENTS_PATH, payload });

  it('carries event_attributes all the way to the stored sign-in', async () => {
    // **The test that was missing.** The mapper reads the device from
    // `event_attributes`, a sibling of `data` — but the controller destructured
    // only `data`, and because the mapper's parameter was optional at the time,
    // the whole thing typechecked, every unit test passed, and the sign-in
    // history recorded nothing but timestamps.
    //
    // A unit test of the mapper cannot catch that: it passes the attributes in
    // by hand. Only a test through the real route, asserting on what was
    // actually stored, closes the gap.
    await post({
      deliveryId: 'msg_user',
      type: 'user.created',
      data: {
        id: 'user_dave',
        primary_email_address_id: 'idn_d',
        email_addresses: [{ id: 'idn_d', email_address: 'dave@example.com' }],
      },
    });

    const response = await post({
      deliveryId: 'msg_session',
      type: 'session.created',
      data: {
        id: 'sess_dave_1',
        user_id: 'user_dave',
        created_at: 1785661283293,
        updated_at: 1785661283331,
      },
      eventAttributes: {
        http_request: {
          client_ip: '2.49.99.113',
          user_agent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
        },
      },
    });

    expect(response.json()).toEqual({ outcome: 'applied' });
    expect(fakes.authenticationEvents.all()).toEqual([
      expect.objectContaining({
        clerkSessionId: 'sess_dave_1',
        event: 'started',
        activity: {
          ipAddress: '2.49.99.113',
          browserName: 'Edge',
          browserVersion: '150',
          deviceType: 'Windows',
          isMobile: false,
        },
      }),
    ]);
  });

  it('records a session event that arrives with no attributes', async () => {
    // Absent attributes are normal — every `user.*` delivery has none — and
    // must not turn a storable sign-in into a rejected delivery.
    await post({
      deliveryId: 'msg_user_2',
      type: 'user.created',
      data: {
        id: 'user_erin',
        primary_email_address_id: 'idn_e',
        email_addresses: [{ id: 'idn_e', email_address: 'erin@example.com' }],
      },
    });

    const response = await post({
      deliveryId: 'msg_session_2',
      type: 'session.created',
      data: {
        id: 'sess_erin_1',
        user_id: 'user_erin',
        created_at: 1785661283293,
        updated_at: 1785661283331,
      },
    });

    expect(response.json()).toEqual({ outcome: 'applied' });
    expect(fakes.authenticationEvents.all()).toHaveLength(1);
  });

  it('applies a forwarded event', async () => {
    const response = await post({
      deliveryId: 'msg_1',
      type: 'user.created',
      data: {
        id: 'user_carol',
        primary_email_address_id: 'idn_1',
        email_addresses: [{ id: 'idn_1', email_address: 'carol@example.com' }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ outcome: 'applied' });
    expect(fakes.users.all()).toHaveLength(1);
  });

  it('reports a redelivery as a duplicate rather than failing', async () => {
    const payload = {
      deliveryId: 'msg_1',
      type: 'user.created',
      data: {
        id: 'user_carol',
        primary_email_address_id: 'idn_1',
        email_addresses: [{ id: 'idn_1', email_address: 'carol@example.com' }],
      },
    };

    await post(payload);
    const second = await post(payload);

    // Answering with an error would make Clerk retry a delivery that has
    // already been applied, forever.
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual({ outcome: 'duplicate' });
    expect(fakes.users.all()).toHaveLength(1);
  });

  it('ignores an event type we do not act on', async () => {
    // Was `session.created` until slice 1.11a, which made that one meaningful.
    // The rule under test is unchanged — a subscription widened from Clerk's
    // dashboard must not become a stream of failed deliveries — so the claim
    // moved to an event we genuinely do not act on rather than the assertion
    // being loosened.
    const response = await post({
      deliveryId: 'msg_2',
      type: 'organization.created',
      data: { id: 'org_x' },
    });

    expect(response.json()).toEqual({ outcome: 'ignored' });
  });

  it.each([
    ['an empty body', {}],
    ['no delivery id', { type: 'user.created', data: {} }],
    ['no type', { deliveryId: 'msg_1', data: {} }],
  ])('rejects %s', async (_case, payload) => {
    expect((await post(payload)).statusCode).toBe(400);
  });

  it('rejects a payload it cannot map rather than retrying forever', async () => {
    // 400 tells Clerk to stop. A 500 would be retried against a payload that
    // will never map.
    const response = await post({
      deliveryId: 'msg_3',
      type: 'user.created',
      data: { id: 'user_x', email_addresses: [] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('needs no session token', async () => {
    // A webhook speaks for a provider, not a user. Guarding it with AuthGuard
    // would make it permanently unusable.
    const response = await post({
      deliveryId: 'msg_4',
      type: 'session.created',
      data: {},
    });

    expect(response.statusCode).not.toBe(401);
  });
});
