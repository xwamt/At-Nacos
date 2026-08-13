import { describe, expect, it } from 'vitest';
import type { NacosInstanceConfig } from '../../../src/config/schema';
import { createAuthStrategy, type AuthStrategyDependencies } from '../../../src/nacos/auth/createAuthStrategy';

function instanceConfig(overrides: Partial<NacosInstanceConfig> = {}): NacosInstanceConfig {
  return {
    id: 'inst-1',
    label: 'Local Nacos',
    serverUrl: 'http://127.0.0.1:8848/nacos',
    authMode: 'none',
    readOnly: false,
    allowBackgroundAccess: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

interface RecordingDeps extends AuthStrategyDependencies {
  logins: unknown[];
  passwordReads: string[];
}

function recordingDeps(secrets: { passwords?: string[]; headers?: Record<string, string> } = {}): RecordingDeps {
  const logins: unknown[] = [];
  const passwordReads: string[] = [];
  const passwords = secrets.passwords ?? [];
  return {
    logins,
    passwordReads,
    http: {
      async requestJson(_method: string, _path: string, options?: unknown) {
        logins.push(options);
        return { accessToken: `tok${logins.length}`, tokenTtl: 18000 } as never;
      }
    },
    async getPassword(id: string) {
      passwordReads.push(id);
      return passwords[Math.min(passwordReads.length - 1, passwords.length - 1)];
    },
    async getCustomHeaders() {
      return secrets.headers;
    }
  };
}

describe('createAuthStrategy', () => {
  it('adds no headers in none mode', async () => {
    const strategy = await createAuthStrategy(instanceConfig({ authMode: 'none' }), recordingDeps());
    expect(await strategy.authHeaders()).toEqual({});
  });

  it('reports that none mode cannot recover from a 403, so the caller does not retry pointlessly', async () => {
    const strategy = await createAuthStrategy(instanceConfig({ authMode: 'none' }), recordingDeps());
    expect(await strategy.refresh()).toBe(false);
  });

  it('replays the stored custom headers in customHeader mode', async () => {
    const strategy = await createAuthStrategy(
      instanceConfig({ authMode: 'customHeader' }),
      recordingDeps({ headers: { authorization: 'Bearer from-idp', 'x-tenant': 'team-a' } })
    );
    expect(await strategy.authHeaders()).toEqual({ authorization: 'Bearer from-idp', 'x-tenant': 'team-a' });
  });

  it('hands out a copy of the custom headers so a caller cannot corrupt the strategy', async () => {
    const strategy = await createAuthStrategy(
      instanceConfig({ authMode: 'customHeader' }),
      recordingDeps({ headers: { authorization: 'Bearer from-idp' } })
    );
    const headers = await strategy.authHeaders();
    headers.authorization = 'Bearer tampered';
    delete headers['x-tenant'];
    expect(await strategy.authHeaders()).toEqual({ authorization: 'Bearer from-idp' });
  });

  it('reports that a static custom header cannot recover from a 403', async () => {
    const strategy = await createAuthStrategy(
      instanceConfig({ authMode: 'customHeader' }),
      recordingDeps({ headers: { authorization: 'Bearer from-idp' } })
    );
    expect(await strategy.refresh()).toBe(false);
  });

  it('adds no headers when customHeader mode has nothing stored yet', async () => {
    const strategy = await createAuthStrategy(instanceConfig({ authMode: 'customHeader' }), recordingDeps());
    expect(await strategy.authHeaders()).toEqual({});
  });

  it('logs in with the configured username and the stored password in userPassword mode', async () => {
    const deps = recordingDeps({ passwords: ['hunter2'] });
    const strategy = await createAuthStrategy(
      instanceConfig({ authMode: 'userPassword', username: 'nacos' }),
      deps
    );
    expect(await strategy.authHeaders()).toEqual({ authorization: 'Bearer tok1' });
    expect(deps.logins[0]).toMatchObject({ query: { username: 'nacos' }, form: { password: 'hunter2' } });
  });

  it('leaves the secret store alone until the first request needs a token', async () => {
    const deps = recordingDeps({ passwords: ['hunter2'] });
    const strategy = await createAuthStrategy(
      instanceConfig({ authMode: 'userPassword', username: 'nacos' }),
      deps
    );
    expect(deps.passwordReads).toEqual([]);
    await strategy.authHeaders();
    expect(deps.passwordReads).toEqual(['inst-1']);
  });

  it('re-reads the password on every login, so editing it takes effect without a new client', async () => {
    const deps = recordingDeps({ passwords: ['old', 'new'] });
    const strategy = await createAuthStrategy(
      instanceConfig({ authMode: 'userPassword', username: 'nacos' }),
      deps
    );
    await strategy.authHeaders();
    await strategy.refresh();
    await strategy.authHeaders();
    expect(deps.logins.map((login) => (login as { form: { password: string } }).form.password)).toEqual([
      'old',
      'new'
    ]);
  });

  it('lets the server reject a userPassword instance whose credentials were never stored', async () => {
    const deps = recordingDeps();
    const strategy = await createAuthStrategy(instanceConfig({ authMode: 'userPassword' }), deps);
    await strategy.authHeaders();
    expect(deps.logins[0]).toMatchObject({ query: { username: '' }, form: { password: '' } });
  });

  it('refuses akSk rather than silently degrading to anonymous access', async () => {
    await expect(createAuthStrategy(instanceConfig({ authMode: 'akSk' }), recordingDeps())).rejects.toThrow(
      /not implemented/i
    );
  });
});
