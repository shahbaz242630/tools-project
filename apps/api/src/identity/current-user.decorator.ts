import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.guard.js';
import type { MirroredUser } from './user-directory.js';

/**
 * The account making the request.
 *
 * Only meaningful behind `AuthGuard`, which is what puts it on the request.
 * Throwing when it is absent rather than returning undefined is deliberate: a
 * handler that received `undefined` here would be one `?.` away from treating
 * an unauthenticated request as an anonymous but permitted one, and the whole
 * point of Phase 1 is that ownership checks cannot be reasoned around.
 */
/**
 * Exported separately from the decorator so it can be tested directly.
 *
 * `createParamDecorator` buries its callback in Nest metadata, where reaching
 * it from a test means reading internals that are not part of the public API.
 * The rule worth testing is here.
 */
export function currentUserFrom(context: ExecutionContext): MirroredUser {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

  if (request.user === undefined) {
    throw new Error(
      'CurrentUser used on a route that AuthGuard does not protect — the ' +
        'handler would otherwise run without knowing who is calling it',
    );
  }

  return request.user;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MirroredUser => currentUserFrom(context),
);
