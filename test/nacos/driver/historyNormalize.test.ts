import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import {
  normalizeConfigDetail,
  normalizeConfigHistoryEntry,
  normalizeConfigListeners,
  normalizeServiceDetail,
  normalizeSubscriberList,
  type NacosConfigRef,
  type NacosServiceRef
} from '../../../src/nacos/driver/normalize';

const SERVICE_REF: NacosServiceRef = { namespaceId: 'uat', group: 'cl-intimfy', serviceName: 'order-service' };
const CONFIG_REF: NacosConfigRef = { namespaceId: 'uat', group: 'cl-intimfy', dataId: 'application-uat.yml' };

/**
 * One history row as 1.x/2.x are documented to serialize `ConfigHistoryInfo`:
 * ISO timestamps under `createdTime`/`lastModifiedTime`, and an `opType` with
 * the trailing space its `char` column pads it to.
 *
 * **Unverified against a real server** -- the 2.3.2 this project has access to
 * holds no history rows at all, so only the envelope around this shape has
 * been measured (§14.8). The field names come from the source of
 * `ConfigHistoryInfo`.
 */
const V1_HISTORY_ROW = {
  id: 203,
  lastId: -1,
  dataId: 'application-uat.yml',
  group: 'cl-intimfy',
  tenant: 'uat',
  appName: '',
  md5: null,
  content: null,
  srcIp: '192.168.66.66',
  srcUser: 'nacos',
  opType: 'U ',
  createdTime: '2026-08-01T10:20:30.000+08:00',
  lastModifiedTime: '2026-08-12T18:45:00.000+08:00'
};

/**
 * A row as 3.x sends it: renamed fields, millisecond numbers and the 3.x
 * spellings of the ref. The timestamps are the same two instants as the row
 * above, in the other encoding.
 */
const V3_HISTORY_ROW = {
  id: 203,
  dataId: 'application-uat.yml',
  groupName: 'cl-intimfy',
  namespaceId: 'uat',
  appName: 'gateway',
  srcIp: '192.168.66.66',
  srcUser: 'nacos',
  opType: 'D ',
  publishType: 'formal',
  createTime: Date.parse('2026-08-01T10:20:30.000+08:00'),
  modifyTime: Date.parse('2026-08-12T18:45:00.000+08:00')
};

describe('normalizeConfigHistoryEntry', () => {
  it('reads a 1.x/2.x row, ISO timestamps and all', () => {
    expect(normalizeConfigHistoryEntry(V1_HISTORY_ROW, CONFIG_REF)).toEqual({
      namespaceId: 'uat',
      group: 'cl-intimfy',
      dataId: 'application-uat.yml',
      id: '203',
      opType: 'U',
      modifiedAt: Date.parse('2026-08-12T18:45:00.000+08:00'),
      srcIp: '192.168.66.66',
      srcUser: 'nacos',
      appName: undefined
    });
  });

  it('reads a 3.x row, whose fields are renamed and whose timestamps are numbers', () => {
    expect(normalizeConfigHistoryEntry(V3_HISTORY_ROW, CONFIG_REF)).toEqual({
      namespaceId: 'uat',
      group: 'cl-intimfy',
      dataId: 'application-uat.yml',
      id: '203',
      opType: 'D',
      modifiedAt: Date.parse('2026-08-12T18:45:00.000+08:00'),
      srcIp: '192.168.66.66',
      srcUser: 'nacos',
      appName: 'gateway'
    });
  });

  /**
   * The trailing space is a database `char` column padding the value, and it
   * is there on every version. Anything downstream comparing `opType === 'D'`
   * would be wrong on every row without this.
   */
  it('trims the trailing space Nacos pads opType with', () => {
    for (const [sent, expected] of [
      ['I ', 'I'],
      ['U ', 'U'],
      ['D ', 'D']
    ]) {
      expect(normalizeConfigHistoryEntry({ ...V1_HISTORY_ROW, opType: sent }, CONFIG_REF).opType).toBe(expected);
    }
  });

  /** An older or patched server that stores the value untrimmed must not lose it to a second trim. */
  it('leaves an opType that arrived already trimmed alone', () => {
    expect(normalizeConfigHistoryEntry({ ...V1_HISTORY_ROW, opType: 'I' }, CONFIG_REF).opType).toBe('I');
  });

  /**
   * A row whose operation the server did not name is still a version worth
   * diffing, so it degrades to the empty string rather than failing the whole
   * page.
   */
  it('reads a missing opType as unstated rather than failing the row', () => {
    expect(normalizeConfigHistoryEntry({ ...V1_HISTORY_ROW, opType: undefined }, CONFIG_REF).opType).toBe('');
  });

  it('carries a timezone offset through to the same instant', () => {
    const entry = normalizeConfigHistoryEntry(
      { ...V1_HISTORY_ROW, lastModifiedTime: '2026-08-12T18:45:00.000+08:00' },
      CONFIG_REF
    );
    expect(entry.modifiedAt).toBe(Date.parse('2026-08-12T10:45:00.000Z'));
  });

  /**
   * `NaN` is a number, so it survives every `typeof` check downstream and
   * surfaces as "Invalid Date" in whatever finally formats it -- a value that
   * looks like a timestamp and is not. Undefined is the only answer that a
   * caller can act on.
   */
  it('leaves an unparseable timestamp undefined rather than NaN', () => {
    const entry = normalizeConfigHistoryEntry({ ...V1_HISTORY_ROW, lastModifiedTime: 'not a date at all' }, CONFIG_REF);
    expect(entry.modifiedAt).toBeUndefined();
    expect(Number.isNaN(entry.modifiedAt)).toBe(false);
  });

  it('leaves a timestamp the server did not send undefined', () => {
    expect(normalizeConfigHistoryEntry({ ...V1_HISTORY_ROW, lastModifiedTime: undefined }, CONFIG_REF).modifiedAt).toBeUndefined();
  });

  /**
   * The id is a database `bigint`, so it arrives as a JSON number -- and it
   * goes back as the `nid` query parameter, which is a string. Converting it
   * here is what keeps every caller from having to.
   */
  it('reads a numeric id as the string the nid parameter needs', () => {
    expect(normalizeConfigHistoryEntry({ ...V1_HISTORY_ROW, id: 203 }, CONFIG_REF).id).toBe('203');
  });

  it('accepts an id that already arrived as a string', () => {
    expect(normalizeConfigHistoryEntry({ ...V1_HISTORY_ROW, id: '203' }, CONFIG_REF).id).toBe('203');
  });

  /**
   * Without an id there is no way to fetch the version, which is the one
   * action a history row exists to offer. Failing names what happened; a row
   * that renders and does nothing when clicked does not.
   */
  it('rejects a row with no id, which could never be fetched', () => {
    const error = catchError(() => normalizeConfigHistoryEntry({ ...V1_HISTORY_ROW, id: undefined }, CONFIG_REF));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('invalid-response');
  });

  /**
   * Every row of a history listing belongs to the one configuration that was
   * asked about, so the question can supply what a row leaves out -- and it
   * has to, because something later builds a document address out of this and
   * an empty group would point it at the wrong config. The row's field names
   * are the part of this milestone no real server could confirm, which is
   * exactly why the fallback is not decoration.
   */
  it('falls back to the configuration asked about when a row omits its namespace or group', () => {
    const entry = normalizeConfigHistoryEntry(
      { id: 203, dataId: 'application-uat.yml', opType: 'U ' },
      { namespaceId: 'uat', group: 'cl-intimfy', dataId: 'application-uat.yml' }
    );
    expect(entry.namespaceId).toBe('uat');
    expect(entry.group).toBe('cl-intimfy');
  });

  /** The public namespace really is the empty string, so a row that says so is believed. */
  it('keeps an empty namespace the row really sent rather than replacing it', () => {
    const entry = normalizeConfigHistoryEntry({ ...V1_HISTORY_ROW, tenant: '' }, CONFIG_REF);
    expect(entry.namespaceId).toBe('');
  });

  it('rejects a row with no dataId', () => {
    expect(() => normalizeConfigHistoryEntry({ ...V1_HISTORY_ROW, dataId: undefined }, CONFIG_REF)).toThrow(
      NacosApiError
    );
  });

  it('rejects a row that is not an object at all', () => {
    expect(() => normalizeConfigHistoryEntry('203', CONFIG_REF)).toThrow(NacosApiError);
  });
});

/**
 * The history *detail* is a `NacosConfigDetail`, the same type `getConfig`
 * answers with, so that the document layer renders both sides of a diff
 * through one path. That only works if the timestamps survive the crossing,
 * and the history payload spells them the older way.
 */
describe('normalizeConfigDetail, on a history payload', () => {
  const HISTORY_DETAIL = {
    id: 203,
    dataId: 'application-uat.yml',
    group: 'cl-intimfy',
    tenant: 'uat',
    appName: '',
    md5: 'e1a9de8c8df94a487159b655a3c8f703',
    content: 'spring:\n  profiles: uat',
    srcIp: '192.168.66.66',
    srcUser: 'nacos',
    opType: 'U ',
    createdTime: '2026-08-01T10:20:30.000+08:00',
    lastModifiedTime: '2026-08-12T18:45:00.000+08:00'
  };

  it('reads the history spelling of the timestamps as the same milliseconds', () => {
    expect(normalizeConfigDetail(HISTORY_DETAIL)).toMatchObject({
      namespaceId: 'uat',
      group: 'cl-intimfy',
      dataId: 'application-uat.yml',
      content: 'spring:\n  profiles: uat',
      md5: 'e1a9de8c8df94a487159b655a3c8f703',
      createTime: Date.parse('2026-08-01T10:20:30.000+08:00'),
      modifyTime: Date.parse('2026-08-12T18:45:00.000+08:00')
    });
  });

  /** The 3.x spelling still wins, and still arrives as a number. */
  it('keeps reading the current-config spelling, unchanged', () => {
    expect(normalizeConfigDetail({ ...HISTORY_DETAIL, createTime: 1, modifyTime: 2 })).toMatchObject({
      createTime: 1,
      modifyTime: 2
    });
  });

  it('leaves an unparseable history timestamp undefined rather than NaN', () => {
    const detail = normalizeConfigDetail({ ...HISTORY_DETAIL, lastModifiedTime: 'whenever' });
    expect(detail.modifyTime).toBeUndefined();
  });

  /**
   * A history entry has no `type` of its own, so the language mode falls back
   * to the dataId suffix -- the same fallback a filtered listing already
   * relies on (§14.2 ①).
   */
  it('leaves type undefined, which is what the suffix fallback is for', () => {
    expect(normalizeConfigDetail(HISTORY_DETAIL).type).toBeUndefined();
  });
});

/**
 * `lisentersGroupkeyStatus` is misspelled in Nacos itself and the misspelling
 * is confirmed on a real 2.3.2 -- reading the correct spelling would find
 * nothing on every server in existence.
 */
describe('normalizeConfigListeners', () => {
  it('reads the misspelled status map as ip and md5 pairs', () => {
    expect(
      normalizeConfigListeners(
        {
          collectStatus: 200,
          lisentersGroupkeyStatus: { '192.168.99.92': 'e1a9de8c8df94a487159b655a3c8f703' }
        },
        '/v1/cs/configs/listener'
      )
    ).toEqual([{ ip: '192.168.99.92', md5: 'e1a9de8c8df94a487159b655a3c8f703' }]);
  });

  it('keeps several listeners in the order the server sent them', () => {
    expect(
      normalizeConfigListeners(
        {
          collectStatus: 200,
          lisentersGroupkeyStatus: {
            '192.168.99.92': 'aaa',
            '192.168.66.124': 'bbb',
            '10.0.0.7': 'aaa'
          }
        },
        '/v1/cs/configs/listener'
      )
    ).toEqual([
      { ip: '192.168.99.92', md5: 'aaa' },
      { ip: '192.168.66.124', md5: 'bbb' },
      { ip: '10.0.0.7', md5: 'aaa' }
    ]);
  });

  /**
   * The measured answer on a real 2.3.2 for a config nobody is watching --
   * and for a dataId nobody published, which answers identically. Neither is
   * a failure, and reporting one would put an error in front of a user whose
   * server is fine.
   */
  it('reads an empty status map as nobody listening rather than as a failure', () => {
    expect(normalizeConfigListeners({ collectStatus: 200, lisentersGroupkeyStatus: {} }, '/v1/cs/listener')).toEqual([]);
  });

  it('reads the enveloped 3.x form the same way', () => {
    expect(
      normalizeConfigListeners(
        { code: 0, message: 'success', data: { collectStatus: 200, lisentersGroupkeyStatus: { '10.0.0.7': 'md5' } } },
        '/v3/admin/cs/config/listener'
      )
    ).toEqual([{ ip: '10.0.0.7', md5: 'md5' }]);
  });

  /** If a future Nacos ever fixes its own typo, the listeners must not vanish. */
  it('accepts the corrected spelling too', () => {
    expect(
      normalizeConfigListeners({ collectStatus: 200, listenersGroupkeyStatus: { '10.0.0.7': 'md5' } }, '/v1/cs/listener')
    ).toEqual([{ ip: '10.0.0.7', md5: 'md5' }]);
  });

  it('raises invalid-response naming the endpoint when neither spelling is there', () => {
    const error = catchError(() => normalizeConfigListeners({ collectStatus: 200 }, '/v1/cs/configs/listener'));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('invalid-response');
    expect((error as NacosApiError).message).toContain('/v1/cs/configs/listener');
  });

  it('drops a status entry whose md5 is not a string rather than rendering an object as one', () => {
    expect(
      normalizeConfigListeners(
        { lisentersGroupkeyStatus: { '10.0.0.7': { md5: 'x' }, '10.0.0.8': 'y' } },
        '/v1/cs/configs/listener'
      )
    ).toEqual([{ ip: '10.0.0.8', md5: 'y' }]);
  });
});

/**
 * The subscriber response measured on a real 2.3.2, verbatim. The top level is
 * `{subscribers, count}` and **not** the `pageItems` the 3.x research
 * describes; `port` really is 0, because a gRPC subscriber has no callback
 * port; `cluster` really is empty.
 */
const LIVE_SUBSCRIBER_BODY = {
  subscribers: [
    {
      addrStr: '192.168.99.92',
      agent: 'Nacos-Java-Client:v2.3.2',
      app: 'unknown',
      ip: '192.168.99.92',
      port: 0,
      namespaceId: 'cl-parent-offline',
      serviceName: 'cl-intimfy@@cl-auth-offline',
      cluster: ''
    }
  ],
  count: 1
};

describe('normalizeSubscriberList', () => {
  const LIVE_REF: NacosServiceRef = {
    namespaceId: 'cl-parent-offline',
    group: 'cl-intimfy',
    serviceName: 'cl-auth-offline'
  };

  it('reads the {subscribers, count} shape a real 2.3.2 answers with', () => {
    expect(normalizeSubscriberList(LIVE_SUBSCRIBER_BODY, '/v1/ns/service/subscribers', LIVE_REF)).toEqual([
      {
        namespaceId: 'cl-parent-offline',
        group: 'cl-intimfy',
        serviceName: 'cl-auth-offline',
        ip: '192.168.99.92',
        port: 0,
        agent: 'Nacos-Java-Client:v2.3.2',
        app: 'unknown',
        cluster: undefined
      }
    ]);
  });

  /** 3.x pages the same rows instead, inside the usual envelope. */
  it('reads the enveloped pageItems shape 3.x is documented to answer with', () => {
    expect(
      normalizeSubscriberList(
        {
          code: 0,
          message: 'success',
          data: {
            totalCount: 1,
            pageNumber: 1,
            pagesAvailable: 1,
            pageItems: [
              {
                ip: '10.0.0.7',
                port: 8080,
                agent: 'Nacos-Java-Client:v3.1.0',
                app: 'gateway',
                cluster: 'HZ',
                namespaceId: 'uat',
                serviceName: 'cl-intimfy@@order-service'
              }
            ]
          }
        },
        '/v3/admin/ns/service/subscribers',
        SERVICE_REF
      )
    ).toEqual([
      {
        namespaceId: 'uat',
        group: 'cl-intimfy',
        serviceName: 'order-service',
        ip: '10.0.0.7',
        port: 8080,
        agent: 'Nacos-Java-Client:v3.1.0',
        app: 'gateway',
        cluster: 'HZ'
      }
    ]);
  });

  /**
   * The separator is Nacos's, not the service's: every response that carries
   * a group and a name in one string uses it, and a view that showed
   * `cl-intimfy@@cl-auth-offline` as the service name would be showing a
   * protocol detail.
   */
  it('strips the group prefix out of the subscriber\'s serviceName', () => {
    const [subscriber] = normalizeSubscriberList(LIVE_SUBSCRIBER_BODY, '/v1/ns/service/subscribers', LIVE_REF);
    expect(subscriber?.serviceName).toBe('cl-auth-offline');
    expect(subscriber?.group).toBe('cl-intimfy');
  });

  /** Split at the **first** separator, so a name that contains one is not renamed. */
  it('splits at the first separator rather than keeping the second field', () => {
    const [subscriber] = normalizeSubscriberList(
      { subscribers: [{ ip: '10.0.0.7', port: 0, serviceName: 'g@@a@@b' }], count: 1 },
      '/v1/ns/service/subscribers',
      SERVICE_REF
    );
    expect(subscriber?.group).toBe('g');
    expect(subscriber?.serviceName).toBe('a@@b');
  });

  /** No separator means no group in the string, so the service that was asked about supplies it. */
  it('falls back to the service asked about when the name carries no separator', () => {
    const [subscriber] = normalizeSubscriberList(
      { subscribers: [{ ip: '10.0.0.7', port: 0, serviceName: 'order-service' }], count: 1 },
      '/v1/ns/service/subscribers',
      SERVICE_REF
    );
    expect(subscriber?.group).toBe('cl-intimfy');
    expect(subscriber?.serviceName).toBe('order-service');
  });

  it('falls back to the service asked about when the entry names none at all', () => {
    const [subscriber] = normalizeSubscriberList(
      { subscribers: [{ ip: '10.0.0.7', port: 0 }], count: 1 },
      '/v1/ns/service/subscribers',
      SERVICE_REF
    );
    expect(subscriber).toMatchObject({ namespaceId: 'uat', group: 'cl-intimfy', serviceName: 'order-service' });
  });

  /**
   * A service nobody watches, which is how a real 2.3.2 answers for a service
   * that does not exist either. Both are `{"subscribers":[],"count":0}` under
   * HTTP 200, and neither is a failure.
   */
  it('reads no subscribers as an empty list rather than as a failure', () => {
    expect(normalizeSubscriberList({ subscribers: [], count: 0 }, '/v1/ns/service/subscribers', SERVICE_REF)).toEqual(
      []
    );
  });

  it('reads an empty page the same way', () => {
    expect(
      normalizeSubscriberList(
        { code: 0, data: { totalCount: 0, pageItems: [] } },
        '/v3/admin/ns/service/subscribers',
        SERVICE_REF
      )
    ).toEqual([]);
  });

  /** Port 0 is what a gRPC subscriber reports, so it cannot be read as "missing". */
  it('keeps a port of zero, which is what a gRPC subscriber has', () => {
    const [subscriber] = normalizeSubscriberList(LIVE_SUBSCRIBER_BODY, '/v1/ns/service/subscribers', LIVE_REF);
    expect(subscriber?.port).toBe(0);
  });

  it('defaults a port the server did not report to zero', () => {
    const [subscriber] = normalizeSubscriberList(
      { subscribers: [{ ip: '10.0.0.7' }], count: 1 },
      '/v1/ns/service/subscribers',
      SERVICE_REF
    );
    expect(subscriber?.port).toBe(0);
  });

  it('raises invalid-response naming the endpoint when neither shape is there', () => {
    const error = catchError(() =>
      normalizeSubscriberList({ count: 0 }, '/v1/ns/service/subscribers', SERVICE_REF)
    );
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('invalid-response');
    expect((error as NacosApiError).message).toContain('/v1/ns/service/subscribers');
  });

  it('rejects a subscriber with no address', () => {
    expect(() =>
      normalizeSubscriberList({ subscribers: [{ port: 0 }] }, '/v1/ns/service/subscribers', SERVICE_REF)
    ).toThrow(NacosApiError);
  });
});

/**
 * §6.7, both halves measured on a real 2.3.2: 1.x answers with a `clusters`
 * **array** and calls the service `name`, while 2.x/3.x answer with a
 * `clusterMap` **object** and call it `serviceName` -- and 2.x alone spells
 * the namespace `namespace`.
 */
describe('normalizeServiceDetail', () => {
  /** `GET /v1/ns/service` on the real 2.3.2, verbatim. */
  const V1_DETAIL = {
    namespaceId: 'cl-parent-offline',
    groupName: 'cl-intimfy',
    name: 'cl-auth-offline',
    protectThreshold: 0.0,
    metadata: {},
    selector: { type: 'none', contextType: 'NONE' },
    clusters: [{ name: 'DEFAULT', healthChecker: { type: 'TCP' }, metadata: {} }]
  };

  /** `GET /v2/ns/service` on the same server, verbatim, envelope included. */
  const V2_DETAIL = {
    code: 0,
    message: 'success',
    data: {
      namespace: 'cl-parent-offline',
      serviceName: 'cl-auth-offline',
      groupName: 'cl-intimfy',
      clusterMap: {
        DEFAULT: { clusterName: 'DEFAULT', healthChecker: { type: 'TCP' }, metadata: {}, hosts: null }
      },
      metadata: {},
      protectThreshold: 0.0,
      selector: { type: 'none', contextType: 'NONE' },
      ephemeral: true
    }
  };

  const LIVE_REF: NacosServiceRef = {
    namespaceId: 'cl-parent-offline',
    group: 'cl-intimfy',
    serviceName: 'cl-auth-offline'
  };

  it('reads the 1.x shape, whose clusters are an array and whose name field is `name`', () => {
    expect(normalizeServiceDetail(V1_DETAIL, LIVE_REF)).toEqual({
      namespaceId: 'cl-parent-offline',
      group: 'cl-intimfy',
      serviceName: 'cl-auth-offline',
      protectThreshold: 0,
      metadata: {},
      ephemeral: undefined,
      clusters: [{ name: 'DEFAULT', healthCheckerType: 'TCP', metadata: {} }]
    });
  });

  it('reads the 2.x shape, whose clusters are a map and whose namespace field is `namespace`', () => {
    expect(normalizeServiceDetail(V2_DETAIL, LIVE_REF)).toEqual({
      namespaceId: 'cl-parent-offline',
      group: 'cl-intimfy',
      serviceName: 'cl-auth-offline',
      protectThreshold: 0,
      metadata: {},
      ephemeral: true,
      clusters: [{ name: 'DEFAULT', healthCheckerType: 'TCP', metadata: {} }]
    });
  });

  /** The map's key is the cluster's name, so it survives a value that omits it. */
  it('takes the cluster name from the map key, which is where 2.x/3.x put it', () => {
    const detail = normalizeServiceDetail(
      { clusterMap: { HZ: { healthChecker: { type: 'HTTP' }, metadata: { path: '/health' } } } },
      LIVE_REF
    );
    expect(detail.clusters).toEqual([{ name: 'HZ', healthCheckerType: 'HTTP', metadata: { path: '/health' } }]);
  });

  /** A service registered with no cluster of its own is a real state, not a broken response. */
  it('reads an empty clusterMap as no clusters rather than as a failure', () => {
    expect(normalizeServiceDetail({ ...V2_DETAIL.data, clusterMap: {} }, LIVE_REF).clusters).toEqual([]);
  });

  it('reads an empty clusters array the same way', () => {
    expect(normalizeServiceDetail({ ...V1_DETAIL, clusters: [] }, LIVE_REF).clusters).toEqual([]);
  });

  it('reads a response with no clusters field at all as no clusters', () => {
    expect(normalizeServiceDetail({ name: 'cl-auth-offline' }, LIVE_REF).clusters).toEqual([]);
  });

  it('keeps a protect threshold the service really set', () => {
    expect(normalizeServiceDetail({ ...V1_DETAIL, protectThreshold: 0.8 }, LIVE_REF).protectThreshold).toBe(0.8);
  });

  it('carries the service metadata through', () => {
    expect(normalizeServiceDetail({ ...V1_DETAIL, metadata: { owner: 'payments' } }, LIVE_REF).metadata).toEqual({
      owner: 'payments'
    });
  });

  /** The grouped spelling reaches this endpoint too, and it must not become the service's name. */
  it('splits a grouped service name at the first separator', () => {
    const detail = normalizeServiceDetail({ ...V1_DETAIL, name: 'cl-intimfy@@cl-auth-offline' }, LIVE_REF);
    expect(detail.group).toBe('cl-intimfy');
    expect(detail.serviceName).toBe('cl-auth-offline');
  });

  it('falls back to the service asked about when the response names none', () => {
    expect(normalizeServiceDetail({ clusters: [] }, LIVE_REF)).toMatchObject({
      namespaceId: 'cl-parent-offline',
      group: 'cl-intimfy',
      serviceName: 'cl-auth-offline'
    });
  });

  it('raises invalid-response when the payload is not an object', () => {
    const error = catchError(() => normalizeServiceDetail({ code: 0, data: null }, LIVE_REF));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('invalid-response');
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
