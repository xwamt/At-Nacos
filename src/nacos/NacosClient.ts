import type { NacosCapabilityResolver, NacosChainAdvice } from './NacosCapabilityResolver';
import type { NacosHttpClient } from './NacosHttpClient';
import type {
  NacosConfigListQuery,
  NacosDriver,
  NacosInstanceQuery,
  NacosServiceListQuery
} from './driver/NacosDriver';
import { V1Driver } from './driver/V1Driver';
import { V2Driver } from './driver/V2Driver';
import { V3AdminDriver } from './driver/V3AdminDriver';
import { V3ConsoleDriver } from './driver/V3ConsoleDriver';
import type {
  NacosClusterNode,
  NacosConfigDetail,
  NacosConfigRef,
  NacosConfigSummary,
  NacosInstance,
  NacosNamespace,
  NacosServerMetrics,
  NacosServiceSummary,
  Paged
} from './driver/normalize';
import type { NacosServerState } from './probe/probeServerState';

/**
 * Both request surfaces, because `getConfig` has to read a 404's body to tell
 * a missing config from a missing endpoint and only `requestRaw` hands it
 * one. `withAuth` already produces exactly this pair.
 */
type NacosRequests = Pick<NacosHttpClient, 'requestJson' | 'requestRaw'>;

/**
 * The order the resolver walks for a server of this major version.
 *
 * Order is the only thing this function decides, and it decides it from the
 * probe rather than per call: a driver that cannot exist on this server is
 * left out entirely, because every driver in the chain is a round trip the
 * resolver has to spend before it can rule the driver out.
 */
export function buildDriverChain(
  majorVersion: number,
  http: NacosRequests,
  consoleBaseUrl: string | undefined
): NacosDriver[] {
  const v3Admin = new V3AdminDriver(http);
  const v3Console = consoleBaseUrl ? new V3ConsoleDriver(http, consoleBaseUrl) : undefined;
  const v2 = new V2Driver(http);
  const v1 = new V1Driver(http);

  // v3 does not exist before 3.x, so on 1.x and 2.x a v3 head would buy one
  // guaranteed 404 per capability and nothing else. v2 leads on 2.x with v1
  // behind it because several modules (configuration listing among them)
  // never got a v2 endpoint at all.
  if (majorVersion === 1) {
    return [v1];
  }
  if (majorVersion === 2) {
    return [v2, v1];
  }

  // 3.x, and anything unrecognized. `probeServerState` refuses a version it
  // cannot parse, so an unparsable major means a caller skipped the probe --
  // and walking the whole chain finds whatever is there, where guessing the
  // oldest version would leave a modern server permanently unusable.
  //
  // Admin leads: it shares the server's origin and context path, it is the
  // one API present when `nacos.console.ui.enabled=false`, and 403 (a
  // non-admin account, which is the normal case) drops to console.
  //
  // The v2/v1 tail is only reached once both 3.x APIs have declined, i.e. on
  // a request that would otherwise fail outright, and it is what rescues the
  // two deployments where they do: 3.0/3.1 with the compatibility switch on
  // and no reachable console, and 3.2+ carrying nacos-api-legacy-adapter.
  return [v3Admin, ...(v3Console ? [v3Console] : []), v2, v1];
}

/**
 * What to tell a user whose whole chain declined, given the same two facts
 * `buildDriverChain` decided from.
 *
 * It lives beside the builder rather than in the resolver because it is about
 * the driver the builder left out. The resolver can only report what it tried;
 * "the one that would have worked was never built, and here is how to build
 * it" is knowledge of construction, and putting it there would mean teaching
 * the resolver which flavors exist and when each is omitted.
 *
 * Narrow on purpose. A 403 from the admin API is the documented signal for an
 * ordinary (non-administrator) account -- §4.3 -- and the console API is the
 * documented answer to it; any other refusal has some other cause, and a
 * console address would not fix it.
 */
export function buildChainAdvice(majorVersion: number, consoleBaseUrl: string | undefined): NacosChainAdvice {
  if (!hasConsoleDriverSlot(majorVersion) || consoleBaseUrl) {
    return () => undefined;
  }
  return (refusals) =>
    refusals.some((refusal) => refusal.flavor === 'v3-admin' && refusal.kind === 'forbidden')
      ? 'The v3 admin API answered HTTP 403, which on Nacos 3.x usually means the account is not an administrator. Its console API needs only a valid identity, but this instance has no console address for it: fill in the instance\'s console URL (Nacos 3.x serves its console on port 8080 by default) so that fallback exists, or connect with an administrator account.'
      : undefined;
}

/**
 * Whether a chain for this major version would have carried a console driver
 * had a console address been known -- i.e. whether `buildDriverChain` takes
 * its 3.x branch. Spelled as the negation of the two older versions, exactly
 * as that branch is reached, so an unrecognized major is treated the same way
 * in both places.
 */
function hasConsoleDriverSlot(majorVersion: number): boolean {
  return majorVersion !== 1 && majorVersion !== 2;
}

/**
 * The single entry point above the driver layer. Deliberately thin: it owns
 * no cache, no retry and no convenience methods, so that "which API served
 * this" stays a question with exactly one answer, in the resolver.
 */
export class NacosClient {
  constructor(
    private readonly resolver: NacosCapabilityResolver,
    readonly state: NacosServerState
  ) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return this.resolver.run('namespaces', (driver) => driver.listNamespaces());
  }

  listConfigs(query: NacosConfigListQuery): Promise<Paged<NacosConfigSummary>> {
    return this.resolver.run('configs', (driver) => driver.listConfigs(query));
  }

  getConfig(ref: NacosConfigRef): Promise<NacosConfigDetail> {
    return this.resolver.run('config-detail', (driver) => driver.getConfig(ref));
  }

  listServices(query: NacosServiceListQuery): Promise<Paged<NacosServiceSummary>> {
    return this.resolver.run('services', (driver) => driver.listServices(query));
  }

  listInstances(query: NacosInstanceQuery): Promise<NacosInstance[]> {
    return this.resolver.run('instances', (driver) => driver.listInstances(query));
  }

  /**
   * The cluster and the metrics are two capabilities rather than one because
   * a server can serve one and not the other: 3.x's console API has the node
   * list and no metrics endpoint at all, so sharing a cache entry would let
   * the one it cannot serve evict the driver the other had settled on.
   */
  listClusterNodes(): Promise<NacosClusterNode[]> {
    return this.resolver.run('cluster-nodes', (driver) => driver.listClusterNodes());
  }

  getServerMetrics(): Promise<NacosServerMetrics> {
    return this.resolver.run('server-metrics', (driver) => driver.getServerMetrics());
  }
}
