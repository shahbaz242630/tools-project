import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common';
import { PUBLIC_PROFILE_ROUTE } from '@platform/contracts';
import type { PublicProfile } from '@platform/contracts';
import { PROFILES_SERVICE } from './profiles.tokens.js';
import type { ProfilesService } from './profiles.service.js';

/**
 * Anyone's profile, as anyone may see it.
 *
 * **Deliberately not guarded, and deliberately in its own controller.** BRD §2
 * gives visitors the right to view public profiles, so requiring a session here
 * would be wrong. Putting the route in a separate class is what makes that
 * decision visible: `@UseGuards(AuthGuard)` sits on the controller, so an
 * unguarded route hidden among guarded ones would read as an oversight, while
 * an unguarded *controller* has to be created on purpose.
 *
 * Everything this returns is world-readable — assume it is scraped and indexed
 * the day it ships. What keeps that safe is `publicProfileSchema`, which has no
 * contact field, and `ProfilesService.findPublic`, which builds the projection.
 * This class chooses no fields of its own.
 */
@Controller()
export class PublicProfileController {
  constructor(@Inject(PROFILES_SERVICE) private readonly profiles: ProfilesService) {}

  @Get(PUBLIC_PROFILE_ROUTE)
  async find(@Param('userId') userId: string): Promise<PublicProfile> {
    const profile = await this.profiles.findPublic(userId);

    // One answer for "no such account", "deleted account" and "no profile yet".
    // Distinguishing them would turn this route into an oracle for which user
    // ids are real, which is the first step of scraping a user base. The ids
    // are UUIDs so it cannot be done by counting; this stops it being done by
    // asking.
    if (profile === null) {
      throw new NotFoundException();
    }

    return profile;
  }
}
