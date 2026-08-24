import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  DEFAULT_MAXIMUM_RENTAL_DAYS,
  LISTINGS_ROUTE,
  DEFAULT_REQUEST_EXPIRY_HOURS,
  LISTING_MEDIA_LIMIT,
  listingMediaItemPath,
  listingMediaOrderPath,
  listingMediaPath,
  parseOwnerListingMedia,
  parseOwnerListingMediaList,
} from '@platform/contracts';
import { createNoopMetrics } from '@platform/observability';
import { createRecordingLogger } from '@platform/observability/testing';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { createAuditFakes } from '../audit/testing/fakes.js';
import type { AuditFakes } from '../audit/testing/fakes.js';
import { bookingModuleFakes } from '../booking/testing/fakes.js';
import { createFeatureFlagFakes } from '../feature-flags/testing/fakes.js';
import { createIdentityFakes } from '../identity/testing/fakes.js';
import type { IdentityFakes } from '../identity/testing/fakes.js';
import { createProfileFakes } from '../profiles/testing/fakes.js';
import { allowAllRateLimiter } from '../rate-limiting/testing/fakes.js';
import { CatalogueService } from './catalogue.service.js';
import { MAX_INPUT_BYTES } from './prepare-image.js';
import {
  IMAGE_UPLOAD_BODY_LIMIT,
  registerImageUploadParser,
} from './image-upload-parser.js';
import { InMemoryCategoryStore, createListingFakes } from './testing/fakes.js';
import type { ListingFakes } from './testing/fakes.js';

/**
 * An owner's photographs, over the real module (slice 2.6b-i).
 *
 * The house pattern for Catalogue: there is no `listing-media.service.test.ts`,
 * because routing, authorisation and the service's rules are all proved here
 * against a booted `AppModule` with fakes underneath. What this file cannot
 * prove — the foreign key, the cascade, the ordering the database actually
 * returns — is in `prisma-listing-media-store.db.test.ts`.
 */

const ALICE = {
  clerkUserId: 'user_alice',
  sessionId: 'sess_a',
  email: 'alice@example.com',
};
const BOB = {
  clerkUserId: 'user_bob',
  sessionId: 'sess_b',
  email: 'bob@example.com',
};

const ME_PATH = '/me';

let app: NestFastifyApplication;
let audit: AuditFakes;
let identity: IdentityFakes;
let listings: ListingFakes;
/** One category per test, created lazily by the first listing that needs it. */
let categoryCreated = false;

/** A real JPEG, encoded here so the pipeline has something genuine to decode. */
async function photograph(width = 900, height = 600): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 60 } },
  })
    .jpeg()
    .toBuffer();
}

beforeEach(async () => {
  audit = createAuditFakes();
  identity = createIdentityFakes(audit);
  const profiles = createProfileFakes(audit);
  const categories = new InMemoryCategoryStore();
  listings = createListingFakes(categories);
  categoryCreated = false;

  identity.sessionVerifier.accept('alice-token', ALICE).accept('bob-token', BOB);

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        rateLimiter: allowAllRateLimiter,
        metrics: createNoopMetrics(),
        checks: [],
        logger: createRecordingLogger().logger,
        identity: {
          sessionVerifier: identity.sessionVerifier,
          service: identity.service,
          accountData: identity.accountData,
          accountAdmin: identity.accountAdmin,
          roleApprovals: identity.roleApprovals,
        },
        profiles: profiles.service,
        audit: audit.service,
        catalogue: new CatalogueService(
          categories,
          audit.service,
          createRecordingLogger().logger,
        ),
        featureFlags: createFeatureFlagFakes().service,
        listings: listings.service,
        listingMedia: listings.media.service,
        ...bookingModuleFakes(),
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  /*
   * The same registration `bootstrap` performs, from the same function.
   * Repeating the four lines here instead would prove that the *test's* parser
   * works while production's could be deleted with nothing failing.
   */
  registerImageUploadParser(app.getHttpAdapter().getInstance());

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterEach(async () => {
  await app.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function idOf(token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: ME_PATH,
    headers: auth(token),
  });
  return (response.json() as { id: string }).id;
}

/** A category to list in. Created through the store, as an administrator would. */
async function givenACategory(): Promise<void> {
  const author = await idOf('alice-token');
  await listings.categories.create(
    {
      slug: 'outdoor-gardening',
      name: 'Outdoor and gardening',
      riskLevel: 'medium',
      reportableActivity: 'none',
      attributes: [],
      transportOptions: [],
      feePolicy: {
        ownerCommissionBasisPoints: 1_500,
        renterFeeBasisPoints: 800,
        minimumBookingTotal: { amount: 1_000, currency: 'GBP' as const },
        minimumPlatformFee: { amount: 100, currency: 'GBP' as const },
      },
      damageSecurity: {
        excessFloor: { amount: 7_500, currency: 'GBP' as const },
        excessPercentageBasisPoints: 1_500,
        recoveryCeiling: { amount: 50_000, currency: 'GBP' as const },
      },
      maximumRentalDays: DEFAULT_MAXIMUM_RENTAL_DAYS,
      requestExpiryHours: DEFAULT_REQUEST_EXPIRY_HOURS,
    },
    author,
  );
}

/**
 * A listing belonging to whoever holds this token.
 *
 * **Created through the real route, not written into the store.** A hand-built
 * record has to guess at the shape the store expects, and the first guess was
 * wrong in a way that only surfaced as a crash inside a fake. Posting it means
 * the fixture is whatever the application actually produces.
 */
async function givenAListing(token = 'alice-token'): Promise<string> {
  if (!categoryCreated) {
    await givenACategory();
    categoryCreated = true;
  }

  const response = await app.inject({
    method: 'POST',
    url: LISTINGS_ROUTE,
    headers: auth(token),
    payload: {
      categorySlug: 'outdoor-gardening',
      title: 'Petrol hedge trimmer',
      description: 'Serviced last spring.',
      replacementValue: { amount: 24_999, currency: 'GBP' },
      categoryVersionNumber: 1,
      attributes: {},
      transportRequirement: null,
      requiresTwoPersonLift: false,
      collectionLocation: null,
      rates: { daily: null, weekend: null, weekly: null },
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(
      `The listing fixture did not save: ${String(response.statusCode)} ${response.body}`,
    );
  }

  return (response.json() as { id: string }).id;
}

function upload(listingId: string, bytes: Buffer, token = 'alice-token') {
  return app.inject({
    method: 'POST',
    url: listingMediaPath(listingId),
    headers: { ...auth(token), 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
}

describe('adding a photograph', () => {
  it('stores it and hands back a signed URL for both renditions', async () => {
    const listingId = await givenAListing();

    const response = await upload(listingId, await photograph());

    expect(response.statusCode).toBe(201);
    const media = parseOwnerListingMedia(response.json());
    expect(media.position).toBe(0);
    expect(media.display.url).toContain('http');
    expect(media.thumbnail.url).toContain('http');
    // Two objects per photograph, not one.
    expect(listings.media.objects.size).toBe(2);
  });

  it('stores bytes carrying no EXIF, whatever arrived', async () => {
    const listingId = await givenAListing();
    const withGps = await sharp(await photograph())
      .withExif({
        IFD0: { Make: 'PrivacyLeakCam' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 26/1' },
      })
      .jpeg()
      .toBuffer();

    await upload(listingId, withGps);

    /*
     * Asserted on the stored bytes rather than on the response, because the
     * response carries a URL and not an image. This is the end-to-end form of
     * `prepare-image.test.ts`'s assertion: the thing that actually reaches the
     * bucket is what matters, and a route that forgot to run the pipeline would
     * pass every other test in this file.
     */
    for (const key of listings.media.objects.written) {
      const stored = listings.media.objects.read(key);
      expect(stored?.bytes.toString('latin1')).not.toContain('PrivacyLeakCam');
    }
  });

  it('appends, so a second photograph goes after the first', async () => {
    const listingId = await givenAListing();

    await upload(listingId, await photograph());
    const second = await upload(listingId, await photograph(400, 400));

    expect(parseOwnerListingMedia(second.json()).position).toBe(1);
  });

  it('refuses an anonymous caller', async () => {
    const listingId = await givenAListing();

    const response = await app.inject({
      method: 'POST',
      url: listingMediaPath(listingId),
      headers: { 'content-type': 'application/octet-stream' },
      payload: await photograph(),
    });

    expect(response.statusCode).toBe(401);
  });

  it('answers 404 for somebody else’s listing, never 403', async () => {
    const listingId = await givenAListing('alice-token');

    const response = await upload(listingId, await photograph(), 'bob-token');

    // 403 would confirm the listing exists, which is the whole thing the check
    // protects.
    expect(response.statusCode).toBe(404);
    expect(listings.media.objects.size).toBe(0);
  });

  it('refuses a file that is not an image, with a reason', async () => {
    const listingId = await givenAListing();

    const response = await upload(listingId, Buffer.from('PK not a jpeg'));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ reason: 'not-an-image' });
    // Nothing reached the store, so a refusal costs no bytes.
    expect(listings.media.objects.size).toBe(0);
  });

  it('refuses an eleventh photograph, naming the limit', async () => {
    const listingId = await givenAListing();
    for (let i = 0; i < LISTING_MEDIA_LIMIT; i++) {
      expect((await upload(listingId, await photograph(120, 120))).statusCode).toBe(
        201,
      );
    }

    const response = await upload(listingId, await photograph(120, 120));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ reason: 'too-many-photographs' });
  });

  it('checks the count before decoding, so being at the limit is cheap', async () => {
    const listingId = await givenAListing();
    for (let i = 0; i < LISTING_MEDIA_LIMIT; i++) {
      await upload(listingId, await photograph(120, 120));
    }

    // Garbage that would fail to decode. `too-many-photographs` rather than
    // `not-an-image` proves the cap was consulted first — the ordering that
    // stops an owner at their limit paying for two encodes to be told no.
    const response = await upload(listingId, Buffer.from('not an image at all'));

    expect(response.json()).toMatchObject({ reason: 'too-many-photographs' });
  });

  it('reports a storage outage as 503, not as a bad photograph', async () => {
    const listingId = await givenAListing();
    listings.media.objects.willFail();

    const response = await upload(listingId, await photograph());

    // The caller's file was fine. A 422 here would tell an owner to fix a
    // photograph that has nothing wrong with it.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ reason: 'storage-unavailable' });
  });

  it('refuses a body sent as something other than raw bytes', async () => {
    const listingId = await givenAListing();

    const response = await app.inject({
      method: 'POST',
      url: listingMediaPath(listingId),
      headers: auth('alice-token'),
      payload: { image: 'no' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('writes no audit entry — an owner’s own write is not administrative', async () => {
    const listingId = await givenAListing();

    await upload(listingId, await photograph());

    expect(
      audit.log.entries().filter((entry) => entry.targetType === 'listing'),
    ).toHaveLength(0);
  });
});

describe('listing photographs', () => {
  it('returns them in the owner’s order', async () => {
    const listingId = await givenAListing();
    await upload(listingId, await photograph(300, 300));
    await upload(listingId, await photograph(400, 400));

    const response = await app.inject({
      method: 'GET',
      url: listingMediaPath(listingId),
      headers: auth('alice-token'),
    });

    expect(response.statusCode).toBe(200);
    const { media } = parseOwnerListingMediaList(response.json());
    expect(media.map((item) => item.position)).toEqual([0, 1]);
  });

  it('answers 404 for somebody else’s listing rather than an empty list', async () => {
    const listingId = await givenAListing('alice-token');

    const response = await app.inject({
      method: 'GET',
      url: listingMediaPath(listingId),
      headers: auth('bob-token'),
    });

    // An empty array would make "not yours" and "none yet" indistinguishable.
    expect(response.statusCode).toBe(404);
  });
});

describe('removing a photograph', () => {
  it('deletes the row and both objects', async () => {
    const listingId = await givenAListing();
    const media = parseOwnerListingMedia(
      (await upload(listingId, await photograph())).json(),
    );

    const response = await app.inject({
      method: 'DELETE',
      url: listingMediaItemPath(listingId, media.id),
      headers: auth('alice-token'),
    });

    expect(response.statusCode).toBe(204);
    expect(listings.media.objects.size).toBe(0);
    expect(listings.media.store.all).toHaveLength(0);
  });

  it('refuses somebody else’s photograph', async () => {
    const listingId = await givenAListing('alice-token');
    const media = parseOwnerListingMedia(
      (await upload(listingId, await photograph())).json(),
    );

    const response = await app.inject({
      method: 'DELETE',
      url: listingMediaItemPath(listingId, media.id),
      headers: auth('bob-token'),
    });

    expect(response.statusCode).toBe(404);
    expect(listings.media.store.all).toHaveLength(1);
  });

  it('answers 404 for a photograph this listing does not hold', async () => {
    const listingId = await givenAListing();

    const response = await app.inject({
      method: 'DELETE',
      url: listingMediaItemPath(listingId, '11111111-1111-4111-8111-111111111111'),
      headers: auth('alice-token'),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('reordering', () => {
  it('applies the order given', async () => {
    const listingId = await givenAListing();
    const first = parseOwnerListingMedia(
      (await upload(listingId, await photograph(300, 300))).json(),
    );
    const second = parseOwnerListingMedia(
      (await upload(listingId, await photograph(400, 400))).json(),
    );

    const response = await app.inject({
      method: 'PUT',
      url: listingMediaOrderPath(listingId),
      headers: auth('alice-token'),
      payload: { mediaIds: [second.id, first.id] },
    });

    expect(response.statusCode).toBe(200);
    const { media } = parseOwnerListingMediaList(response.json());
    expect(media.map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('refuses a partial order', async () => {
    const listingId = await givenAListing();
    const first = parseOwnerListingMedia(
      (await upload(listingId, await photograph(300, 300))).json(),
    );
    await upload(listingId, await photograph(400, 400));

    const response = await app.inject({
      method: 'PUT',
      url: listingMediaOrderPath(listingId),
      headers: auth('alice-token'),
      payload: { mediaIds: [first.id] },
    });

    // "Put these first" and "these are all of them" are different instructions
    // and the request cannot say which it meant.
    expect(response.statusCode).toBe(422);
  });

  it('refuses an order naming a photograph from another listing', async () => {
    const mine = await givenAListing('alice-token');
    const theirs = await givenAListing('bob-token');
    const foreign = parseOwnerListingMedia(
      (await upload(theirs, await photograph(), 'bob-token')).json(),
    );
    await upload(mine, await photograph());

    const response = await app.inject({
      method: 'PUT',
      url: listingMediaOrderPath(mine),
      headers: auth('alice-token'),
      payload: { mediaIds: [foreign.id] },
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a body that is not an order', async () => {
    const listingId = await givenAListing();

    const response = await app.inject({
      method: 'PUT',
      url: listingMediaOrderPath(listingId),
      headers: auth('alice-token'),
      payload: { mediaIds: ['not-a-uuid'] },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('the transport limit', () => {
  it('sits above the pipeline’s, so a file at the limit gets a sentence', () => {
    /*
     * Arithmetic rather than a request, and it says so: `app.inject` does not
     * enforce `bodyLimit`, so the behaviour cannot be provoked here.
     *
     * What it pins is that the two boundaries never land on the same byte. If
     * they did, an owner uploading exactly `MAX_INPUT_BYTES` would get a closed
     * socket — no status, no message — instead of a 422 naming the limit. The
     * headroom is the difference between a confusing failure and a useful one,
     * and it is one edit away from being deleted as redundant.
     */
    expect(IMAGE_UPLOAD_BODY_LIMIT).toBeGreaterThan(MAX_INPUT_BYTES);
  });
});
