import { BadRequestException, Body, Controller, Inject, Post } from '@nestjs/common';
import { CLERK_EVENTS_PATH, clerkEventForwardSchema } from '@platform/contracts';
import type { ClerkEventResult } from '@platform/contracts';
import type { Logger } from '@platform/observability';
import { ClerkEventMappingError, mapClerkEvent } from './clerk-event-mapper.js';
import { AUTH_LOGGER, IDENTITY_SERVICE } from './auth.guard.js';
import type { IdentityService } from './identity.service.js';

/**
 * Applies Clerk identity events forwarded by the web app.
 *
 * **Not guarded by `AuthGuard`, deliberately.** A webhook speaks for a provider,
 * not for a user, so there is no session to verify. What stands in for
 * authentication is that the delivery's Standard Webhooks signature has already
 * been checked in the web app, and that this route is unreachable from the
 * internet — the API is not on the `edge` network and CI asserts it.
 *
 * That means the trust boundary here is the network, and it is worth being
 * plain about it: anything able to reach the API can forge identity events.
 * The same is true of Postgres sitting beside it, so this is the established
 * model rather than a new exposure — but it is the reason a browser-facing
 * route must never be added to this controller.
 */
@Controller()
export class ClerkEventsController {
  constructor(
    @Inject(IDENTITY_SERVICE) private readonly identity: IdentityService,
    @Inject(AUTH_LOGGER) private readonly logger: Logger,
  ) {}

  @Post(CLERK_EVENTS_PATH)
  async receive(@Body() body: unknown): Promise<ClerkEventResult> {
    const parsed = clerkEventForwardSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('malformed identity event');
    }

    const { deliveryId, type, data, eventAttributes } = parsed.data;

    let event;
    try {
      // `eventAttributes` is passed as well as `data`. It is a sibling of it in
      // Clerk's envelope and the only place a session delivery says where the
      // request came from; forwarding `data` alone recorded sign-ins with
      // nothing but a timestamp (ADR 0025).
      event = mapClerkEvent(type, data, eventAttributes);
    } catch (error) {
      if (error instanceof ClerkEventMappingError) {
        // 400 rather than 500: the payload is the problem, and answering with a
        // client error stops the provider retrying something that will never
        // succeed. Logged loudly because it means Clerk changed shape.
        this.logger.error('could not map a clerk event', { deliveryId, type, error });
        throw new BadRequestException('unrecognised identity event payload');
      }
      throw error;
    }

    if (event === null) {
      // A type we do not act on. Answering success is correct — the delivery
      // was received and understood, and retrying it would change nothing.
      this.logger.debug('ignored a clerk event type', { deliveryId, type });
      return { outcome: 'ignored' };
    }

    const applied = await this.identity.applyEvent(deliveryId, event);

    this.logger.info('handled a clerk event', {
      deliveryId,
      type,
      outcome: applied ? 'applied' : 'duplicate',
    });

    return { outcome: applied ? 'applied' : 'duplicate' };
  }
}
