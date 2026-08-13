import type { NacosAuthStrategy } from './NacosAuthStrategy';

export class NoAuthStrategy implements NacosAuthStrategy {
  async authHeaders(): Promise<Record<string, string>> {
    return {};
  }

  async refresh(): Promise<boolean> {
    // There is no credential to renew. A 403 against an instance configured as
    // unauthenticated means the server has auth switched on after all, which
    // only editing the instance can fix.
    return false;
  }
}
