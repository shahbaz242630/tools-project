import type { DependencyCheck } from './dependency-check.js';

/** The slice of a Redis client this check needs. See `SqlClient` for why. */
export interface PingClient {
  ping(): Promise<string>;
}

export class RedisCheck implements DependencyCheck {
  readonly name = 'redis';

  constructor(private readonly client: PingClient) {}

  async probe(): Promise<void> {
    const reply = await this.client.ping();

    // A connected client that answers something other than PONG is talking to
    // something that is not Redis — a proxy, a captive portal, the wrong port.
    // Treating any resolved promise as success would report that as ready.
    if (reply !== 'PONG') {
      throw new Error(`unexpected PING reply: ${reply}`);
    }
  }
}
