import type { NacosCapabilityResolver } from './NacosCapabilityResolver';
import type { NacosHttpClient } from './NacosHttpClient';
import type { NacosDriver } from './driver/NacosDriver';
import { V1Driver } from './driver/V1Driver';
import { V2Driver } from './driver/V2Driver';
import { V3AdminDriver } from './driver/V3AdminDriver';
import { V3ConsoleDriver } from './driver/V3ConsoleDriver';
import type { NacosNamespace } from './driver/normalize';
import type { NacosServerState } from './probe/probeServerState';

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
  http: Pick<NacosHttpClient, 'requestJson'>,
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
}
