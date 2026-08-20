import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import { NacosHttpClient } from '../../../src/nacos/NacosHttpClient';
import type { NacosApiFlavor, NacosDriver } from '../../../src/nacos/driver/NacosDriver';
import { V1Driver } from '../../../src/nacos/driver/V1Driver';
import { V2Driver } from '../../../src/nacos/driver/V2Driver';
import { V3AdminDriver } from '../../../src/nacos/driver/V3AdminDriver';
import { V3ConsoleDriver } from '../../../src/nacos/driver/V3ConsoleDriver';
import { startTestHttpServer, type TestHttpServer, type TestRequestHandler } from '../testHttpServer';

/** Kept on the server base URL and off the console one, exactly as Nacos 3.x deploys them. */
const CONTEXT_PATH = '/nacos';

/** Not '' or 'public', so a dropped namespace parameter cannot pass by accident. */
const NAMESPACE_ID = 'uat';
const GROUP = 'cl-intimfy';
const DATA_ID = 'application-uat.yml';
const SERVICE = 'order-service';
const NID = '203';

const NACOS_JSON_CONTENT_TYPE = 'application/json;charset=UTF-8';

const bare = (json: string): string => json;
const enveloped = (json: string): string => `{"code":0,"message":"success","data":${json}}`;

/**
 * A history page in the 1.x/2.x shape: ISO timestamps under
 * `createdTime`/`lastModifiedTime` and an `opType` padded by its `char`
 * column.
 *
 * **The row's field names are unverified** -- the real 2.3.2 this project
 * tests against holds no history at all, so only the empty envelope around
 * this has been measured (§14.8). They come from `ConfigHistoryInfo`.
 */
const V1_HISTORY_PAGE = String.raw`{"totalCount":2,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"id":203,"lastId":-1,"dataId":"application-uat.yml","group":"cl-intimfy","tenant":"uat","appName":"","md5":null,"content":null,"srcIp":"192.168.66.66","srcUser":"nacos","opType":"U ","createdTime":"2026-08-01T10:20:30.000+08:00","lastModifiedTime":"2026-08-12T18:45:00.000+08:00"},{"id":142,"lastId":-1,"dataId":"application-uat.yml","group":"cl-intimfy","tenant":"uat","appName":"","md5":null,"content":null,"srcIp":"192.168.66.66","srcUser":"nacos","opType":"I ","createdTime":"2026-07-20T09:00:00.000+08:00","lastModifiedTime":"2026-07-20T09:00:00.000+08:00"}]}`;

/** The same page as 3.x sends it: renamed ref fields and millisecond timestamps. */
const V3_HISTORY_PAGE = String.raw`{"totalCount":2,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"id":203,"dataId":"application-uat.yml","groupName":"cl-intimfy","namespaceId":"uat","appName":"","srcIp":"192.168.66.66","srcUser":"nacos","opType":"U ","publishType":"formal","createTime":1785550830000,"modifyTime":1786531500000},{"id":142,"dataId":"application-uat.yml","groupName":"cl-intimfy","namespaceId":"uat","appName":"","srcIp":"192.168.66.66","srcUser":"nacos","opType":"I ","publishType":"formal","createTime":1784509200000,"modifyTime":1784509200000}]}`;

/** The measured answer for a config with no history at all: a page, not a 404. */
const EMPTY_HISTORY_PAGE = String.raw`{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}`;

/** `GET /v1/cs/history?nid=` -- a `ConfigHistoryInfo`, which carries the content of that version. */
const V1_HISTORY_DETAIL = String.raw`{"id":203,"lastId":-1,"dataId":"application-uat.yml","group":"cl-intimfy","tenant":"uat","appName":"","md5":"e1a9de8c8df94a487159b655a3c8f703","content":"spring:\n  profiles: uat","srcIp":"192.168.66.66","srcUser":"nacos","opType":"U ","createdTime":"2026-08-01T10:20:30.000+08:00","lastModifiedTime":"2026-08-12T18:45:00.000+08:00","encryptedDataKey":""}`;

const V3_HISTORY_DETAIL = String.raw`{"id":203,"dataId":"application-uat.yml","groupName":"cl-intimfy","namespaceId":"uat","appName":"","md5":"e1a9de8c8df94a487159b655a3c8f703","content":"spring:\n  profiles: uat","srcIp":"192.168.66.66","srcUser":"nacos","opType":"U ","createTime":1785550830000,"modifyTime":1786531500000,"encryptedDataKey":""}`;

/** `GET /v1/cs/configs/listener` on the real 2.3.2 -- with a listener invented, since that server has none. */
const LISTENER_STATUS = String.raw`{"collectStatus":200,"lisentersGroupkeyStatus":{"192.168.99.92":"e1a9de8c8df94a487159b655a3c8f703"}}`;

/** The measured answer for a config nobody is watching, verbatim. */
const EMPTY_LISTENER_STATUS = String.raw`{"collectStatus":200,"lisentersGroupkeyStatus":{}}`;

/** `GET /v1/ns/service` on the real 2.3.2, verbatim: `clusters` is an array and the name field is `name`. */
const V1_SERVICE_DETAIL = String.raw`{"namespaceId":"uat","groupName":"cl-intimfy","name":"order-service","protectThreshold":0.0,"metadata":{},"selector":{"type":"none","contextType":"NONE"},"clusters":[{"name":"DEFAULT","healthChecker":{"type":"TCP"},"metadata":{}}]}`;

/** `GET /v2/ns/service` on the same server, verbatim: `clusterMap` is an object and the namespace is `namespace`. */
const V2_SERVICE_DETAIL = String.raw`{"namespace":"uat","serviceName":"order-service","groupName":"cl-intimfy","clusterMap":{"DEFAULT":{"clusterName":"DEFAULT","healthChecker":{"type":"TCP"},"metadata":{},"hosts":null}},"metadata":{},"protectThreshold":0.0,"selector":{"type":"none","contextType":"NONE"},"ephemeral":true}`;

/** 3.x keeps 2.x's shape but goes back to `namespaceId`. */
const V3_SERVICE_DETAIL = String.raw`{"namespaceId":"uat","serviceName":"order-service","groupName":"cl-intimfy","clusterMap":{"DEFAULT":{"clusterName":"DEFAULT","healthChecker":{"type":"TCP"},"metadata":{},"hosts":null}},"metadata":{},"protectThreshold":0.0,"ephemeral":true}`;

/** `GET /v1/ns/service/subscribers` on the real 2.3.2, verbatim. */
const V1_SUBSCRIBERS = String.raw`{"subscribers":[{"addrStr":"192.168.99.92","agent":"Nacos-Java-Client:v2.3.2","app":"unknown","ip":"192.168.99.92","port":0,"namespaceId":"uat","serviceName":"cl-intimfy@@order-service","cluster":""}],"count":1}`;

/** 3.x pages the same rows, per the research. */
const V3_SUBSCRIBERS = String.raw`{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"addrStr":"192.168.99.92","agent":"Nacos-Java-Client:v2.3.2","app":"unknown","ip":"192.168.99.92","port":0,"namespaceId":"uat","serviceName":"cl-intimfy@@order-service","cluster":""}]}`;

/** The measured answer for a service nobody watches -- and for one that does not exist. */
const EMPTY_SUBSCRIBERS = String.raw`{"subscribers":[],"count":0}`;

/** Spring Boot's own 404 page: the body that means "this version has no such endpoint". */
const SPRING_ERROR_PAGE =
  '{"timestamp":"2026-08-14T00:34:34.539+08:00","status":404,"error":"Not Found","message":"No message available","path":"/nacos/v1/cs/history"}';

interface HistoryDriverCase {
  flavor: NacosApiFlavor;
  historyListPath: string;
  historyListBody: string;
  /** 1.x/2.x tell the list and the detail apart by query alone; 3.x gave the list its own path. */
  historyListNeedsSearchParam: boolean;
  historyDetailPath: string;
  historyDetailBody: string;
  listenerPath: string;
  serviceDetailPath: string;
  serviceDetailBody: string;
  subscribersPath: string;
  subscribersBody: string;
  /** §6.1: only the v1 config endpoints say `tenant`, and v2 reaches them too. */
  configNamespaceParam: 'tenant' | 'namespaceId';
  configGroupParam: 'group' | 'groupName';
  /**
   * v1 encodes the group into the service name; everything after it sends the
   * two apart. These are two flags rather than one because **v2 is in both
   * dialects at once**: it has a service detail endpoint of its own and no
   * subscriber endpoint at all, so the same driver asks one question in the
   * v2 dialect and the other in the v1 one.
   */
  serviceDetailSendsGroupedName: boolean;
  subscribersSendGroupedName: boolean;
  /** Only the 3.x subscriber listings page, so only they have to ask for a page. */
  subscribersArePaged: boolean;
  onConsoleOrigin: boolean;
  wrap(json: string): string;
  make(http: NacosHttpClient, consoleBaseUrl: string): NacosDriver;
}

const DRIVER_CASES: HistoryDriverCase[] = [
  {
    flavor: 'v1',
    historyListPath: '/v1/cs/history',
    historyListBody: V1_HISTORY_PAGE,
    historyListNeedsSearchParam: true,
    historyDetailPath: '/v1/cs/history',
    historyDetailBody: V1_HISTORY_DETAIL,
    listenerPath: '/v1/cs/configs/listener',
    serviceDetailPath: '/v1/ns/service',
    serviceDetailBody: V1_SERVICE_DETAIL,
    subscribersPath: '/v1/ns/service/subscribers',
    subscribersBody: V1_SUBSCRIBERS,
    configNamespaceParam: 'tenant',
    configGroupParam: 'group',
    serviceDetailSendsGroupedName: true,
    subscribersSendGroupedName: true,
    subscribersArePaged: false,
    onConsoleOrigin: false,
    wrap: bare,
    make: (http) => new V1Driver(http)
  },
  /**
   * Every one of v2's four new endpoints is measured, and three of them are
   * not v2's own. A real 2.3.2 answers **404** for
   * `/v2/ns/service/subscribers` and for `/v2/cs/config/listener` -- neither
   * exists -- and `/v2/cs/history/list` demands `group`, the *v1* spelling,
   * beside the v2 `namespaceId`. Reaching the v1 paths instead is what v2
   * already does for both configuration capabilities, and it keeps that third
   * half-and-half dialect out of the codebase.
   */
  {
    flavor: 'v2',
    historyListPath: '/v1/cs/history',
    historyListBody: V1_HISTORY_PAGE,
    historyListNeedsSearchParam: true,
    historyDetailPath: '/v1/cs/history',
    historyDetailBody: V1_HISTORY_DETAIL,
    listenerPath: '/v1/cs/configs/listener',
    serviceDetailPath: '/v2/ns/service',
    serviceDetailBody: enveloped(V2_SERVICE_DETAIL),
    subscribersPath: '/v1/ns/service/subscribers',
    subscribersBody: V1_SUBSCRIBERS,
    configNamespaceParam: 'tenant',
    configGroupParam: 'group',
    serviceDetailSendsGroupedName: false,
    subscribersSendGroupedName: true,
    subscribersArePaged: false,
    onConsoleOrigin: false,
    wrap: bare,
    make: (http) => new V2Driver(http)
  },
  {
    flavor: 'v3-admin',
    historyListPath: '/v3/admin/cs/history/list',
    historyListBody: enveloped(V3_HISTORY_PAGE),
    historyListNeedsSearchParam: false,
    historyDetailPath: '/v3/admin/cs/history',
    historyDetailBody: enveloped(V3_HISTORY_DETAIL),
    listenerPath: '/v3/admin/cs/config/listener',
    serviceDetailPath: '/v3/admin/ns/service',
    serviceDetailBody: enveloped(V3_SERVICE_DETAIL),
    subscribersPath: '/v3/admin/ns/service/subscribers',
    subscribersBody: enveloped(V3_SUBSCRIBERS),
    configNamespaceParam: 'namespaceId',
    configGroupParam: 'groupName',
    serviceDetailSendsGroupedName: false,
    subscribersSendGroupedName: false,
    subscribersArePaged: true,
    onConsoleOrigin: false,
    wrap: enveloped,
    make: (http) => new V3AdminDriver(http)
  },
  {
    flavor: 'v3-console',
    historyListPath: '/v3/console/cs/history/list',
    historyListBody: enveloped(V3_HISTORY_PAGE),
    historyListNeedsSearchParam: false,
    historyDetailPath: '/v3/console/cs/history',
    historyDetailBody: enveloped(V3_HISTORY_DETAIL),
    listenerPath: '/v3/console/cs/config/listener',
    serviceDetailPath: '/v3/console/ns/service',
    serviceDetailBody: enveloped(V3_SERVICE_DETAIL),
    subscribersPath: '/v3/console/ns/service/subscribers',
    subscribersBody: enveloped(V3_SUBSCRIBERS),
    configNamespaceParam: 'namespaceId',
    configGroupParam: 'groupName',
    serviceDetailSendsGroupedName: false,
    subscribersSendGroupedName: false,
    subscribersArePaged: true,
    onConsoleOrigin: true,
    wrap: enveloped,
    make: (http, consoleBaseUrl) => new V3ConsoleDriver(http, consoleBaseUrl)
  }
];

function expectedPath(driverCase: HistoryDriverCase, path: string): string {
  return driverCase.onConsoleOrigin ? path : `${CONTEXT_PATH}${path}`;
}

function respondWith(status: number, body: string, contentType = NACOS_JSON_CONTENT_TYPE): TestRequestHandler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': contentType });
    response.end(body);
  };
}

/**
 * Runs a driver against a real HTTP server rather than a recording stub, for
 * the reason the other two driver suites do: the risk here is a parameter that
 * never reaches the wire under the name the server reads, and a stub that
 * records `options.query` asserts on the driver's intent rather than on what
 * URL composition made of it.
 */
async function drive<T>(
  driverCase: HistoryDriverCase,
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

const CONFIG_REF = { namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID };
const SERVICE_REF = { namespaceId: NAMESPACE_ID, group: GROUP, serviceName: SERVICE };

for (const driverCase of DRIVER_CASES) {
  const { flavor, configNamespaceParam, configGroupParam } = driverCase;
  const otherNamespaceParam = configNamespaceParam === 'tenant' ? 'namespaceId' : 'tenant';
  const otherGroupParam = configGroupParam === 'group' ? 'groupName' : 'group';

  describe(`${flavor} config history driver`, () => {
    it(`lists history from ${driverCase.historyListPath}`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, driverCase.historyListBody), (driver) =>
        driver.listConfigHistory({ ...CONFIG_REF, pageNo: 1, pageSize: 100 })
      );

      expect(valueOf(result)).toEqual({
        totalCount: 2,
        pageNumber: 1,
        pagesAvailable: 1,
        items: [
          {
            namespaceId: NAMESPACE_ID,
            group: GROUP,
            dataId: DATA_ID,
            id: '203',
            opType: 'U',
            modifiedAt: Date.parse('2026-08-12T18:45:00.000+08:00'),
            srcIp: '192.168.66.66',
            srcUser: 'nacos',
            appName: undefined
          },
          {
            namespaceId: NAMESPACE_ID,
            group: GROUP,
            dataId: DATA_ID,
            id: '142',
            opType: 'I',
            modifiedAt: Date.parse('2026-07-20T09:00:00.000+08:00'),
            srcIp: '192.168.66.66',
            srcUser: 'nacos',
            appName: undefined
          }
        ]
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe('GET');
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, driverCase.historyListPath));
    });

    /**
     * The silent failure this project is most exposed to. An unknown parameter
     * is dropped, so the server answers for the default namespace and the user
     * reads "this config has no history" rather than an error.
     */
    it(`names the namespace ${configNamespaceParam} on the history listing, and never ${otherNamespaceParam}`, async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.historyListBody), (driver) =>
        driver.listConfigHistory({ ...CONFIG_REF, pageNo: 1, pageSize: 100 })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get(configNamespaceParam)).toBe(NAMESPACE_ID);
      expect(query.has(otherNamespaceParam)).toBe(false);
    });

    it(`names the group ${configGroupParam}, and never ${otherGroupParam}`, async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.historyListBody), (driver) =>
        driver.listConfigHistory({ ...CONFIG_REF, pageNo: 1, pageSize: 100 })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get(configGroupParam)).toBe(GROUP);
      expect(query.has(otherGroupParam)).toBe(false);
      expect(query.get('dataId')).toBe(DATA_ID);
    });

    it('passes the paging through as the caller asked for it', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.historyListBody), (driver) =>
        driver.listConfigHistory({ ...CONFIG_REF, pageNo: 3, pageSize: 50 })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get('pageNo')).toBe('3');
      expect(query.get('pageSize')).toBe('50');
    });

    /**
     * §10: the history listing is the **only** paged Nacos endpoint with a
     * server-side hard cap, `Math.min(500, pageSize)` in its own source.
     * Clamping here as well is what gives "why did I only get 500 rows" a
     * traceable origin, instead of leaving it looking like a truncated
     * response.
     */
    it('clamps a pageSize past the server-side cap of 500 rather than sending it', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.historyListBody), (driver) =>
        driver.listConfigHistory({ ...CONFIG_REF, pageNo: 1, pageSize: 9999 })
      );
      expect(queryOf(requests[0]?.url ?? '').get('pageSize')).toBe('500');
    });

    it('sends a pageSize at the cap unchanged', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.historyListBody), (driver) =>
        driver.listConfigHistory({ ...CONFIG_REF, pageNo: 1, pageSize: 500 })
      );
      expect(queryOf(requests[0]?.url ?? '').get('pageSize')).toBe('500');
    });

    /**
     * A config that has never been republished has no history, and that is
     * the normal state of most configs -- measured on a real 2.3.2, where
     * every config answers this. Reading it as a failure would put an error
     * in front of a user whose server is fine.
     */
    it('reads a config with no history as an empty page rather than as a failure', async () => {
      const { result } = await drive(
        driverCase,
        respondWith(200, driverCase.wrap(EMPTY_HISTORY_PAGE)),
        (driver) => driver.listConfigHistory({ ...CONFIG_REF, pageNo: 1, pageSize: 100 })
      );
      expect(valueOf(result)).toEqual({ items: [], totalCount: 0, pageNumber: 1, pagesAvailable: 0 });
    });

    /**
     * 1.x and 2.x serve the listing and the detail from **one path**, told
     * apart by `search=accurate` against `nid`. 3.x gave the listing a path of
     * its own, so sending the parameter there would only be noise.
     */
    it(
      driverCase.historyListNeedsSearchParam
        ? 'asks for the accurate search mode, which is what separates the listing from the detail on one path'
        : 'sends no search mode, because 3.x gave the listing its own path',
      async () => {
        const { requests } = await drive(driverCase, respondWith(200, driverCase.historyListBody), (driver) =>
          driver.listConfigHistory({ ...CONFIG_REF, pageNo: 1, pageSize: 100 })
        );
        const query = queryOf(requests[0]?.url ?? '');
        expect(query.get('search')).toBe(driverCase.historyListNeedsSearchParam ? 'accurate' : null);
        expect(query.has('nid')).toBe(false);
      }
    );

    it(`fetches one history version from ${driverCase.historyDetailPath}, as a config detail`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, driverCase.historyDetailBody), (driver) =>
        driver.getConfigHistory({ ...CONFIG_REF, nid: NID })
      );

      expect(valueOf(result)).toMatchObject({
        namespaceId: NAMESPACE_ID,
        group: GROUP,
        dataId: DATA_ID,
        content: 'spring:\n  profiles: uat',
        md5: 'e1a9de8c8df94a487159b655a3c8f703'
      });
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, driverCase.historyDetailPath));
      expect(queryOf(requests[0]?.url ?? '').get('nid')).toBe(NID);
    });

    /**
     * The detail is the left-hand side of a diff, so the timestamps have to
     * survive the crossing whichever way the version spells them -- otherwise
     * a history version renders with no date on it.
     */
    it('normalizes the history detail timestamps to milliseconds', async () => {
      const { result } = await drive(driverCase, respondWith(200, driverCase.historyDetailBody), (driver) =>
        driver.getConfigHistory({ ...CONFIG_REF, nid: NID })
      );
      expect(valueOf(result).modifyTime).toBe(Date.parse('2026-08-12T18:45:00.000+08:00'));
    });

    it('carries the config identity on the history detail request too', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.historyDetailBody), (driver) =>
        driver.getConfigHistory({ ...CONFIG_REF, nid: NID })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get('dataId')).toBe(DATA_ID);
      expect(query.get(configGroupParam)).toBe(GROUP);
      expect(query.get(configNamespaceParam)).toBe(NAMESPACE_ID);
    });

    /**
     * How a real 2.3.2 reports a `nid` that is not there: **HTTP 200 with an
     * empty body** on v1, `data: null` on v2 -- both measured. It is the same
     * absence `?show=all` reports for a missing config (§14.2 ⓪), and it must
     * not walk the driver chain looking for an API version that could conjure
     * up a version nobody wrote.
     */
    it('reads a missing history version as resource-not-found rather than falling through', async () => {
      const { result } = await drive(driverCase, respondWith(200, ''), (driver) =>
        driver.getConfigHistory({ ...CONFIG_REF, nid: '999999' })
      );
      const error = errorOf(result);
      expect(error.kind).toBe('resource-not-found');
      expect(error.shouldFallThrough()).toBe(false);
    });

    it('reads a null history version the same way', async () => {
      const { result } = await drive(driverCase, respondWith(200, '{"code":0,"message":"success","data":null}'), (driver) =>
        driver.getConfigHistory({ ...CONFIG_REF, nid: '999999' })
      );
      expect(errorOf(result).kind).toBe('resource-not-found');
    });

    /** A Spring error page at 404 still means the endpoint is not there, and still falls through. */
    it('falls through when the history endpoint itself is missing', async () => {
      const { result } = await drive(driverCase, respondWith(404, SPRING_ERROR_PAGE), (driver) =>
        driver.getConfigHistory({ ...CONFIG_REF, nid: NID })
      );
      const error = errorOf(result);
      expect(error.kind).toBe('not-found');
      expect(error.shouldFallThrough()).toBe(true);
    });
  });

  describe(`${flavor} config listener driver`, () => {
    it(`reads the listeners from ${driverCase.listenerPath}`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, driverCase.wrap(LISTENER_STATUS)), (driver) =>
        driver.listConfigListeners(CONFIG_REF)
      );

      expect(valueOf(result)).toEqual([{ ip: '192.168.99.92', md5: 'e1a9de8c8df94a487159b655a3c8f703' }]);
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, driverCase.listenerPath));
    });

    it(`names the config in this version's dialect`, async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.wrap(LISTENER_STATUS)), (driver) =>
        driver.listConfigListeners(CONFIG_REF)
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get('dataId')).toBe(DATA_ID);
      expect(query.get(configGroupParam)).toBe(GROUP);
      expect(query.get(configNamespaceParam)).toBe(NAMESPACE_ID);
      expect(query.has(otherGroupParam)).toBe(false);
    });

    /**
     * `sampleTime` is how many rounds the server spends polling its cluster
     * for holders. Its default is 1, and it is sent anyway for the reason
     * `withInstances=false` is: a form-bound default is the one thing a client
     * cannot see from the request.
     */
    it('asks for a single sampling round explicitly', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.wrap(LISTENER_STATUS)), (driver) =>
        driver.listConfigListeners(CONFIG_REF)
      );
      expect(queryOf(requests[0]?.url ?? '').get('sampleTime')).toBe('1');
    });

    it('sends aggregation on 3.x listener requests and omits it on v1/v2', async () => {
      const { requests } = await drive(
        driverCase,
        respondWith(200, driverCase.wrap(LISTENER_STATUS)),
        (driver) => driver.listConfigListeners(CONFIG_REF)
      );
      const query = queryOf(requests[0]?.url ?? '');
      if (flavor === 'v3-admin' || flavor === 'v3-console') {
        expect(query.get('aggregation')).toBe('true');
      } else {
        expect(query.has('aggregation')).toBe(false);
      }
    });

    it('lets the caller disable listener aggregation on 3.x', async () => {
      const { requests } = await drive(
        driverCase,
        respondWith(200, driverCase.wrap(LISTENER_STATUS)),
        (driver) => driver.listConfigListeners({ ...CONFIG_REF, aggregation: false })
      );
      const query = queryOf(requests[0]?.url ?? '');
      if (flavor === 'v3-admin' || flavor === 'v3-console') {
        expect(query.get('aggregation')).toBe('false');
      }
    });

    /**
     * The measured answer for a config nobody is watching -- and, on a real
     * 2.3.2, the identical answer for a dataId nobody ever published. Empty is
     * the ordinary case, not an error.
     */
    it('reads an empty status map as nobody listening rather than as a failure', async () => {
      const { result } = await drive(driverCase, respondWith(200, driverCase.wrap(EMPTY_LISTENER_STATUS)), (driver) =>
        driver.listConfigListeners(CONFIG_REF)
      );
      expect(valueOf(result)).toEqual([]);
    });

    it('raises invalid-response naming the endpoint when the status map is not there', async () => {
      const { result } = await drive(driverCase, respondWith(200, driverCase.wrap('{"collectStatus":200}')), (driver) =>
        driver.listConfigListeners(CONFIG_REF)
      );
      const error = errorOf(result);
      expect(error.kind).toBe('invalid-response');
      expect(error.message).toContain(driverCase.listenerPath);
    });
  });

  describe(`${flavor} service detail driver`, () => {
    it(`reads the service from ${driverCase.serviceDetailPath}`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, driverCase.serviceDetailBody), (driver) =>
        driver.getService(SERVICE_REF)
      );

      expect(valueOf(result)).toMatchObject({
        namespaceId: NAMESPACE_ID,
        group: GROUP,
        serviceName: SERVICE,
        protectThreshold: 0,
        metadata: {},
        clusters: [{ name: 'DEFAULT', healthCheckerType: 'TCP', metadata: {} }]
      });
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, driverCase.serviceDetailPath));
    });

    /**
     * v1's service detail reads the group out of the *grouped* name; a bare
     * one there resolves to `DEFAULT_GROUP@@name` and answers HTTP 500 "service
     * not found" -- measured. Everything from v2 takes the two apart, and
     * sending a grouped name there would compose the group in twice.
     */
    it(
      driverCase.serviceDetailSendsGroupedName
        ? 'carries the group inside the service name, the way v1 reads it'
        : 'sends a bare service name beside its group, the way v2 onward reads it',
      async () => {
        const { requests } = await drive(driverCase, respondWith(200, driverCase.serviceDetailBody), (driver) =>
          driver.getService(SERVICE_REF)
        );
        const query = queryOf(requests[0]?.url ?? '');
        expect(query.get('namespaceId')).toBe(NAMESPACE_ID);
        if (driverCase.serviceDetailSendsGroupedName) {
          expect(query.get('serviceName')).toBe(`${GROUP}@@${SERVICE}`);
          expect(query.has('groupName')).toBe(false);
          return;
        }
        expect(query.get('serviceName')).toBe(SERVICE);
        expect(query.get('groupName')).toBe(GROUP);
      }
    );

    /** §6.1 again: the naming module says `namespaceId` on every version, v1 included. */
    it('never names the namespace tenant on a naming endpoint', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.serviceDetailBody), (driver) =>
        driver.getService(SERVICE_REF)
      );
      expect(queryOf(requests[0]?.url ?? '').has('tenant')).toBe(false);
    });
  });

  describe(`${flavor} subscribers driver`, () => {
    it(`lists subscribers from ${driverCase.subscribersPath}`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, driverCase.subscribersBody), (driver) =>
        driver.listSubscribers(SERVICE_REF)
      );

      expect(valueOf(result)).toEqual([
        {
          namespaceId: NAMESPACE_ID,
          group: GROUP,
          serviceName: SERVICE,
          ip: '192.168.99.92',
          port: 0,
          agent: 'Nacos-Java-Client:v2.3.2',
          app: 'unknown',
          cluster: undefined
        }
      ]);
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, driverCase.subscribersPath));
    });

    it(
      driverCase.subscribersSendGroupedName
        ? 'carries the group inside the service name, the way the v1 subscriber endpoint reads it'
        : 'sends a bare service name beside its group',
      async () => {
        const { requests } = await drive(driverCase, respondWith(200, driverCase.subscribersBody), (driver) =>
          driver.listSubscribers(SERVICE_REF)
        );
        const query = queryOf(requests[0]?.url ?? '');
        expect(query.get('namespaceId')).toBe(NAMESPACE_ID);
        expect(query.get('serviceName')).toBe(driverCase.subscribersSendGroupedName ? `${GROUP}@@${SERVICE}` : SERVICE);
      }
    );

    /**
     * Only the 3.x listings page. v1's takes a `pageSize` that defaults to
     * 1000 in its own source, so sending this project's ceiling of 100 there
     * would *lower* what a real server already answers with.
     */
    it(
      driverCase.subscribersArePaged
        ? 'asks its paged subscriber listing for a page'
        : 'sends no paging, leaving the v1 endpoint its own generous default',
      async () => {
        const { requests } = await drive(driverCase, respondWith(200, driverCase.subscribersBody), (driver) =>
          driver.listSubscribers(SERVICE_REF)
        );
        const query = queryOf(requests[0]?.url ?? '');
        expect(query.get('pageNo')).toBe(driverCase.subscribersArePaged ? '1' : null);
        expect(query.get('pageSize')).toBe(driverCase.subscribersArePaged ? '100' : null);
      }
    );

    it('sends aggregation on 3.x subscriber requests and omits it on v1/v2', async () => {
      const { requests } = await drive(
        driverCase,
        respondWith(200, driverCase.subscribersBody),
        (driver) => driver.listSubscribers(SERVICE_REF)
      );
      const query = queryOf(requests[0]?.url ?? '');
      if (flavor === 'v3-admin' || flavor === 'v3-console') {
        expect(query.get('aggregation')).toBe('true');
      } else {
        expect(query.has('aggregation')).toBe(false);
      }
    });

    it('lets the caller disable subscriber aggregation on 3.x', async () => {
      const { requests } = await drive(
        driverCase,
        respondWith(200, driverCase.subscribersBody),
        (driver) => driver.listSubscribers({ ...SERVICE_REF, aggregation: false })
      );
      const query = queryOf(requests[0]?.url ?? '');
      if (flavor === 'v3-admin' || flavor === 'v3-console') {
        expect(query.get('aggregation')).toBe('false');
      }
    });

    /**
     * A service nobody watches, which on a real 2.3.2 is also how a service
     * that does not exist answers. Neither is a failure -- the opposite of
     * how a missing *config* is reported (§14.2 ⓪), and the same rule the
     * instance listing already follows (§14.5 ⑤).
     */
    it('reads no subscribers as an empty list rather than as a failure', async () => {
      const empty = driverCase.subscribersArePaged
        ? enveloped('{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}')
        : EMPTY_SUBSCRIBERS;
      const { result } = await drive(driverCase, respondWith(200, empty), (driver) =>
        driver.listSubscribers(SERVICE_REF)
      );
      expect(valueOf(result)).toEqual([]);
    });

    it('raises invalid-response naming the endpoint when neither shape is there', async () => {
      const { result } = await drive(driverCase, respondWith(200, driverCase.wrap('{"count":0}')), (driver) =>
        driver.listSubscribers(SERVICE_REF)
      );
      const error = errorOf(result);
      expect(error.kind).toBe('invalid-response');
      expect(error.message).toContain(driverCase.subscribersPath);
    });
  });
}

/**
 * Every capability the console driver has must carry the override, or the
 * request lands on the server's origin where `/v3/console/...` does not exist
 * -- and the 404 reads as "this version has no console API" rather than as a
 * driver that forgot.
 */
describe('the console driver keeps M4 on the console origin', () => {
  const consoleCase = DRIVER_CASES.find((candidate) => candidate.flavor === 'v3-console') as HistoryDriverCase;

  const capabilities: { name: string; body: string; run: (driver: NacosDriver) => Promise<unknown>; path: string }[] = [
    {
      name: 'the history listing',
      body: consoleCase.historyListBody,
      run: (driver) => driver.listConfigHistory({ ...CONFIG_REF, pageNo: 1, pageSize: 100 }),
      path: '/v3/console/cs/history/list'
    },
    {
      name: 'one history version',
      body: consoleCase.historyDetailBody,
      run: (driver) => driver.getConfigHistory({ ...CONFIG_REF, nid: NID }),
      path: '/v3/console/cs/history'
    },
    {
      name: 'the listeners',
      body: enveloped(LISTENER_STATUS),
      run: (driver) => driver.listConfigListeners(CONFIG_REF),
      path: '/v3/console/cs/config/listener'
    },
    {
      name: 'the service detail',
      body: consoleCase.serviceDetailBody,
      run: (driver) => driver.getService(SERVICE_REF),
      path: '/v3/console/ns/service'
    },
    {
      name: 'the subscribers',
      body: consoleCase.subscribersBody,
      run: (driver) => driver.listSubscribers(SERVICE_REF),
      path: '/v3/console/ns/service/subscribers'
    }
  ];

  for (const capability of capabilities) {
    it(`for ${capability.name}`, async () => {
      const { requests } = await drive(consoleCase, respondWith(200, capability.body), capability.run);
      expect(pathOf(requests[0]?.url ?? '')).toBe(capability.path);
    });
  }
});
