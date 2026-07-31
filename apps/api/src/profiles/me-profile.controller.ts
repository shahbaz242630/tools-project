import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ME_PROFILE_PATH, parseProfileInput } from '@platform/contracts';
import type { MyProfile, MyProfileResponse } from '@platform/contracts';
import { ContractViolationError } from '@platform/contracts';
import { AuthGuard } from '../identity/auth.guard.js';
import { CurrentUser } from '../identity/current-user.decorator.js';
import type { MirroredUser } from '../identity/user-directory.js';
import { PROFILES_SERVICE } from './profiles.tokens.js';
import type { ProfilesService } from './profiles.service.js';

/**
 * The caller's own profile.
 *
 * **No user id in the path, and that is the access control.** `MeController`
 * makes the same argument for the same reason: the moment an id appears in a
 * URL, "may this person read or write that row" becomes a question somebody has
 * to remember to ask on every new route. Taking the id from the guard-resolved
 * session instead means the question cannot be forgotten, because it is never
 * asked — there is no way to address anyone else's row.
 *
 * BRD §14's Phase 1 exit gate wants proof that users cannot read or modify each
 * other's private data. The proof here is structural rather than a test of a
 * conditional, and the tests assert the structure holds.
 */
@Controller()
@UseGuards(AuthGuard)
export class MeProfileController {
  constructor(@Inject(PROFILES_SERVICE) private readonly profiles: ProfilesService) {}

  @Get(ME_PROFILE_PATH)
  async find(@CurrentUser() user: MirroredUser): Promise<MyProfileResponse> {
    // `null` rather than 404: not having filled in a profile is a normal state
    // the page renders a form for, and 404 would say the route is missing.
    return { profile: await this.profiles.findMine(user.id) };
  }

  @Put(ME_PROFILE_PATH)
  async save(
    @CurrentUser() user: MirroredUser,
    @Body() body: unknown,
  ): Promise<MyProfile> {
    // Validated here rather than by a Nest pipe, so the same schema the web app
    // uses is the one enforced, and the two cannot drift into disagreeing about
    // what a valid postcode is.
    let input;
    try {
      input = parseProfileInput(body);
    } catch (error) {
      if (error instanceof ContractViolationError) {
        // The field-level messages are safe to return: they describe the
        // caller's own submission, which they already have. Withholding them
        // would make a form that cannot say which box is wrong.
        throw new BadRequestException({
          message: 'The profile could not be saved',
          issues: error.issues,
        });
      }
      throw error;
    }

    return this.profiles.saveMine(user.id, input);
  }
}
