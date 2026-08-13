import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import { NacosHttpClient, type NacosRequestOptions } from '../../../src/nacos/NacosHttpClient';
import type { NacosApiFlavor, NacosDriver } from '../../../src/nacos/driver/NacosDriver';
import { V1Driver } from '../../../src/nacos/driver/V1Driver';
import { V2Driver } from '../../../src/nacos/driver/V2Driver';
import { V3AdminDriver } from '../../../src/nacos/driver/V3AdminDriver';
import { V3ConsoleDriver } from '../../../src/nacos/driver/V3ConsoleDriver';
import { startTestHttpServer, type TestHttpServer, type TestRequestHandler } from '../testHttpServer';

/**
 * The context path a real deployment carries. Kept on the server base URL and
 * off the console base URL, exactly as Nacos 3.x deploys them, so that a
 * driver which forgot `baseUrlOverride` lands on `/nacos/v3/console/...` and
 * the path assertion catches it.
 */
const CONTEXT_PATH = '/nacos';

/** The namespace under test. Not '' or 'public', so a dropped parameter cannot pass by accident. */
const NAMESPACE_ID = 'uat';
const GROUP = 'cl-intimfy';
const DATA_ID = 'application-uat.yml';

/**
 * A `GET /v1/cs/configs?search=accurate` page captured from a real Nacos
 * 2.3.2. Held as raw text and parsed by the fixture server rather than
 * transcribed into an object literal, so the `\n` inside `content` and the
 * `md5: null` that accurate search produces are the server's and not this
 * file's.
 */
const REAL_ACCURATE_PAGE = String.raw`{"totalCount":12,"pageNumber":1,"pagesAvailable":2,"pageItems":[{"id":"142","dataId":"application-uat.yml","group":"cl-intimfy","content":"spring:\n  autoconfigure:\n    exclude: com.alibaba.druid.spring.boot.autoconfigure.DruidDataSourceAutoConfigure","md5":null,"encryptedDataKey":"","tenant":"uat","appName":"","type":"yaml"},{"id":"143","dataId":"application-common.properties","group":"cl-intimfy","content":"jdbc.password=hunter2","md5":null,"encryptedDataKey":"","tenant":"uat","appName":"","type":"properties"}]}`;

/**
 * The same page under `search=blur`, where the server nulls `type` out. Also
 * captured from the real 2.3.2, which answers `md5: null` in *both* search
 * modes -- so a blur item carries neither the type nor the checksum, and the
 * dataId suffix is all `configLanguageId` has left to work from.
 */
const REAL_BLUR_PAGE = String.raw`{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"id":"142","dataId":"application-uat.yml","group":"cl-intimfy","content":"spring:\n  autoconfigure:\n    exclude: com.alibaba.druid.spring.boot.autoconfigure.DruidDataSourceAutoConfigure","md5":null,"encryptedDataKey":"","tenant":"uat","appName":"","type":null}]}`;

/** A `GET /v1/cs/configs?show=all` response captured from the same server. */
const REAL_DETAIL = String.raw`{"id":"142","dataId":"application-uat.yml","group":"cl-intimfy","content":"spring:\n  autoconfigure:\n    exclude: com.alibaba.druid.spring.boot.autoconfigure.DruidDataSourceAutoConfigure","md5":"e1a9de8c8df94a487159b655a3c8f703","encryptedDataKey":"","tenant":"uat","appName":"","type":"yaml","createTime":1758164587000,"modifyTime":1758164587000,"createUser":null,"createIp":"192.168.66.66","desc":"","use":null,"effect":null,"schema":null,"configTags":null}`;

/**
 * Nacos's plain-text 404 for a dataId nobody published, verbatim -- including
 * the content type, which is a lie: the body is not JSON.
 *
 * Measured on 2.3.2 this comes from the *bare* form of `/v1/cs/configs`, not
 * from `?show=all`, which reports the same absence as an empty 200. It is
 * covered anyway because 3.x answers 404 with a `{"code":20004,...}` body,
 * which is JSON but is not a Spring error page, and has to land the same way.
 */
const MISSING_CONFIG_BODY = 'config data not exist';
const NACOS_JSON_CONTENT_TYPE = 'application/json;charset=UTF-8';

/** Spring Boot's own 404 page, verbatim, for a path the server has no controller for. */
const SPRING_ERROR_PAGE =
  '{"timestamp":"2026-08-14T00:34:34.539+08:00","status":404,"error":"Not Found","message":"No message available","path":"/nacos/v1/cs/__nosuchendpoint__"}';

interface ConfigDriverCase {
  flavor: NacosApiFlavor;
  listPath: string;
  getPath: string;
  /** §6.1: only the v1 config endpoints say `tenant`, and v2 reaches them too. */
  namespaceParam: 'tenant' | 'namespaceId';
  groupParam: 'group' | 'groupName';
  /** v3-console lives on its own origin, so its requests carry no context path. */
  onConsoleOrigin: boolean;
  /** v3 wraps every payload in `{code,message,data}`; 1.x/2.x answer with the bare object. */
  wrap(json: string): string;
  make(http: NacosHttpClient, consoleBaseUrl: string): NacosDriver;
}

const bare = (json: string): string => json;
const enveloped = (json: string): string => `{"code":0,"message":"success","data":${json}}`;

const DRIVER_CASES: ConfigDriverCase[] = [
  {
    flavor: 'v1',
    listPath: '/v1/cs/configs',
    getPath: '/v1/cs/configs',
    namespaceParam: 'tenant',
    groupParam: 'group',
    onConsoleOrigin: false,
    wrap: bare,
    make: (http) => new V1Driver(http)
  },
  {
    flavor: 'v2',
    listPath: '/v1/cs/configs',
    getPath: '/v1/cs/configs',
    namespaceParam: 'tenant',
    groupParam: 'group',
    onConsoleOrigin: false,
    wrap: bare,
    make: (http) => new V2Driver(http)
  },
  {
    flavor: 'v3-admin',
    listPath: '/v3/admin/cs/config/list',
    getPath: '/v3/admin/cs/config',
    namespaceParam: 'namespaceId',
    groupParam: 'groupName',
    onConsoleOrigin: false,
    wrap: enveloped,
    make: (http) => new V3AdminDriver(http)
  },
  {
    flavor: 'v3-console',
    listPath: '/v3/console/cs/config/list',
    getPath: '/v3/console/cs/config',
    namespaceParam: 'namespaceId',
    groupParam: 'groupName',
    onConsoleOrigin: true,
    wrap: enveloped,
    make: (http, consoleBaseUrl) => new V3ConsoleDriver(http, consoleBaseUrl)
  }
];

/** Where a driver's request should land, context path included or not. */
function expectedPath(driverCase: ConfigDriverCase, path: string): string {
  return driverCase.onConsoleOrigin ? path : `${CONTEXT_PATH}${path}`;
}

function respondWith(status: number, body: string, contentType = NACOS_JSON_CONTENT_TYPE): TestRequestHandler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': contentType });
    response.end(body);
  };
}

/**
 * Runs a driver against a real HTTP server rather than a recording stub.
 *
 * The whole risk this file exists to cover is a parameter that never reaches
 * the wire under the name the server reads -- and a stub that records
 * `options.query` asserts on the driver's intent, not on what URL composition
 * produced from it. The server base URL carries a context path and the console
 * base URL does not, which is how a missing `baseUrlOverride` shows up as a
 * wrong path instead of passing silently.
 */
async function drive<T>(
  driverCase: ConfigDriverCase,
  handler: TestRequestHandler,
  run: (driver: NacosDriver) => Promise<T>
): Promise<{ requests: TestHttpServer['requests']; result: PromiseSettledResult<T> }> {
  const server = await startTestHttpServer(handler);
  try {
    const http = new NacosHttpClient({ baseUrl: `${server.origin}${CONTEXT_PATH}` });
    const [result] = await Promise.allSettled([run(driverCase.make(http, server.origin))]);
    return { requests: server.requests, result: result as PromiseSettledResult<T> };
  } finally {
    await server.close();
  }
}

/** Surfaces the driver's own failure instead of an unhelpful "undefined is not an object". */
function valueOf<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') {
    throw result.reason;
  }
  return result.value;
}

function errorOf<T>(result: PromiseSettledResult<T>): NacosApiError {
  if (result.status === 'fulfilled') {
    throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  }
  expect(result.reason).toBeInstanceOf(NacosApiError);
  return result.reason as NacosApiError;
}

function pathOf(url: string): string {
  return url.split('?')[0] ?? '';
}

function queryOf(url: string): URLSearchParams {
  return new URL(url, 'http://127.0.0.1').searchParams;
}

for (const driverCase of DRIVER_CASES) {
  const { flavor, listPath, getPath, namespaceParam, groupParam, wrap } = driverCase;
  const otherNamespaceParam = namespaceParam === 'tenant' ? 'namespaceId' : 'tenant';
  const otherGroupParam = groupParam === 'group' ? 'groupName' : 'group';

  describe(`${flavor} config driver`, () => {
    it(`lists configs from ${listPath}`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, wrap(REAL_ACCURATE_PAGE)), (driver) =>
        driver.listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      valueOf(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe('GET');
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, listPath));
    });

    /**
     * The silent failure this project is most exposed to. An unknown parameter
     * is ignored, so the server answers for the default namespace and the user
     * reads "this namespace is empty" rather than an error.
     */
    it(`names the namespace ${namespaceParam} on the list request, and never ${otherNamespaceParam}`, async () => {
      const { requests } = await drive(driverCase, respondWith(200, wrap(REAL_ACCURATE_PAGE)), (driver) =>
        driver.listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get(namespaceParam)).toBe(NAMESPACE_ID);
      expect(query.has(otherNamespaceParam)).toBe(false);
    });

    it(`names the group ${groupParam} on the list request, and never ${otherGroupParam}`, async () => {
      const { requests } = await drive(driverCase, respondWith(200, wrap(REAL_ACCURATE_PAGE)), (driver) =>
        driver.listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get(groupParam)).toBe('');
      expect(query.has(otherGroupParam)).toBe(false);
    });

    /** `dataId` and `group` are required @RequestParams on v1 even when the caller wants everything. */
    it('asks for an accurate search with empty dataId and group when no term was given', async () => {
      const { requests } = await drive(driverCase, respondWith(200, wrap(REAL_ACCURATE_PAGE)), (driver) =>
        driver.listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 2, pageSize: 50 })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get('search')).toBe('accurate');
      expect(query.get('dataId')).toBe('');
      expect(query.get('pageNo')).toBe('2');
      expect(query.get('pageSize')).toBe('50');
    });

    it('switches to a blur search and wraps the term in wildcards when one was given', async () => {
      const { requests } = await drive(driverCase, respondWith(200, wrap(REAL_BLUR_PAGE)), (driver) =>
        driver.listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100, search: 'uat' })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get('search')).toBe('blur');
      expect(query.get('dataId')).toBe('*uat*');
    });

    it('normalizes a real 2.3.2 page', async () => {
      const { result } = await drive(driverCase, respondWith(200, wrap(REAL_ACCURATE_PAGE)), (driver) =>
        driver.listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      expect(valueOf(result)).toEqual({
        totalCount: 12,
        pageNumber: 1,
        pagesAvailable: 2,
        items: [
          {
            namespaceId: 'uat',
            group: 'cl-intimfy',
            dataId: 'application-uat.yml',
            type: 'yaml',
            appName: undefined,
            md5: undefined
          },
          {
            namespaceId: 'uat',
            group: 'cl-intimfy',
            dataId: 'application-common.properties',
            type: 'properties',
            appName: undefined,
            md5: undefined
          }
        ]
      });
    });

    /**
     * The list response carries every config's full body whether we want it or
     * not, and those bodies hold passwords. Dropping it at this boundary is
     * what makes it impossible for any layer above to leak.
     */
    it('keeps no config content in the summaries', async () => {
      const { result } = await drive(driverCase, respondWith(200, wrap(REAL_ACCURATE_PAGE)), (driver) =>
        driver.listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      expect(JSON.stringify(valueOf(result))).not.toContain('hunter2');
    });

    /** Blur nulls the type out on the real server; `configLanguageId` answers from the dataId instead. */
    it('carries a blur item through with no type rather than inventing one', async () => {
      const { result } = await drive(driverCase, respondWith(200, wrap(REAL_BLUR_PAGE)), (driver) =>
        driver.listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100, search: 'uat' })
      );
      expect(valueOf(result).items[0]?.type).toBeUndefined();
    });

    it(`fetches one config from ${getPath} under the same parameter spellings`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, wrap(REAL_DETAIL)), (driver) =>
        driver.getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID })
      );
      expect(valueOf(result)).toMatchObject({
        dataId: DATA_ID,
        group: GROUP,
        namespaceId: NAMESPACE_ID,
        type: 'yaml'
      });
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, getPath));
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get('dataId')).toBe(DATA_ID);
      expect(query.get(groupParam)).toBe(GROUP);
      expect(query.get(namespaceParam)).toBe(NAMESPACE_ID);
      expect(query.has(otherGroupParam)).toBe(false);
      expect(query.has(otherNamespaceParam)).toBe(false);
    });

    it('keeps the newlines of the fetched content, which is the whole point of the document', async () => {
      const { result } = await drive(driverCase, respondWith(200, wrap(REAL_DETAIL)), (driver) =>
        driver.getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID })
      );
      expect(valueOf(result).content.split('\n')).toHaveLength(3);
    });

    /**
     * The 404 that must NOT walk the driver chain. Trying an older API family
     * cannot conjure up a dataId nobody published, and falling through would
     * report "no API flavor could serve this" for a plain missing config.
     */
    it('reports a missing config as resource-not-found and refuses to fall through', async () => {
      const { result } = await drive(
        driverCase,
        respondWith(404, MISSING_CONFIG_BODY, NACOS_JSON_CONTENT_TYPE),
        (driver) => driver.getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: 'nope.yml' })
      );
      const error = errorOf(result);
      expect(error.kind).toBe('resource-not-found');
      expect(error.status).toBe(404);
      expect(error.shouldFallThrough()).toBe(false);
    });

    /**
     * What a real Nacos 2.3.2 actually answers for a dataId nobody published,
     * which is not what the research predicted.
     *
     * `?show=all` is a *different controller method* from the plain-text form
     * on the same path: it returns a `ConfigAllInfo`, and Spring serializes a
     * null one as **HTTP 200 with `Content-Length: 0`** -- under a
     * `Content-Type: application/json` that describes nothing at all. Only
     * the plain-text form answers `404 config data not exist`, and that form
     * carries no `type`, which is exactly why this milestone cannot use it.
     *
     * An empty config is not this: it comes back as an object with
     * `content: ""`, so there is no ambiguity to resolve.
     */
    it('reports an empty 200 body as a missing config rather than as a broken response', async () => {
      const { result } = await drive(driverCase, respondWith(200, ''), (driver) =>
        driver.getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: 'nope.yml' })
      );
      const error = errorOf(result);
      expect(error.kind).toBe('resource-not-found');
      expect(error.shouldFallThrough()).toBe(false);
    });

    /** The same absence, spelled as a JSON null instead of as no bytes at all. */
    it('reports a 200 that carries a null config the same way', async () => {
      const { result } = await drive(driverCase, respondWith(200, wrap('null')), (driver) =>
        driver.getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: 'nope.yml' })
      );
      expect(errorOf(result).kind).toBe('resource-not-found');
    });

    /**
     * 3.x reports the same absence as a 404 carrying `{"code":20004,...}`,
     * which *is* JSON but is not a Spring error page. Pinned so that the
     * discriminator stays the three-key shape rather than "did the body
     * parse".
     */
    it('reads a 3.x code-20004 body as a missing config too, not as a missing endpoint', async () => {
      const { result } = await drive(
        driverCase,
        respondWith(404, '{"code":20004,"message":"resource not found","data":null}'),
        (driver) => driver.getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: 'nope.yml' })
      );
      const error = errorOf(result);
      expect(error.kind).toBe('resource-not-found');
      expect(error.shouldFallThrough()).toBe(false);
    });

    /** The other 404: this version has no such endpoint, so the next driver has to be tried. */
    it('reports a Spring error page as not-found and does fall through', async () => {
      const { result } = await drive(driverCase, respondWith(404, SPRING_ERROR_PAGE), (driver) =>
        driver.getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID })
      );
      const error = errorOf(result);
      expect(error.kind).toBe('not-found');
      expect(error.shouldFallThrough()).toBe(true);
    });

    it.each([
      [403, 'forbidden'],
      [410, 'api-deprecated'],
      [500, 'api-error']
    ])('keeps the existing classification of HTTP %s', async (status, kind) => {
      const { result } = await drive(driverCase, respondWith(status, '{"code":10001,"message":"denied"}'), (driver) =>
        driver.getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID })
      );
      const error = errorOf(result);
      expect(error.kind).toBe(kind);
      expect(error.status).toBe(status);
    });

    it('names the endpoint when the fetched body is not a config at all', async () => {
      const { result } = await drive(driverCase, respondWith(200, wrap('{"totalCount":0}')), (driver) =>
        driver.getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID })
      );
      expect(errorOf(result).kind).toBe('invalid-response');
    });

    /**
     * A raw TypeError out of `.map()` carries no kind, so the resolver could
     * not judge whether to try the next driver and the chain would stop dead.
     */
    it('raises invalid-response naming the endpoint when the page is neither shape', async () => {
      const { result } = await drive(driverCase, respondWith(200, wrap('{"totalCount":0}')), (driver) =>
        driver.listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      const error = errorOf(result);
      expect(error.kind).toBe('invalid-response');
      expect(error.message).toContain(listPath);
    });

    /**
     * Measured on the real server: a page carries the full body of every
     * config in it, 12 configs came to 38KB, and Nacos caps one config at
     * 100KB. Without a cap a hundred-item page is a 10MB buffer in the
     * extension host, so the stream has to be aborted rather than measured
     * after the fact.
     */
    it('aborts a list response that runs past the cap instead of buffering it', async () => {
      const { result } = await drive(driverCase, respondWith(200, 'x'.repeat(400_000)), (driver) =>
        driver.listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 1 })
      );
      expect(errorOf(result).kind).toBe('response-too-large');
    });
  });
}

interface StubCall {
  method: string;
  path: string;
  options: NacosRequestOptions | undefined;
}

interface StubHttp {
  calls: StubCall[];
  client: Pick<NacosHttpClient, 'requestJson' | 'requestRaw'>;
}

/** Both request surfaces are generic or concrete in ways that need one cast; it happens here. */
function stubHttp(payload: unknown): StubHttp {
  const calls: StubCall[] = [];
  const text = JSON.stringify(payload);
  return {
    calls,
    client: {
      async requestJson<T>(method: string, path: string, options?: NacosRequestOptions): Promise<T> {
        calls.push({ method, path, options });
        return payload as T;
      },
      async requestRaw(method: string, path: string, options?: NacosRequestOptions) {
        calls.push({ method, path, options });
        return { status: 200, ok: true, text, contentType: NACOS_JSON_CONTENT_TYPE };
      }
    }
  };
}

const PAGE_PAYLOAD = { totalCount: 0, pageNumber: 1, pagesAvailable: 0, pageItems: [] };
const DETAIL_PAYLOAD = { dataId: DATA_ID, group: GROUP, tenant: NAMESPACE_ID, content: 'a: 1', type: 'yaml' };
const CONSOLE_BASE_URL = 'http://h:8080';

describe('config request options', () => {
  /**
   * 128KB per item is Nacos's own 100KB per-config ceiling with room for the
   * JSON escaping of it; the 4MB ceiling is what stops a caller's large
   * pageSize from turning the cap back off.
   */
  it('sizes the list cap from the page size', async () => {
    const http = stubHttp(PAGE_PAYLOAD);
    await new V1Driver(http.client).listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 10 });
    expect(http.calls[0]?.options?.maxResponseBytes).toBe(10 * 128 * 1024);
  });

  it('holds the list cap at 4MB however large the page size is', async () => {
    const http = stubHttp(PAGE_PAYLOAD);
    await new V1Driver(http.client).listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 });
    expect(http.calls[0]?.options?.maxResponseBytes).toBe(4 * 1024 * 1024);
  });

  /**
   * A single config is bounded by the server's own content limit, with no
   * multiplier to guard against -- and an operator who raised that limit
   * should not find their configs unopenable.
   */
  it('caps nothing on a single-config fetch', async () => {
    const http = stubHttp(DETAIL_PAYLOAD);
    await new V1Driver(http.client).getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID });
    expect(http.calls[0]?.options?.maxResponseBytes).toBeUndefined();
  });

  it('sends the console driver to the console origin for both capabilities', async () => {
    const listHttp = stubHttp(PAGE_PAYLOAD);
    await new V3ConsoleDriver(listHttp.client, CONSOLE_BASE_URL).listConfigs({
      namespaceId: NAMESPACE_ID,
      pageNo: 1,
      pageSize: 100
    });
    expect(listHttp.calls[0]?.options?.baseUrlOverride).toBe(CONSOLE_BASE_URL);

    const detailHttp = stubHttp(DETAIL_PAYLOAD);
    await new V3ConsoleDriver(detailHttp.client, CONSOLE_BASE_URL).getConfig({
      namespaceId: NAMESPACE_ID,
      group: GROUP,
      dataId: DATA_ID
    });
    expect(detailHttp.calls[0]?.options?.baseUrlOverride).toBe(CONSOLE_BASE_URL);
  });

  it('leaves the other three drivers on the server base url', async () => {
    for (const make of [
      (http: StubHttp) => new V1Driver(http.client),
      (http: StubHttp) => new V2Driver(http.client),
      (http: StubHttp) => new V3AdminDriver(http.client)
    ]) {
      const listHttp = stubHttp(PAGE_PAYLOAD);
      await make(listHttp).listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 });
      expect(listHttp.calls[0]?.options?.baseUrlOverride).toBeUndefined();

      const detailHttp = stubHttp(DETAIL_PAYLOAD);
      await make(detailHttp).getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID });
      expect(detailHttp.calls[0]?.options?.baseUrlOverride).toBeUndefined();
    }
  });
});

/**
 * v2 answering config requests on the v1 paths is a deliberate decision, not
 * an omission, so it is pinned here: Nacos v2 never shipped a config *list*
 * endpoint, and `/v2/cs/config` hands back `data` as a bare content string
 * with no `type` in it -- and `type` is what picks the editor's language mode.
 */
describe('the v2 config driver deliberately speaks v1', () => {
  it('uses the v1 paths rather than /v2/cs/config', async () => {
    const listHttp = stubHttp(PAGE_PAYLOAD);
    await new V2Driver(listHttp.client).listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 });
    expect(listHttp.calls[0]?.path).toBe('/v1/cs/configs');

    const detailHttp = stubHttp(DETAIL_PAYLOAD);
    await new V2Driver(detailHttp.client).getConfig({
      namespaceId: NAMESPACE_ID,
      group: GROUP,
      dataId: DATA_ID
    });
    expect(detailHttp.calls[0]?.path).toBe('/v1/cs/configs');
  });

  /**
   * And therefore speaks the v1 *parameter* dialect. `namespaceParamName`
   * keys on the endpoint family rather than on the server answering it, so a
   * v2 driver calling a v1 path must ask as a v1 driver -- send `namespaceId`
   * to `/v1/cs/configs` and the server ignores it and answers for the default
   * namespace, which reads as an empty namespace rather than as an error.
   */
  it('spells the namespace tenant, because that is what the v1 endpoint reads', async () => {
    const http = stubHttp(PAGE_PAYLOAD);
    await new V2Driver(http.client).listConfigs({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 });
    expect(http.calls[0]?.options?.query).toMatchObject({ tenant: NAMESPACE_ID });
    expect(http.calls[0]?.options?.query).not.toHaveProperty('namespaceId');
  });
});

describe('the v1 detail endpoint', () => {
  /** The plain-text form of the same path carries no `type`; only `show=all` does. */
  it('is asked with show=all so that the response carries a type', async () => {
    const http = stubHttp(DETAIL_PAYLOAD);
    await new V1Driver(http.client).getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID });
    expect(http.calls[0]?.options?.query).toMatchObject({ show: 'all' });
  });

  /** v3 has a detail endpoint of its own and no `show` parameter to pass it. */
  it('has no v3 counterpart, so no show parameter is sent there', async () => {
    const http = stubHttp({ code: 0, data: DETAIL_PAYLOAD });
    await new V3AdminDriver(http.client).getConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID });
    expect(http.calls[0]?.options?.query).not.toHaveProperty('show');
  });
});
