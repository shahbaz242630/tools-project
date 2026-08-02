import type { PrismaClient } from '@platform/database';
import { validIpOrNull } from './ip-address.js';
import type {
  AuthenticationEventRecord,
  AuthenticationEventType,
  AuthenticationEvents,
  RecordedAuthenticationEvent,
} from './authentication-events.js';

/**
 * Postgres-backed authentication events.
 *
 * `create`, `findMany` and one `updateMany` that only ever writes nulls. No
 * `delete` anywhere in this file, for the reason `PrismaAuditLog` has none: the
 * guarantee lives in the code that is allowed to exist, because Prisma would
 * happily generate the method if somebody asked it to.
 */
export class PrismaAuthenticationEvents implements AuthenticationEvents {
  constructor(private readonly prisma: PrismaClient) {}

  async record(event: AuthenticationEventRecord): Promise<void> {
    const { activity } = event;

    await this.prisma.authenticationEvent.upsert({
      // The natural key, matching the unique constraint. `upsert` rather than
      // `create` in a try/catch because the duplicate is an expected outcome
      // rather than an error we recover from — a provider replaying an event
      // under a new delivery id is normal traffic, not a fault.
      where: {
        clerkSessionId_event: {
          clerkSessionId: event.clerkSessionId,
          event: event.event,
        },
      },

      // **Empty on purpose.** A second delivery of the same logical event
      // changes nothing: the first record is the one that was true at the
      // time, and overwriting it with a later replay's data would let a
      // redelivery quietly rewrite a security record. Idempotent means the
      // second call is a no-op, not a refresh.
      update: {},

      create: {
        userId: event.userId,
        clerkSessionId: event.clerkSessionId,
        event: event.event,
        occurredAt: event.occurredAt,

        // Validated here rather than trusted. The column is `inet`, so a
        // malformed value throws on insert — and this write is on the webhook
        // path, so a throw becomes a delivery Clerk retries forever. The same
        // class of bug took down authenticated requests in slice 1.5a when a
        // repeated header arrived joined with a comma; `inet` rejects that
        // string too. Recording null is the honest answer to "we cannot tell".
        ipAddress: validIpOrNull(activity.ipAddress),

        city: activity.city,
        country: activity.country,
        browserName: activity.browserName,
        browserVersion: activity.browserVersion,
        deviceType: activity.deviceType,
        isMobile: activity.isMobile,
      },
    });
  }

  async listFor(
    userId: string,
    limit: number,
  ): Promise<readonly RecordedAuthenticationEvent[]> {
    const rows = await this.prisma.authenticationEvent.findMany({
      where: { userId },
      orderBy: { occurredAt: 'desc' },
      take: limit,

      // Explicit rather than returning the row, so a column added later is not
      // served the day it appears. `userId` is deliberately absent: the caller
      // supplied it, and echoing an id back into a response is how one ends up
      // somewhere it was not meant to go.
      select: {
        id: true,
        clerkSessionId: true,
        event: true,
        occurredAt: true,
        ipAddress: true,
        city: true,
        country: true,
        browserName: true,
        browserVersion: true,
        deviceType: true,
        isMobile: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      clerkSessionId: row.clerkSessionId,
      // The column is text with a CHECK constraint, so the database refuses
      // anything outside the four. Narrowed rather than asserted blindly, so
      // the one place that trusts the database is visible.
      event: row.event as AuthenticationEventType,
      occurredAt: row.occurredAt,
      activity: {
        ipAddress: row.ipAddress,
        city: row.city,
        country: row.country,
        browserName: row.browserName,
        browserVersion: row.browserVersion,
        deviceType: row.deviceType,
        isMobile: row.isMobile,
      },
    }));
  }

  async eraseActivity(userId: string): Promise<void> {
    // `updateMany` with no read first: idempotent by construction, because
    // setting a null column to null is a no-op, and a second call after a
    // partial failure finishes the job. It matches zero rows for an account
    // that never signed in, which is a success.
    await this.prisma.authenticationEvent.updateMany({
      where: { userId },
      data: {
        ipAddress: null,
        city: null,
        country: null,
        browserName: null,
        browserVersion: null,
        deviceType: null,
        isMobile: null,
      },
    });
  }
}
