import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { NacosConfigDocumentProvider } from '../../src/document/NacosConfigDocumentProvider';
import { buildConfigUri } from '../../src/document/configUri';
import { NacosApiError } from '../../src/nacos/NacosApiError';
import type { NacosConfigDetail, NacosConfigRef } from '../../src/nacos/driver/normalize';

function instance(overrides: Partial<NacosInstanceConfig> = {}): NacosInstanceConfig {
  return {
    id: 'instance-1',
    label: 'Production',
    serverUrl: 'http://nacos.example.com:8848/nacos',
    authMode: 'none',
    readOnly: false,
    allowBackgroundAccess: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function ref(overrides: Partial<NacosConfigRef> = {}): NacosConfigRef {
  return { namespaceId: 'uat', group: 'cl-intimfy', dataId: 'application-uat.yml', ...overrides };
}

function detail(overrides: Partial<NacosConfigDetail> = {}): NacosConfigDetail {
  return { ...ref(), content: 'spring:\n  profiles: uat\n', type: 'yaml', ...overrides };
}

/** The one instance / one client shape most tests want. */
function providerFor(
  getConfig: (target: NacosConfigRef) => Promise<NacosConfigDetail>,
  stored = instance()
): NacosConfigDocumentProvider {
  return new NacosConfigDocumentProvider(
    { getInstance: async (id) => (id === stored.id ? stored : undefined) },
    async () => ({ getConfig })
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NacosConfigDocumentProvider content', () => {
  it('returns the configuration body as the document body', async () => {
    const provider = providerFor(async () => detail({ content: 'server.port=8080\n' }));

    const content = await provider.provideTextDocumentContent(buildConfigUri('instance-1', ref()));

    expect(content).toBe('server.port=8080\n');
  });

  it('asks for exactly the ref the URI encodes, a dataId full of URI punctuation included', async () => {
    const asked: NacosConfigRef[] = [];
    const target = ref({ namespaceId: '', group: 'team/payments', dataId: '订单 服务?v=1#a.yaml' });
    const provider = providerFor(async (request) => {
      asked.push(request);
      return detail(request);
    });

    await provider.provideTextDocumentContent(buildConfigUri('instance-1', target));

    expect(asked).toEqual([target]);
  });

  it('builds one client per request from the instance the URI names', async () => {
    const built: string[] = [];
    const provider = new NacosConfigDocumentProvider(
      { getInstance: async (id) => instance({ id }) },
      async (stored) => {
        built.push(stored.id);
        return { getConfig: async () => detail() };
      }
    );

    await provider.provideTextDocumentContent(buildConfigUri('instance-a', ref()));
    await provider.provideTextDocumentContent(buildConfigUri('instance-b', ref()));

    expect(built).toEqual(['instance-a', 'instance-b']);
  });
});

/**
 * Every case below asserts a resolved string rather than a rejection. VS Code
 * renders a rejected `provideTextDocumentContent` as an empty editor with no
 * explanation at all, so a failure that reaches the user as text is the whole
 * point of this class.
 */
describe('NacosConfigDocumentProvider failures', () => {
  it('says the instance is gone, rather than rejecting, when it was deleted with the tab left open', async () => {
    const provider = new NacosConfigDocumentProvider({ getInstance: async () => undefined }, async () => {
      throw new Error('createClient must not be called for an instance that is gone');
    });

    const content = await provider.provideTextDocumentContent(buildConfigUri('deleted', ref()));

    expect(content).toContain('no longer configured');
  });

  it('says the address is not a configuration, rather than rejecting, for a URI it did not build', async () => {
    const provider = providerFor(async () => detail());

    const content = await provider.provideTextDocumentContent(vscode.Uri.from({ scheme: 'nacos', path: '/only-one' }));

    expect(content).toContain('cannot read this address');
  });

  /**
   * The two 404s Nacos overloads reach here as different kinds, and only this
   * one means the dataId is gone. Showing the endpoint and the status instead
   * would send the user looking for a server fault that is not there.
   */
  it('says the configuration is missing, not what the API answered, on resource-not-found', async () => {
    const provider = providerFor(async () => {
      throw new NacosApiError(
        'resource-not-found',
        'Nacos has no such resource at /v1/cs/configs (HTTP 404): config data not exist',
        404
      );
    });

    const content = await provider.provideTextDocumentContent(
      buildConfigUri('instance-1', ref({ group: 'cl-intimfy', dataId: 'application-uat.yml' }))
    );

    expect(content).toContain('application-uat.yml');
    expect(content).toContain('cl-intimfy');
    expect(content).not.toContain('/v1/cs/configs');
    expect(content).not.toContain('404');
  });

  it('renders any other fetch failure as the message, naming the configuration it was reading', async () => {
    const provider = providerFor(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.9:8848');
    });

    const content = await provider.provideTextDocumentContent(buildConfigUri('instance-1', ref()));

    expect(content).toContain('application-uat.yml');
    expect(content).toContain('connect ECONNREFUSED 10.0.0.9:8848');
  });

  /**
   * This text lands in a buffer the user can select, copy and paste into an
   * issue, which is a longer life than a notification has.
   */
  it('redacts a credential out of the failure it writes into the buffer', async () => {
    const provider = providerFor(async () => {
      throw new Error('login failed: POST /v1/auth/login?username=nacos&password=hunter2');
    });

    const content = await provider.provideTextDocumentContent(buildConfigUri('instance-1', ref()));

    expect(content).not.toContain('hunter2');
    expect(content).toContain('[REDACTED]');
  });

  /** `listInstances` throws when a stored record no longer parses, and `getInstance` reads through it. */
  it('renders a corrupt instance store as a message rather than rejecting', async () => {
    const provider = new NacosConfigDocumentProvider(
      {
        getInstance: async () => {
          throw new Error('atNacos.instances is not a valid instance list');
        }
      },
      async () => ({ getConfig: async () => detail() })
    );

    const content = await provider.provideTextDocumentContent(buildConfigUri('instance-1', ref()));

    expect(content).toContain('atNacos.instances is not a valid instance list');
  });
});

describe('NacosConfigDocumentProvider refresh', () => {
  it('fires onDidChange with the URI of the configuration it is told changed', () => {
    const provider = providerFor(async () => detail());
    const fired: vscode.Uri[] = [];
    provider.onDidChange((uri) => fired.push(uri));

    provider.refresh('instance-1', ref());

    expect(fired.map((uri) => uri.toString())).toEqual([buildConfigUri('instance-1', ref()).toString()]);
  });

  it('notifies nobody once disposed', () => {
    const provider = providerFor(async () => detail());
    let fired = 0;
    provider.onDidChange(() => {
      fired += 1;
    });

    provider.dispose();
    provider.refresh('instance-1', ref());

    expect(fired).toBe(0);
  });
});

describe('NacosConfigDocumentProvider localization', () => {
  it('routes every message it authors through a key the zh-cn bundle actually translates', async () => {
    // A source string that reaches `t()` but is missing from the bundle falls
    // back to English silently, so nothing but a check like this notices that
    // an editor shipped half-translated.
    const bundle = JSON.parse(readFileSync(resolve(process.cwd(), 'l10n/bundle.l10n.zh-cn.json'), 'utf8')) as Record<
      string,
      string
    >;
    const sources: string[] = [];
    // `l10n.t` is overloaded, so the stub has to accept the widest first
    // parameter of the set rather than just the string form the code uses.
    vi.spyOn(vscode.l10n, 't').mockImplementation((messageOrOptions: string | { message: string }) => {
      const message = typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions.message;
      sources.push(message);
      return message;
    });
    const missing = new NacosConfigDocumentProvider({ getInstance: async () => undefined }, async () => ({
      getConfig: async () => detail()
    }));
    const notFound = providerFor(async () => {
      throw new NacosApiError('resource-not-found', 'config data not exist', 404);
    });
    const broken = providerFor(async () => {
      throw new Error('host unreachable');
    });

    await missing.provideTextDocumentContent(buildConfigUri('deleted', ref()));
    await notFound.provideTextDocumentContent(buildConfigUri('instance-1', ref()));
    await broken.provideTextDocumentContent(buildConfigUri('instance-1', ref()));
    await broken.provideTextDocumentContent(vscode.Uri.from({ scheme: 'nacos', path: '/only-one' }));

    expect(sources.length).toBeGreaterThanOrEqual(4);
    for (const source of sources) {
      expect(Object.keys(bundle), source).toContain(source);
    }
  });
});
