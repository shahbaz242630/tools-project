import { Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import {
  newCorrelationId,
  runWithContext,
  sanitiseCorrelationId,
} from '@platform/observability';

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * The parts of a request and response this middleware touches.
 *
 * Narrower than Node's `IncomingMessage`/`ServerResponse` so the middleware can
 * be tested with plain objects, and so nothing here depends on which HTTP
 * adapter Nest is running.
 */
export interface CorrelationRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface CorrelationResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Establishes the correlation context for the life of a request.
 *
 * An inbound id is honoured so a trace survives the hop from web to API, but
 * only after sanitising: the header is attacker-controlled and ends up in logs,
 * where an unchecked newline lets a caller forge log entries.
 *
 * The id is echoed back so a client — or a support engineer reading a bug
 * report — can quote the exact identifier to search for.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(
    request: CorrelationRequest,
    response: CorrelationResponse,
    next: () => void,
  ): void {
    const inbound = sanitiseCorrelationId(request.headers[CORRELATION_HEADER]);
    const correlationId = inbound ?? newCorrelationId();

    response.setHeader(CORRELATION_HEADER, correlationId);

    // `next` is invoked inside the context, so everything the request goes on
    // to await inherits it. Calling it outside would leave every downstream log
    // line uncorrelated.
    runWithContext({ correlationId, requestId: newCorrelationId() }, next);
  }
}
