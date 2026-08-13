import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import {
  clusterParamName,
  groupedServiceName,
  normalizeClusterNode,
  normalizeInstance,
  normalizeInstanceList,
  normalizeServerMetrics,
  normalizeServiceSummary,
  splitGroupedServiceName
} from '../../../src/nacos/driver/normalize';

/** Where a service listing was asked for, which is all a 1.x name-only entry can be placed by. */
const ASKED = { namespaceId: 'uat', group: 'DEFAULT_GROUP' };

describe('splitGroupedServiceName', () => {
  it('takes the group from a GROUP@@name and leaves the fallback unused', () => {
    expect(splitGroupedServiceName('cl-intimfy@@order-service', 'DEFAULT_GROUP')).toEqual({
      group: 'cl-intimfy',
      serviceName: 'order-service'
    });
  });

  it('uses the fallback group for a bare name, which is what 1.x sends', () => {
    expect(splitGroupedServiceName('order-service', 'DEFAULT_GROUP')).toEqual({
      group: 'DEFAULT_GROUP',
      serviceName: 'order-service'
    });
  });

  /**
   * Nacos's own `NamingUtils.getServiceName` splits on every `@@` and keeps
   * only the second field, which would silently rename `b@@c` to `b`. The
   * separator is the *first* one and the rest of the string is the name --
   * a display client that shortens a name is worse than one that shows an
   * odd one.
   */
  it('splits at the first separator only, keeping the rest of the name intact', () => {
    expect(splitGroupedServiceName('g@@b@@c', 'DEFAULT_GROUP')).toEqual({ group: 'g', serviceName: 'b@@c' });
  });

  /** `@@svc` has an empty group, which is not a group; the fallback is the better answer. */
  it('falls back when the separator leads with nothing', () => {
    expect(splitGroupedServiceName('@@order-service', 'DEFAULT_GROUP')).toEqual({
      group: 'DEFAULT_GROUP',
      serviceName: 'order-service'
    });
  });
});

describe('groupedServiceName', () => {
  /** The one spelling every version reads back: v1's instance endpoint has no group parameter at all. */
  it('joins a group and a service the way Nacos parses them apart', () => {
    expect(groupedServiceName({ namespaceId: 'uat', group: 'cl-intimfy', serviceName: 'order-service' })).toBe(
      'cl-intimfy@@order-service'
    );
  });

  /** A leading separator would put the service in a group named '', which is not a group. */
  it('sends the bare name when there is no group to join it to', () => {
    expect(groupedServiceName({ namespaceId: 'uat', group: '', serviceName: 'order-service' })).toBe('order-service');
  });

  /** Round-trips with the split, which is what makes a name read out of one response safe to send back. */
  it('round-trips through splitGroupedServiceName', () => {
    const ref = { namespaceId: 'uat', group: 'cl-intimfy', serviceName: 'order-service' };
    expect(splitGroupedServiceName(groupedServiceName(ref), 'DEFAULT_GROUP')).toEqual({
      group: ref.group,
      serviceName: ref.serviceName
    });
  });
});

describe('normalizeServiceSummary', () => {
  /**
   * `{"count":N,"doms":["name"]}` -- 1.x's whole answer. There is no instance
   * count to be had here, and inventing a zero would paint every service red
   * in a tree that colors by health.
   */
  it('accepts a bare string and leaves every count undefined', () => {
    expect(normalizeServiceSummary('order-service', ASKED)).toEqual({
      namespaceId: 'uat',
      group: 'DEFAULT_GROUP',
      serviceName: 'order-service',
      instanceCount: undefined,
      healthyInstanceCount: undefined,
      clusterCount: undefined,
      triggerFlag: undefined
    });
  });

  it('reads the group out of a grouped name rather than trusting the fallback', () => {
    expect(normalizeServiceSummary('cl-intimfy@@order-service', ASKED)).toMatchObject({
      group: 'cl-intimfy',
      serviceName: 'order-service'
    });
  });

  /** The catalog entry (`ServiceView`), which is the only 1.x/2.x shape carrying counts. */
  it('reads a catalog entry, counts included', () => {
    expect(
      normalizeServiceSummary(
        {
          name: 'order-service',
          groupName: 'cl-intimfy',
          clusterCount: 2,
          ipCount: 3,
          healthyInstanceCount: 2,
          triggerFlag: 'false'
        },
        ASKED
      )
    ).toEqual({
      namespaceId: 'uat',
      group: 'cl-intimfy',
      serviceName: 'order-service',
      instanceCount: 3,
      healthyInstanceCount: 2,
      clusterCount: 2,
      triggerFlag: false
    });
  });

  /**
   * 2.3.2's `ServiceView.triggerFlag` is a **string** `"true"`/`"false"`
   * (`serviceView.setTriggerFlag(... ? "true" : "false")` in
   * CatalogServiceV2Impl). 3.x models the same field as a boolean. Both have
   * to arrive as one.
   */
  it('reads triggerFlag whether the server spells it as a string or a boolean', () => {
    expect(normalizeServiceSummary({ name: 'a', triggerFlag: 'true' }, ASKED).triggerFlag).toBe(true);
    expect(normalizeServiceSummary({ name: 'a', triggerFlag: true }, ASKED).triggerFlag).toBe(true);
    expect(normalizeServiceSummary({ name: 'a', triggerFlag: false }, ASKED).triggerFlag).toBe(false);
  });

  it('leaves triggerFlag undefined when the entry has none, rather than reading it as false', () => {
    expect(normalizeServiceSummary({ name: 'a' }, ASKED).triggerFlag).toBeUndefined();
  });

  /** 3.x renamed the field on some of its own POJOs; whichever is present wins. */
  it('accepts serviceName as well as name', () => {
    expect(normalizeServiceSummary({ serviceName: 'order-service' }, ASKED).serviceName).toBe('order-service');
  });

  it('accepts instanceCount as well as ipCount', () => {
    expect(normalizeServiceSummary({ name: 'a', instanceCount: 7 }, ASKED).instanceCount).toBe(7);
  });

  it('falls back to the namespace and group asked for when the entry names neither', () => {
    expect(normalizeServiceSummary({ name: 'a' }, ASKED)).toMatchObject({
      namespaceId: 'uat',
      group: 'DEFAULT_GROUP'
    });
  });

  it('prefers the namespace the entry carries over the one asked for', () => {
    expect(normalizeServiceSummary({ name: 'a', namespaceId: 'prod' }, ASKED).namespaceId).toBe('prod');
  });

  /** Without a name there is nothing to render and nothing to fetch instances for. */
  it('rejects an entry with no service name at all', () => {
    expect(() => normalizeServiceSummary({ groupName: 'g' }, ASKED)).toThrow(NacosApiError);
    expect(() => normalizeServiceSummary(42, ASKED)).toThrow(/service/i);
  });
});

/** One `hosts[]` entry of a real 2.3.2 instance listing. */
const REAL_HOST = {
  instanceId: '10.0.0.7#8080#DEFAULT#cl-intimfy@@order-service',
  ip: '10.0.0.7',
  port: 8080,
  weight: 2,
  healthy: true,
  enabled: true,
  ephemeral: true,
  clusterName: 'DEFAULT',
  serviceName: 'cl-intimfy@@order-service',
  metadata: { version: '1.2.0' },
  instanceHeartBeatInterval: 5000,
  instanceHeartBeatTimeOut: 15000,
  ipDeleteTimeout: 30000
};

describe('normalizeInstance', () => {
  it('reads a real 2.3.2 host, dropping the heartbeat plumbing', () => {
    expect(normalizeInstance(REAL_HOST)).toEqual({
      ip: '10.0.0.7',
      port: 8080,
      healthy: true,
      enabled: true,
      weight: 2,
      clusterName: 'DEFAULT',
      ephemeral: true,
      instanceId: '10.0.0.7#8080#DEFAULT#cl-intimfy@@order-service',
      metadata: { version: '1.2.0' }
    });
  });

  it('carries an unhealthy instance through as unhealthy', () => {
    expect(normalizeInstance({ ...REAL_HOST, healthy: false }).healthy).toBe(false);
  });

  /** An instance registered without metadata answers `{}`, and the tooltip has to cope with it. */
  it('answers an empty metadata object with an empty object rather than undefined', () => {
    expect(normalizeInstance({ ...REAL_HOST, metadata: {} }).metadata).toEqual({});
  });

  it('invents an empty metadata object when the entry carries none', () => {
    const { metadata: _dropped, ...withoutMetadata } = REAL_HOST;
    expect(normalizeInstance(withoutMetadata).metadata).toEqual({});
  });

  /** Nacos's metadata is a Map<String,String>; anything else in it is not renderable as one. */
  it('keeps only the string-valued metadata entries', () => {
    expect(normalizeInstance({ ...REAL_HOST, metadata: { a: 'x', b: 3, c: null } }).metadata).toEqual({ a: 'x' });
  });

  /**
   * The fields Nacos's own `Instance` POJO initializes, so an entry that
   * omits one means what the POJO's initializer means rather than what a
   * zero value would.
   */
  it('falls back to the defaults of the Instance POJO for the fields it omits', () => {
    expect(normalizeInstance({ ip: '10.0.0.7', port: 8080 })).toEqual({
      ip: '10.0.0.7',
      port: 8080,
      healthy: true,
      enabled: true,
      weight: 1,
      clusterName: '',
      ephemeral: true,
      instanceId: undefined,
      metadata: {}
    });
  });

  it('rejects an entry with no address to connect to', () => {
    expect(() => normalizeInstance({ port: 8080 })).toThrow(NacosApiError);
    expect(() => normalizeInstance({ ip: '10.0.0.7' })).toThrow(/instance/i);
  });
});

describe('normalizeInstanceList', () => {
  /** v1's bare ServiceInfo. The `name` carries the group separator, which is not this function's business. */
  it('reads the v1 shape, where the hosts hang off a ServiceInfo', () => {
    const payload = { name: 'cl-intimfy@@order-service', groupName: 'cl-intimfy', hosts: [REAL_HOST] };
    expect(normalizeInstanceList(payload, '/v1/ns/instance/list')).toHaveLength(1);
  });

  it('reads the v2 shape, which is the same ServiceInfo inside an envelope', () => {
    const payload = { code: 0, message: 'success', data: { name: 'g@@s', hosts: [REAL_HOST] } };
    expect(normalizeInstanceList(payload, '/v2/ns/instance/list')[0]?.ip).toBe('10.0.0.7');
  });

  it('reads the v3 admin shape, where data is the array itself', () => {
    expect(normalizeInstanceList({ code: 0, data: [REAL_HOST] }, '/v3/admin/ns/instance/list')).toHaveLength(1);
  });

  it('reads the v3 console shape, which pages the same instances', () => {
    const payload = { code: 0, data: { totalCount: 1, pageNumber: 1, pagesAvailable: 1, pageItems: [REAL_HOST] } };
    expect(normalizeInstanceList(payload, '/v3/console/ns/instance/list')).toHaveLength(1);
  });

  /** A service nobody registered answers 200 with an empty hosts array, not a 404. */
  it('reads an empty host list as an empty list rather than as a failure', () => {
    expect(normalizeInstanceList({ name: 'g@@s', hosts: [] }, '/v1/ns/instance/list')).toEqual([]);
  });

  /**
   * A raw TypeError out of `.map()` carries no kind, so the resolver could
   * not judge whether to try the next driver and the chain would stop dead.
   */
  it('raises invalid-response naming the endpoint when it is none of the three shapes', () => {
    const error = (() => {
      try {
        normalizeInstanceList({ code: 0, data: { count: 0 } }, '/v2/ns/instance/list');
      } catch (thrown) {
        return thrown as NacosApiError;
      }
      throw new Error('expected a failure');
    })();
    expect(error.kind).toBe('invalid-response');
    expect(error.message).toContain('/v2/ns/instance/list');
  });
});

/** One node of `GET /v1/core/cluster/nodes`, captured verbatim from the real 2.3.2. */
const REAL_NODE = {
  ip: '172.25.0.2',
  port: 8848,
  state: 'UP',
  extendInfo: {
    lastRefreshTime: 1754895077932,
    raftMetaData: {
      metaDataMap: {
        naming_instance_metadata: { leader: '172.25.0.2:7848', raftGroupMember: ['172.25.0.2:7848'], term: 1 },
        naming_persistent_service_v2: { leader: '172.25.0.2:7848', raftGroupMember: ['172.25.0.2:7848'], term: 1 }
      }
    },
    raftPort: '7848',
    readyToUpgrade: true,
    version: '2.3.2'
  },
  address: '172.25.0.2:8848',
  failAccessCnt: 0,
  abilities: {
    remoteAbility: { supportRemoteConnection: true, grpcReportEnabled: true },
    configAbility: { supportRemoteMetrics: false },
    namingAbility: { supportJraft: true }
  },
  grpcReportEnabled: true
};

describe('normalizeClusterNode', () => {
  it('reads a real 2.3.2 node and flattens its raft metadata into a list', () => {
    expect(normalizeClusterNode(REAL_NODE)).toEqual({
      address: '172.25.0.2:8848',
      ip: '172.25.0.2',
      port: 8848,
      state: 'UP',
      version: '2.3.2',
      raftPort: '7848',
      failAccessCnt: 0,
      raftGroups: [
        { group: 'naming_instance_metadata', leader: '172.25.0.2:7848', members: ['172.25.0.2:7848'], term: 1 },
        { group: 'naming_persistent_service_v2', leader: '172.25.0.2:7848', members: ['172.25.0.2:7848'], term: 1 }
      ]
    });
  });

  /**
   * §8.4 reads cluster membership off `raftGroupMember`, so a group with more
   * than one member has to survive the flattening whole.
   */
  it('keeps every member of a multi-node raft group', () => {
    const members = ['10.0.0.1:7848', '10.0.0.2:7848', '10.0.0.3:7848'];
    const node = {
      ...REAL_NODE,
      extendInfo: {
        raftMetaData: { metaDataMap: { naming_service_metadata: { leader: members[1], raftGroupMember: members, term: 4 } } }
      }
    };
    expect(normalizeClusterNode(node).raftGroups).toEqual([
      { group: 'naming_service_metadata', leader: '10.0.0.2:7848', members, term: 4 }
    ]);
  });

  /**
   * `extendInfo` is where the version, the raft port and the raft groups all
   * live, and a standalone deployment that reports none of it is still a node
   * worth showing.
   */
  it('answers with no raft groups at all when the node carries no extendInfo', () => {
    const { extendInfo: _dropped, ...withoutExtendInfo } = REAL_NODE;
    expect(normalizeClusterNode(withoutExtendInfo)).toMatchObject({
      address: '172.25.0.2:8848',
      state: 'UP',
      version: undefined,
      raftPort: undefined,
      raftGroups: undefined
    });
  });

  it('answers with no raft groups when extendInfo carries no raft metadata', () => {
    expect(normalizeClusterNode({ ...REAL_NODE, extendInfo: { version: '2.3.2' } }).raftGroups).toBeUndefined();
  });

  /**
   * `STARTING`, `UP`, `SUSPICIOUS`, `DOWN` and `ISOLATION` -- the 3.x
   * documentation lists only three of them, the 2.x source has all five.
   */
  it.each(['STARTING', 'UP', 'SUSPICIOUS', 'DOWN', 'ISOLATION'])('carries the %s state through', (state) => {
    expect(normalizeClusterNode({ ...REAL_NODE, state }).state).toBe(state);
  });

  /**
   * A sixth state added by a version this plugin has never seen is still the
   * server's answer. Mapping it onto one of the five would report a health
   * that nobody claimed.
   */
  it('carries a state outside the five through untouched', () => {
    expect(normalizeClusterNode({ ...REAL_NODE, state: 'QUARANTINED' }).state).toBe('QUARANTINED');
  });

  it('reports an absent state as UNKNOWN rather than as an empty badge', () => {
    const { state: _dropped, ...withoutState } = REAL_NODE;
    expect(normalizeClusterNode(withoutState).state).toBe('UNKNOWN');
  });

  /** The address is the node's identity in the panel, and `ip:port` is what it is made of. */
  it('builds the address from the ip and port when the node omits it', () => {
    const { address: _dropped, ...withoutAddress } = REAL_NODE;
    expect(normalizeClusterNode(withoutAddress).address).toBe('172.25.0.2:8848');
  });

  it('rejects a node with no address of any kind', () => {
    expect(() => normalizeClusterNode({ state: 'UP' })).toThrow(NacosApiError);
  });
});

/** `GET /v1/ns/operator/metrics?onlyStatus=false` on the real 2.3.2, verbatim. */
const REAL_METRICS = {
  status: 'UP',
  serviceCount: 13,
  instanceCount: 13,
  subscribeCount: 38,
  responsibleInstanceCount: 13,
  clientCount: 13,
  connectionBasedClientCount: 13,
  ephemeralIpPortClientCount: 0,
  persistentIpPortClientCount: 0,
  responsibleClientCount: 13,
  cpu: 0.09375,
  load: 5.72,
  mem: 1.0
};

describe('normalizeServerMetrics', () => {
  it('reads the full 2.3.2 metrics payload', () => {
    expect(normalizeServerMetrics(REAL_METRICS)).toEqual({
      status: 'UP',
      serviceCount: 13,
      instanceCount: 13,
      subscribeCount: 38,
      clientCount: 13,
      cpu: 0.09375,
      load: 5.72,
      mem: 1
    });
  });

  it('reads the v2 envelope the same way', () => {
    expect(normalizeServerMetrics({ code: 0, message: 'success', data: REAL_METRICS }).serviceCount).toBe(13);
  });

  /**
   * What the server answers without `onlyStatus=false`. It is a valid
   * response, not a broken one -- the panel has to be able to say "status UP
   * and nothing else" rather than fail.
   */
  it('reads the status-only degradation without inventing zeroes for the rest', () => {
    expect(normalizeServerMetrics({ status: 'UP' })).toEqual({
      status: 'UP',
      serviceCount: undefined,
      instanceCount: undefined,
      subscribeCount: undefined,
      clientCount: undefined,
      cpu: undefined,
      load: undefined,
      mem: undefined
    });
  });

  /** A zero service count is a fact about the registry, and undefined is not the same fact. */
  it('keeps a zero count as zero', () => {
    expect(normalizeServerMetrics({ status: 'UP', serviceCount: 0 }).serviceCount).toBe(0);
  });

  it('rejects a payload with no status, which is the one field every metrics response has', () => {
    expect(() => normalizeServerMetrics({ serviceCount: 13 })).toThrow(NacosApiError);
  });
});

describe('clusterParamName', () => {
  /** Getting this wrong filters nothing and reports nothing: the server ignores the unknown parameter. */
  it('is the plural, comma-separated clusters on v1', () => {
    expect(clusterParamName('v1')).toBe('clusters');
  });

  it('is the singular clusterName from v2 onward', () => {
    expect(clusterParamName('v2')).toBe('clusterName');
    expect(clusterParamName('v3-admin')).toBe('clusterName');
    expect(clusterParamName('v3-console')).toBe('clusterName');
  });
});
