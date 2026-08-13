import type { NacosInstanceConfig } from '../../config/schema';
import type { NacosHttpClient } from '../NacosHttpClient';
import { CustomHeaderStrategy } from './CustomHeaderStrategy';
import type { NacosAuthStrategy } from './NacosAuthStrategy';
import { NoAuthStrategy } from './NoAuthStrategy';
import { UserPasswordStrategy } from './UserPasswordStrategy';

export interface AuthStrategyDependencies {
  http: Pick<NacosHttpClient, 'requestJson'>;
  getPassword(id: string): Promise<string | undefined>;
  getCustomHeaders(id: string): Promise<Record<string, string> | undefined>;
}

export async function createAuthStrategy(
  instance: NacosInstanceConfig,
  deps: AuthStrategyDependencies
): Promise<NacosAuthStrategy> {
  switch (instance.authMode) {
    case 'none':
      return new NoAuthStrategy();
    case 'customHeader':
      return new CustomHeaderStrategy((await deps.getCustomHeaders(instance.id)) ?? {});
    case 'userPassword':
      // The credentials are read at login time rather than captured here, so a
      // user who corrects a mistyped password sees the next login pick it up
      // without the client being rebuilt around them.
      return new UserPasswordStrategy(deps.http, async () => ({
        username: instance.username ?? '',
        password: (await deps.getPassword(instance.id)) ?? ''
      }));
    case 'akSk':
      // Deferred out of M1, and Task 11's form does not offer it. Failing
      // loudly beats degrading to anonymous access, which would leave the user
      // believing an unauthenticated connection was an authenticated one.
      throw new Error('AK/SK authentication is not implemented yet.');
  }
}
