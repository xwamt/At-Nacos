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
const SERVICE = 'order-service';

const NACOS_JSON_CONTENT_TYPE = 'application/json;charset=UTF-8';

const bare = (json: string): string => json;
const enveloped = (json: string): string => `{"code":0,"message":"success","data":${json}}`;

/**
 * `GET /v1/ns/catalog/services`, the only 1.x/2.x listing that carries counts.
 * `triggerFlag` really is a string there -- CatalogServiceV2Impl writes
 * `"true"` / `"false"` -- while 3.x models the same field as a boolean.
 */
const CATALOG_PAGE = String.raw`{"count":5,"serviceList":[{"name":"order-service","groupName":"cl-intimfy","clusterCount":1,"ipCount":3,"healthyInstanceCount":2,"triggerFlag":"false"},{"name":"pay-service","groupName":"cl-intimfy","clusterCount":2,"ipCount":1,"healthyInstanceCount":0,"triggerFlag":"true"}]}`;

/** 1.x's `service/list`: the field is `doms` and there is nothing in it but names. */
const V1_NAME_PAGE = String.raw`{"count":5,"doms":["order-service","pay-service"]}`;

/** v2 renamed `doms` to `services` and wrapped it, and still sends nothing but names. */
const V2_NAME_PAGE = enveloped(String.raw`{"count":5,"services":["order-service","pay-service"]}`);

/** 3.x merged the catalog semantics into the standard listing and pages it properly. */
const V3_SERVICE_PAGE = enveloped(
  String.raw`{"totalCount":5,"pageNumber":1,"pagesAvailable":3,"pageItems":[{"name":"order-service","groupName":"cl-intimfy","clusterCount":1,"ipCount":3,"healthyInstanceCount":2,"triggerFlag":false},{"name":"pay-service","groupName":"cl-intimfy","clusterCount":2,"ipCount":1,"healthyInstanceCount":0,"triggerFlag":true}]}`
);

/**
 * One host, as every version serializes an `Instance`. Its `serviceName`
 * carries the group separator, which is why nothing downstream may read a
 * service name out of an instance without splitting it.
 */
const HOST = String.raw`{"instanceId":"10.0.0.7#8080#DEFAULT#cl-intimfy@@order-service","ip":"10.0.0.7","port":8080,"weight":2.0,"healthy":true,"enabled":true,"ephemeral":true,"clusterName":"DEFAULT","serviceName":"cl-intimfy@@order-service","metadata":{"version":"1.2.0"},"instanceHeartBeatInterval":5000,"instanceHeartBeatTimeOut":15000,"ipDeleteTimeout":30000}`;

/** v1/v2 hand the hosts back inside a ServiceInfo; the outer `name` is the grouped one. */
const SERVICE_INFO = String.raw`{"name":"cl-intimfy@@order-service","groupName":"cl-intimfy","clusters":"","cacheMillis":10000,"hosts":[${HOST}],"lastRefTime":1786643277763,"checksum":"","allIPs":false,"reachProtectionThreshold":false,"valid":true}`;

/** 3.x's console pages the same instances instead. */
const INSTANCE_PAGE = String.raw`{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[${HOST}]}`;

/**
 * `GET /v1/core/cluster/nodes` on the real 2.3.2, verbatim. v2's
 * `/v2/core/cluster/node/list` answers with the same `data` byte for byte and
 * only changes the success code from 200 to 0.
 */
const CLUSTER_NODES = String.raw`[{"ip":"172.25.0.2","port":8848,"state":"UP","extendInfo":{"lastRefreshTime":1754895077932,"raftMetaData":{"metaDataMap":{"naming_instance_metadata":{"leader":"172.25.0.2:7848","raftGroupMember":["172.25.0.2:7848"],"term":1}}},"raftPort":"7848","readyToUpgrade":true,"version":"2.3.2"},"address":"172.25.0.2:8848","failAccessCnt":0,"abilities":{"remoteAbility":{"supportRemoteConnection":true,"grpcReportEnabled":true}},"grpcReportEnabled":true}]`;

/** 1.x's RestResult success code is 200, not 0. */
const V1_CLUSTER_NODES = `{"code":200,"message":null,"data":${CLUSTER_NODES}}`;

/** `?onlyStatus=false`, which is the only way to get anything past `status`. */
const METRICS = String.raw`{"status":"UP","serviceCount":13,"instanceCount":13,"subscribeCount":38,"responsibleInstanceCount":13,"clientCount":13,"connectionBasedClientCount":13,"ephemeralIpPortClientCount":0,"persistentIpPortClientCount":0,"responsibleClientCount":13,"cpu":0.09375,"load":5.72,"mem":1.0}`;

/** Spring Boot's own 404 page: the body that means "this version has no such endpoint". */
const SPRING_ERROR_PAGE =
  '{"timestamp":"2026-08-14T00:34:34.539+08:00","status":404,"error":"Not Found","message":"No message available","path":"/nacos/v1/ns/catalog/services"}';

/**
 * How the naming module reports a path it has no controller for -- **HTTP
 * 501, not 404**. Only `/v1/ns/**` answers this way (verified on a real
 * 2.3.2); every other prefix on the same server gives a Spring 404.
 */
const NO_SUCH_API =
  '{"timestamp":"2026-08-14T01:47:35.291+08:00","status":501,"error":"Not Implemented","message":"no such api:GET:/nacos/v1/ns/catalog/services","path":"/nacos/v1/ns/catalog/services"}';

interface NamingDriverCase {
  flavor: NacosApiFlavor;
  /** Where a service listing goes first. On v1/v2 that is the catalog, which is not their own version's path. */
  servicePath: string;
  /** Where it goes when the catalog declines. v3 has no second endpoint to try. */
  serviceFallbackPath?: string;
  /** What the fallback endpoint answers, in that flavor's shape. */
  serviceFallbackBody?: string;
  /** Whether the primary listing carries instance counts. Only the name-only fallbacks do not. */
  servicePrimaryBody: string;
  /** The catalog and 3.x say `groupNameParam`; the name-only listings say `groupName`. */
  serviceGroupParam: 'groupNameParam' | 'groupName';
  instancePath: string;
  instanceBody: string;
  /** v1 encodes the group into the service name; everything after it sends the two apart. */
  sendsGroupedServiceName: boolean;
  clusterParam: 'clusters' | 'clusterName';
  clusterNodesPath: string;
  clusterNodesBody: string;
  /** 3.x's console API has no naming metrics endpoint at all. */
  metricsPath?: string;
  metricsBody?: string;
  onConsoleOrigin: boolean;
  make(http: NacosHttpClient, consoleBaseUrl: string): NacosDriver;
}

const DRIVER_CASES: NamingDriverCase[] = [
  {
    flavor: 'v1',
    servicePath: '/v1/ns/catalog/services',
    serviceFallbackPath: '/v1/ns/service/list',
    serviceFallbackBody: V1_NAME_PAGE,
    servicePrimaryBody: CATALOG_PAGE,
    serviceGroupParam: 'groupNameParam',
    instancePath: '/v1/ns/instance/list',
    instanceBody: SERVICE_INFO,
    sendsGroupedServiceName: true,
    clusterParam: 'clusters',
    clusterNodesPath: '/v1/core/cluster/nodes',
    clusterNodesBody: V1_CLUSTER_NODES,
    metricsPath: '/v1/ns/operator/metrics',
    metricsBody: METRICS,
    onConsoleOrigin: false,
    make: (http) => new V1Driver(http)
  },
  {
    flavor: 'v2',
    servicePath: '/v1/ns/catalog/services',
    serviceFallbackPath: '/v2/ns/service/list',
    serviceFallbackBody: V2_NAME_PAGE,
    servicePrimaryBody: CATALOG_PAGE,
    serviceGroupParam: 'groupNameParam',
    instancePath: '/v2/ns/instance/list',
    instanceBody: enveloped(SERVICE_INFO),
    sendsGroupedServiceName: false,
    clusterParam: 'clusterName',
    clusterNodesPath: '/v2/core/cluster/node/list',
    clusterNodesBody: enveloped(CLUSTER_NODES),
    metricsPath: '/v2/ns/operator/metrics',
    metricsBody: enveloped(METRICS),
    onConsoleOrigin: false,
    make: (http) => new V2Driver(http)
  },
  {
    flavor: 'v3-admin',
    servicePath: '/v3/admin/ns/service/list',
    servicePrimaryBody: V3_SERVICE_PAGE,
    serviceGroupParam: 'groupNameParam',
    instancePath: '/v3/admin/ns/instance/list',
    instanceBody: enveloped(`[${HOST}]`),
    sendsGroupedServiceName: false,
    clusterParam: 'clusterName',
    clusterNodesPath: '/v3/admin/core/cluster/node/list',
    clusterNodesBody: enveloped(CLUSTER_NODES),
    metricsPath: '/v3/admin/ns/ops/metrics',
    metricsBody: enveloped(METRICS),
    onConsoleOrigin: false,
    make: (http) => new V3AdminDriver(http)
  },
  {
    flavor: 'v3-console',
    servicePath: '/v3/console/ns/service/list',
    servicePrimaryBody: V3_SERVICE_PAGE,
    serviceGroupParam: 'groupNameParam',
    instancePath: '/v3/console/ns/instance/list',
    instanceBody: enveloped(INSTANCE_PAGE),
    sendsGroupedServiceName: false,
    clusterParam: 'clusterName',
    clusterNodesPath: '/v3/console/core/cluster/nodes',
    clusterNodesBody: enveloped(CLUSTER_NODES),
    onConsoleOrigin: true,
    make: (http, consoleBaseUrl) => new V3ConsoleDriver(http, consoleBaseUrl)
  }
];

function expectedPath(driverCase: NamingDriverCase, path: string): string {
  return driverCase.onConsoleOrigin ? path : `${CONTEXT_PATH}${path}`;
}

function respondWith(status: number, body: string, contentType = NACOS_JSON_CONTENT_TYPE): TestRequestHandler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': contentType });
    response.end(body);
  };
}

/** For the two-endpoint capability: the catalog and its fallback need different answers. */
function respondByPath(answers: { path: string; status?: number; body: string }[]): TestRequestHandler {
  return (request, response, body) => {
    const path = pathOf(request.url ?? '');
    const answer = answers.find((candidate) => path.endsWith(candidate.path));
    if (!answer) {
      response.writeHead(404, { 'content-type': NACOS_JSON_CONTENT_TYPE });
      response.end(`{"unexpected":${JSON.stringify(path)},"body":${JSON.stringify(body)}}`);
      return;
    }
    response.writeHead(answer.status ?? 200, { 'content-type': NACOS_JSON_CONTENT_TYPE });
    response.end(answer.body);
  };
}

/**
 * Runs a driver against a real HTTP server rather than a recording stub.
 *
 * The risk this file exists to cover is a parameter that never reaches the
 * wire under the name the server reads, and a stub that records
 * `options.query` asserts on the driver's intent rather than on what URL
 * composition made of it. The naming module is where that bites hardest: a
 * misspelled `clusters`/`clusterName` or `groupName`/`groupNameParam` is
 * dropped in silence and the answer looks like an empty registry.
 */
async function drive<T>(
  driverCase: NamingDriverCase,
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

for (const driverCase of DRIVER_CASES) {
  const { flavor, servicePath, instancePath, clusterNodesPath, serviceGroupParam, clusterParam } = driverCase;
  const otherClusterParam = clusterParam === 'clusters' ? 'clusterName' : 'clusters';

  describe(`${flavor} naming driver`, () => {
    it(`lists services from ${servicePath}`, async () => {
      const { requests, result } = await drive(
        driverCase,
        respondWith(200, driverCase.servicePrimaryBody),
        (driver) => driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      valueOf(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe('GET');
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, servicePath));
    });

    /**
     * §6.1: the naming module says `namespaceId` on every version including
     * v1, where the *config* module says `tenant`. Sending the config
     * spelling here is silent -- Spring drops it and the server answers for
     * the default namespace, which reads as an empty namespace.
     */
    it('names the namespace namespaceId on the service listing, and never tenant', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.servicePrimaryBody), (driver) =>
        driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get('namespaceId')).toBe(NAMESPACE_ID);
      expect(query.has('tenant')).toBe(false);
    });

    it(`asks the service listing for the group under ${serviceGroupParam}`, async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.servicePrimaryBody), (driver) =>
        driver.listServices({ namespaceId: NAMESPACE_ID, group: GROUP, pageNo: 1, pageSize: 100 })
      );
      expect(queryOf(requests[0]?.url ?? '').get(serviceGroupParam)).toBe(GROUP);
    });

    /**
     * The tree derives its group nodes from the services it loaded, so the
     * unfiltered listing has to reach across every group. On the catalog and
     * on 3.x a blank group filter means exactly that.
     */
    it('asks for every group with a blank filter when the caller named no group', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.servicePrimaryBody), (driver) =>
        driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      expect(queryOf(requests[0]?.url ?? '').get(serviceGroupParam)).toBe('');
    });

    it('passes the paging through as the caller asked for it', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.servicePrimaryBody), (driver) =>
        driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 2, pageSize: 50 })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get('pageNo')).toBe('2');
      expect(query.get('pageSize')).toBe('50');
    });

    /** `withInstances=true` would answer with every instance of every service in the page. */
    it('asks the listing not to expand instances', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.servicePrimaryBody), (driver) =>
        driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      expect(queryOf(requests[0]?.url ?? '').get('withInstances')).toBe('false');
    });

    /**
     * A service with no instances is still a service, and hiding it would
     * make a registry look emptier than it is. Both spellings of the flag
     * default to false, but the default is exactly what a form-bound
     * parameter cannot be relied on for.
     */
    it('asks the listing to keep services that have no instances', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.servicePrimaryBody), (driver) =>
        driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get('hasIpCount') ?? query.get('ignoreEmptyService')).toBe('false');
    });

    it('normalizes the service listing, counts and all', async () => {
      const { result } = await drive(driverCase, respondWith(200, driverCase.servicePrimaryBody), (driver) =>
        driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 2 })
      );
      expect(valueOf(result)).toEqual({
        totalCount: 5,
        pageNumber: 1,
        pagesAvailable: 3,
        items: [
          {
            namespaceId: NAMESPACE_ID,
            group: GROUP,
            serviceName: 'order-service',
            instanceCount: 3,
            healthyInstanceCount: 2,
            clusterCount: 1,
            triggerFlag: false
          },
          {
            namespaceId: NAMESPACE_ID,
            group: GROUP,
            serviceName: 'pay-service',
            instanceCount: 1,
            healthyInstanceCount: 0,
            clusterCount: 2,
            triggerFlag: true
          }
        ]
      });
    });

    it(`lists instances from ${instancePath}`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, driverCase.instanceBody), (driver) =>
        driver.listInstances({ namespaceId: NAMESPACE_ID, group: GROUP, serviceName: SERVICE })
      );
      expect(valueOf(result)).toEqual([
        {
          ip: '10.0.0.7',
          port: 8080,
          healthy: true,
          enabled: true,
          weight: 2,
          clusterName: 'DEFAULT',
          ephemeral: true,
          instanceId: '10.0.0.7#8080#DEFAULT#cl-intimfy@@order-service',
          metadata: { version: '1.2.0' }
        }
      ]);
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, instancePath));
      expect(queryOf(requests[0]?.url ?? '').get('namespaceId')).toBe(NAMESPACE_ID);
    });

    /**
     * v1's instance endpoint has no group parameter at all: the group travels
     * inside `serviceName` as `GROUP@@name`, which is the one spelling every
     * version reads. v2 onward takes the two apart again -- and sending a
     * grouped name *there* would have the server compose
     * `cl-intimfy@@cl-intimfy@@order-service`.
     */
    it(
      driverCase.sendsGroupedServiceName
        ? 'carries the group inside the service name, the way v1 reads it'
        : 'sends a bare service name beside its group, the way v2 onward reads it',
      async () => {
        const { requests } = await drive(driverCase, respondWith(200, driverCase.instanceBody), (driver) =>
          driver.listInstances({ namespaceId: NAMESPACE_ID, group: GROUP, serviceName: SERVICE })
        );
        const query = queryOf(requests[0]?.url ?? '');
        if (driverCase.sendsGroupedServiceName) {
          expect(query.get('serviceName')).toBe(`${GROUP}@@${SERVICE}`);
          expect(query.has('groupName')).toBe(false);
          return;
        }
        expect(query.get('serviceName')).toBe(SERVICE);
        expect(query.get('groupName')).toBe(GROUP);
      }
    );

    it(`names the cluster filter ${clusterParam}, and never ${otherClusterParam}`, async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.instanceBody), (driver) =>
        driver.listInstances({ namespaceId: NAMESPACE_ID, group: GROUP, serviceName: SERVICE, cluster: 'HZ' })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get(clusterParam)).toBe('HZ');
      expect(query.has(otherClusterParam)).toBe(false);
    });

    it('sends no cluster filter at all when the caller named no cluster', async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.instanceBody), (driver) =>
        driver.listInstances({ namespaceId: NAMESPACE_ID, group: GROUP, serviceName: SERVICE })
      );
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.has('clusters')).toBe(false);
      expect(query.has('clusterName')).toBe(false);
    });

    /** A service nobody registered answers 200 with an empty host list, not a 404. */
    it('reads a service with no instances as an empty list rather than as a failure', async () => {
      const empty = driverCase.instanceBody.replace(`[${HOST}]`, '[]');
      const { result } = await drive(driverCase, respondWith(200, empty), (driver) =>
        driver.listInstances({ namespaceId: NAMESPACE_ID, group: GROUP, serviceName: SERVICE })
      );
      expect(valueOf(result)).toEqual([]);
    });

    it(`lists cluster nodes from ${clusterNodesPath}`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, driverCase.clusterNodesBody), (driver) =>
        driver.listClusterNodes()
      );
      expect(valueOf(result)).toEqual([
        {
          address: '172.25.0.2:8848',
          ip: '172.25.0.2',
          port: 8848,
          state: 'UP',
          version: '2.3.2',
          raftPort: '7848',
          failAccessCnt: 0,
          raftGroups: [
            { group: 'naming_instance_metadata', leader: '172.25.0.2:7848', members: ['172.25.0.2:7848'], term: 1 }
          ]
        }
      ]);
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, clusterNodesPath));
    });

    it('raises invalid-response naming the endpoint when the node list is not a list', async () => {
      const { result } = await drive(driverCase, respondWith(200, enveloped('{"count":0}')), (driver) =>
        driver.listClusterNodes()
      );
      const error = errorOf(result);
      expect(error.kind).toBe('invalid-response');
      expect(error.message).toContain(clusterNodesPath);
    });
  });
}

/**
 * Three of the four flavors have a metrics endpoint, and every one of them
 * needs the same parameter to say anything at all.
 */
describe('getServerMetrics', () => {
  for (const driverCase of DRIVER_CASES.filter((candidate) => candidate.metricsPath !== undefined)) {
    const metricsPath = driverCase.metricsPath ?? '';

    it(`${driverCase.flavor} reads the metrics from ${metricsPath}`, async () => {
      const { requests, result } = await drive(
        driverCase,
        respondWith(200, driverCase.metricsBody ?? ''),
        (driver) => driver.getServerMetrics()
      );
      expect(valueOf(result)).toEqual({
        status: 'UP',
        serviceCount: 13,
        instanceCount: 13,
        subscribeCount: 38,
        clientCount: 13,
        cpu: 0.09375,
        load: 5.72,
        mem: 1
      });
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, metricsPath));
    });

    /**
     * The parameter this whole capability turns on. `onlyStatus` defaults to
     * **true** -- `WebUtils.optional(request, "onlyStatus", "true")` on
     * v1/v2, `@RequestParam(defaultValue = "true")` on v3 -- so without it a
     * real 2.3.2 answers `{"status":"UP"}` and the panel has nothing to show.
     */
    it(`${driverCase.flavor} sends onlyStatus=false, without which the server reports only its status`, async () => {
      const { requests } = await drive(driverCase, respondWith(200, driverCase.metricsBody ?? ''), (driver) =>
        driver.getServerMetrics()
      );
      expect(queryOf(requests[0]?.url ?? '').get('onlyStatus')).toBe('false');
    });
  }

  /**
   * Nacos 3.x's console module has controllers for services, instances and
   * cluster nodes, and none for naming metrics -- so there is no address to
   * send this to. Answering with a fall-through refusal is what lets the
   * resolver move on to a driver that has one, and costs no round trip to
   * find out.
   */
  it('v3-console refuses, because the 3.x console API has no metrics endpoint', async () => {
    const consoleCase = DRIVER_CASES.find((candidate) => candidate.flavor === 'v3-console');
    const { requests, result } = await drive(
      consoleCase as NamingDriverCase,
      respondWith(200, enveloped(METRICS)),
      (driver) => driver.getServerMetrics()
    );
    const error = errorOf(result);
    expect(error.shouldFallThrough()).toBe(true);
    expect(error.message).toMatch(/console/i);
    expect(requests).toHaveLength(0);
  });
});

/**
 * The catalog is the only 1.x/2.x endpoint that reports instance and healthy
 * counts, and the tree colors its service nodes by those. When it is not
 * there, names alone still beat nothing.
 *
 * This degradation lives inside the driver rather than in
 * `NacosCapabilityResolver`: both endpoints belong to the same server, so
 * routing it through the resolver would cache a *flavor* decision made for a
 * reason that has nothing to do with the version -- and evict the winner that
 * every other capability had already found.
 */
describe('the catalog fallback', () => {
  const FALLBACK_CASES = DRIVER_CASES.filter((candidate) => candidate.serviceFallbackPath !== undefined);

  for (const driverCase of FALLBACK_CASES) {
    const fallbackPath = driverCase.serviceFallbackPath ?? '';

    it(`${driverCase.flavor} asks only the catalog while the catalog answers`, async () => {
      const { requests } = await drive(driverCase, respondWith(200, CATALOG_PAGE), (driver) =>
        driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      expect(requests.map((request) => pathOf(request.url))).toEqual([
        expectedPath(driverCase, driverCase.servicePath)
      ]);
    });

    /**
     * 501 rather than 404, because the catalog lives under `/v1/ns/**` and
     * that is the one prefix where Nacos answers a missing path with its own
     * "no such api" instead of Spring's error page. Older 1.x releases served
     * the catalog at `/v1/ns/catalog/serviceList`, so this is the shape the
     * fallback actually exists for.
     */
    it(`${driverCase.flavor} falls back to ${fallbackPath} when the catalog answers 501 no-such-api`, async () => {
      const { requests, result } = await drive(
        driverCase,
        respondByPath([
          { path: driverCase.servicePath, status: 501, body: NO_SUCH_API },
          { path: fallbackPath, body: driverCase.serviceFallbackBody ?? '' }
        ]),
        (driver) => driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      expect(valueOf(result).items.map((item) => item.serviceName)).toEqual(['order-service', 'pay-service']);
      expect(requests.map((request) => pathOf(request.url))).toEqual([
        expectedPath(driverCase, driverCase.servicePath),
        expectedPath(driverCase, fallbackPath)
      ]);
    });

    it(`${driverCase.flavor} falls back when the catalog is missing outright`, async () => {
      const { result } = await drive(
        driverCase,
        respondByPath([
          { path: driverCase.servicePath, status: 404, body: SPRING_ERROR_PAGE },
          { path: fallbackPath, body: driverCase.serviceFallbackBody ?? '' }
        ]),
        (driver) => driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      expect(valueOf(result).items).toHaveLength(2);
    });

    /**
     * The counts are what the catalog was for. On the fallback they are
     * genuinely unknown, and undefined is how the tree is told to render an
     * unknown rather than an empty one.
     */
    it(`${driverCase.flavor} leaves every count undefined on the fallback path`, async () => {
      const { result } = await drive(
        driverCase,
        respondByPath([
          { path: driverCase.servicePath, status: 501, body: NO_SUCH_API },
          { path: fallbackPath, body: driverCase.serviceFallbackBody ?? '' }
        ]),
        (driver) => driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      expect(valueOf(result).items[0]).toEqual({
        namespaceId: NAMESPACE_ID,
        group: 'DEFAULT_GROUP',
        serviceName: 'order-service',
        instanceCount: undefined,
        healthyInstanceCount: undefined,
        clusterCount: undefined,
        triggerFlag: undefined
      });
    });

    /**
     * `service/list` matches its group exactly -- `Objects.equals` in
     * ServiceOperatorV2Impl, with no wildcard -- and defaults to
     * `DEFAULT_GROUP` when the parameter is blank or absent. So the fallback
     * cannot answer "every group" at all, and the least surprising thing it
     * can do is ask for the group the server would have assumed and say so in
     * the request.
     */
    it(`${driverCase.flavor} asks the fallback for DEFAULT_GROUP explicitly when no group was named`, async () => {
      const { requests } = await drive(
        driverCase,
        respondByPath([
          { path: driverCase.servicePath, status: 501, body: NO_SUCH_API },
          { path: fallbackPath, body: driverCase.serviceFallbackBody ?? '' }
        ]),
        (driver) => driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      const query = queryOf(requests[1]?.url ?? '');
      expect(query.get('groupName')).toBe('DEFAULT_GROUP');
      expect(query.has('groupNameParam')).toBe(false);
    });

    it(`${driverCase.flavor} asks the fallback for the group the caller named`, async () => {
      const { requests } = await drive(
        driverCase,
        respondByPath([
          { path: driverCase.servicePath, status: 501, body: NO_SUCH_API },
          { path: fallbackPath, body: driverCase.serviceFallbackBody ?? '' }
        ]),
        (driver) => driver.listServices({ namespaceId: NAMESPACE_ID, group: GROUP, pageNo: 1, pageSize: 100 })
      );
      expect(queryOf(requests[1]?.url ?? '').get('groupName')).toBe(GROUP);
    });

    /**
     * The fallback's failure is the one that surfaces, because it is the one
     * that decides whether the *chain* falls through: a Spring 404 from the
     * standard listing means this API family has no service listing at all,
     * and the resolver has to be told that rather than told about a catalog
     * that was only ever the preferred route.
     */
    it(`${driverCase.flavor} reports the fallback's own failure when both endpoints decline`, async () => {
      const { result } = await drive(
        driverCase,
        respondByPath([
          { path: driverCase.servicePath, status: 500, body: '{"code":500,"message":"boom"}' },
          { path: fallbackPath, status: 404, body: SPRING_ERROR_PAGE }
        ]),
        (driver) => driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
      );
      const error = errorOf(result);
      expect(error.kind).toBe('not-found');
      expect(error.shouldFallThrough()).toBe(true);
    });
  }

  /** 3.x merged the catalog into its standard listing, so there is no second endpoint to try. */
  it('does not exist on 3.x, where a refusal is the answer', async () => {
    const adminCase = DRIVER_CASES.find((candidate) => candidate.flavor === 'v3-admin') as NamingDriverCase;
    const { requests, result } = await drive(adminCase, respondWith(404, SPRING_ERROR_PAGE), (driver) =>
      driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
    );
    expect(errorOf(result).kind).toBe('not-found');
    expect(requests).toHaveLength(1);
  });
});

/**
 * Every capability the console driver has must carry the override, or the
 * request lands on the server's origin where `/v3/console/...` does not
 * exist -- and the 404 reads as "this version has no console API" rather than
 * as a driver that forgot.
 */
describe('the console driver stays on the console origin', () => {
  const consoleCase = DRIVER_CASES.find((candidate) => candidate.flavor === 'v3-console') as NamingDriverCase;

  it('for the service listing', async () => {
    const { requests } = await drive(consoleCase, respondWith(200, V3_SERVICE_PAGE), (driver) =>
      driver.listServices({ namespaceId: NAMESPACE_ID, pageNo: 1, pageSize: 100 })
    );
    expect(pathOf(requests[0]?.url ?? '')).toBe('/v3/console/ns/service/list');
  });

  it('for the instance listing', async () => {
    const { requests } = await drive(consoleCase, respondWith(200, consoleCase.instanceBody), (driver) =>
      driver.listInstances({ namespaceId: NAMESPACE_ID, group: GROUP, serviceName: SERVICE })
    );
    expect(pathOf(requests[0]?.url ?? '')).toBe('/v3/console/ns/instance/list');
  });

  it('for the cluster node listing', async () => {
    const { requests } = await drive(consoleCase, respondWith(200, consoleCase.clusterNodesBody), (driver) =>
      driver.listClusterNodes()
    );
    expect(pathOf(requests[0]?.url ?? '')).toBe('/v3/console/core/cluster/nodes');
  });

  /**
   * The console's instance listing is the only one of the four that pages,
   * so it is the only one that has to say which page it wants. Left out, the
   * form binds a null page number.
   */
  it('and asks its paged instance listing for a page', async () => {
    const { requests } = await drive(consoleCase, respondWith(200, consoleCase.instanceBody), (driver) =>
      driver.listInstances({ namespaceId: NAMESPACE_ID, group: GROUP, serviceName: SERVICE })
    );
    const query = queryOf(requests[0]?.url ?? '');
    expect(query.get('pageNo')).toBe('1');
    expect(query.get('pageSize')).toBe('100');
  });
});
