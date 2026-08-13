import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import type { NacosHttpClient, NacosRequestOptions } from '../../../src/nacos/NacosHttpClient';
import type { NacosApiFlavor, NacosDriver } from '../../../src/nacos/driver/NacosDriver';
import { V1Driver } from '../../../src/nacos/driver/V1Driver';
import { V2Driver } from '../../../src/nacos/driver/V2Driver';
import { V3AdminDriver } from '../../../src/nacos/driver/V3AdminDriver';
import { V3ConsoleDriver } from '../../../src/nacos/driver/V3ConsoleDriver';

const CONSOLE_BASE_URL = 'http://h:8080';

interface StubCall {
  method: string;
  path: string;
  options: NacosRequestOptions | undefined;
}

interface StubHttp {
  calls: StubCall[];
  client: Pick<NacosHttpClient, 'requestJson'>;
}

/**
 * `requestJson` is generic, so a responder returning a concrete shape is not
 * assignable to it without a cast. Doing the cast once here keeps every test
 * below typed against the real `Pick<NacosHttpClient, 'requestJson'>`.
 */
function respondingHttp(respond: () => unknown): StubHttp {
  const calls: StubCall[] = [];
  return {
    calls,
    client: {
      async requestJson<T>(method: string, path: string, options?: NacosRequestOptions): Promise<T> {
        calls.push({ method, path, options });
        return respond() as T;
      }
    }
  };
}

function stubHttp(payload: unknown): StubHttp {
  return respondingHttp(() => payload);
}

function failingHttp(error: unknown): StubHttp {
  return respondingHttp(() => {
    throw error;
  });
}

/** Verbatim wire bodies, parsed rather than transcribed so the nulls stay nulls. */
const REAL_V1_BODY =
  '{"code":200,"message":null,"data":[{"namespace":"","namespaceShowName":"public","namespaceDesc":null,"quota":200,"configCount":0,"type":0}]}';
const REAL_V2_BODY =
  '{"code":0,"message":"success","data":[{"namespace":"","namespaceShowName":"public","namespaceDesc":null,"quota":200,"configCount":1,"type":0}]}';
const REAL_V3_BODY =
  '{"code":0,"message":"success","data":[{"namespace":"public","namespaceShowName":"public","namespaceDesc":"Default Namespace","quota":200,"configCount":0,"type":0}]}';

interface DriverCase {
  flavor: NacosApiFlavor;
  path: string;
  make(http: Pick<NacosHttpClient, 'requestJson'>): NacosDriver;
}

const DRIVER_CASES: DriverCase[] = [
  { flavor: 'v1', path: '/v1/console/namespaces', make: (http) => new V1Driver(http) },
  { flavor: 'v2', path: '/v2/console/namespace/list', make: (http) => new V2Driver(http) },
  { flavor: 'v3-admin', path: '/v3/admin/core/namespace/list', make: (http) => new V3AdminDriver(http) },
  {
    flavor: 'v3-console',
    path: '/v3/console/core/namespace/list',
    make: (http) => new V3ConsoleDriver(http, CONSOLE_BASE_URL)
  }
];

describe('namespace drivers', () => {
  it('V1Driver reads /v1/console/namespaces and accepts code 200', async () => {
    const http = stubHttp({
      code: 200,
      data: [{ namespace: '', namespaceShowName: 'public', quota: 200, configCount: 1, type: 0 }]
    });
    const namespaces = await new V1Driver(http.client).listNamespaces();
    expect(http.calls[0]?.path).toBe('/v1/console/namespaces');
    expect(namespaces[0]?.namespaceId).toBe('');
  });

  it('V2Driver reads /v2/console/namespace/list', async () => {
    const http = stubHttp({
      code: 0,
      data: [{ namespace: '', namespaceShowName: 'public', type: 0 }]
    });
    await new V2Driver(http.client).listNamespaces();
    expect(http.calls[0]?.path).toBe('/v2/console/namespace/list');
  });

  it('V3AdminDriver reads /v3/admin/core/namespace/list on the server base url', async () => {
    const http = stubHttp({
      code: 0,
      data: [{ namespace: 'public', namespaceShowName: 'public', type: 0 }]
    });
    const namespaces = await new V3AdminDriver(http.client).listNamespaces();
    expect(http.calls[0]?.path).toBe('/v3/admin/core/namespace/list');
    expect(http.calls[0]?.options?.baseUrlOverride).toBeUndefined();
    expect(namespaces[0]?.namespaceId).toBe('public');
  });

  it('V3ConsoleDriver targets the separate console origin', async () => {
    const http = stubHttp({ code: 0, data: [{ namespace: 'public', namespaceShowName: 'public', type: 0 }] });
    await new V3ConsoleDriver(http.client, CONSOLE_BASE_URL).listNamespaces();
    expect(http.calls[0]?.path).toBe('/v3/console/core/namespace/list');
    expect(http.calls[0]?.options?.baseUrlOverride).toBe(CONSOLE_BASE_URL);
  });

  it('each driver reports its flavor for capability caching', () => {
    const http = stubHttp({});
    expect(new V1Driver(http.client).flavor).toBe('v1');
    expect(new V2Driver(http.client).flavor).toBe('v2');
    expect(new V3AdminDriver(http.client).flavor).toBe('v3-admin');
    expect(new V3ConsoleDriver(http.client, CONSOLE_BASE_URL).flavor).toBe('v3-console');
  });

  it('reads the real 1.x body, whose RestResult success code is 200 and whose desc is null', async () => {
    const http = stubHttp(JSON.parse(REAL_V1_BODY));
    await expect(new V1Driver(http.client).listNamespaces()).resolves.toEqual([
      { namespaceId: '', displayName: 'public', description: undefined, quota: 200, configCount: 0, type: 0 }
    ]);
  });

  it('reads the real 2.x body, which is the 1.x shape with code 0', async () => {
    const http = stubHttp(JSON.parse(REAL_V2_BODY));
    await expect(new V2Driver(http.client).listNamespaces()).resolves.toEqual([
      { namespaceId: '', displayName: 'public', description: undefined, quota: 200, configCount: 1, type: 0 }
    ]);
  });

  /** The 3.x public entry is the one that carries a real id and a description. */
  it('reads the real 3.x body on both the admin and the console path', async () => {
    const expected = [
      {
        namespaceId: 'public',
        displayName: 'public',
        description: 'Default Namespace',
        quota: 200,
        configCount: 0,
        type: 0
      }
    ];
    const adminHttp = stubHttp(JSON.parse(REAL_V3_BODY));
    await expect(new V3AdminDriver(adminHttp.client).listNamespaces()).resolves.toEqual(expected);
    const consoleHttp = stubHttp(JSON.parse(REAL_V3_BODY));
    await expect(new V3ConsoleDriver(consoleHttp.client, CONSOLE_BASE_URL).listNamespaces()).resolves.toEqual(
      expected
    );
  });

  it('keeps every entry and their order', async () => {
    const http = stubHttp({
      code: 0,
      message: 'success',
      data: [
        { namespace: 'public', namespaceShowName: 'public', namespaceDesc: 'Default Namespace', type: 0 },
        { namespace: 'dev-1111', namespaceShowName: 'dev', namespaceDesc: null, quota: 200, configCount: 7, type: 2 }
      ]
    });
    const namespaces = await new V3AdminDriver(http.client).listNamespaces();
    expect(namespaces.map((namespace) => namespace.namespaceId)).toEqual(['public', 'dev-1111']);
    expect(namespaces[1]).toEqual({
      namespaceId: 'dev-1111',
      displayName: 'dev',
      description: undefined,
      quota: 200,
      configCount: 7,
      type: 2
    });
  });
});

/**
 * The four drivers differ only in the path they call, so every guarantee that
 * is not the path has to hold for all four -- a malformed body must fail the
 * same way whichever version answered it.
 */
for (const { flavor, path, make } of DRIVER_CASES) {
  describe(`${flavor} namespace driver`, () => {
    it('asks for the list with GET', async () => {
      const http = stubHttp({ code: 0, data: [] });
      await make(http.client).listNamespaces();
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]?.method).toBe('GET');
      expect(http.calls[0]?.path).toBe(path);
    });

    /** A server with no namespace at all cannot exist, but zero rows is data, not a fault. */
    it('returns an empty list rather than failing on an empty data array', async () => {
      const http = stubHttp({ code: 0, message: 'success', data: [] });
      await expect(make(http.client).listNamespaces()).resolves.toEqual([]);
    });

    /**
     * Each of these would otherwise reach `.map()` or `normalizeNamespace` and
     * raise a TypeError. A TypeError carries no kind, so it would escape the
     * resolver's fall-through machinery and abort the whole driver chain.
     */
    it.each([
      ['no data field', { code: 0, message: 'success' }],
      ['a null data field', { code: 0, message: 'success', data: null }],
      ['an object instead of a list', { code: 0, data: { namespace: 'public' } }],
      ['a list holding a string', { code: 0, data: ['public'] }],
      ['a list holding a null', { code: 0, data: [null] }],
      ['an entry with no namespace field', { code: 0, data: [{ namespaceShowName: 'public', type: 0 }] }],
      ['an empty body', undefined]
    ])('classifies %s as an invalid-response NacosApiError', async (_label, payload) => {
      const http = stubHttp(payload);
      const error = await make(http.client)
        .listNamespaces()
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(NacosApiError);
      expect((error as NacosApiError).kind).toBe('invalid-response');
    });

    it('names its own endpoint when the response carries no list', async () => {
      const http = stubHttp({ code: 0, message: 'success' });
      await expect(make(http.client).listNamespaces()).rejects.toThrow(path);
    });

    /**
     * The resolver decides whether to try the next version by reading the kind
     * off this error, so the driver must not catch, wrap or re-message it.
     */
    it('lets a classified transport failure through untouched', async () => {
      const failure = new NacosApiError('not-found', 'no such endpoint', 404);
      const http = failingHttp(failure);
      await expect(make(http.client).listNamespaces()).rejects.toBe(failure);
    });
  });
}
