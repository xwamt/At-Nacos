import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import {
  configTagsParamName,
  groupParamName,
  namespaceParamName,
  normalizeConfigDetail,
  normalizeConfigSummary,
  normalizeNamespace,
  normalizePaged,
  publicNamespaceId,
  unwrapData,
  unwrapDataArray
} from '../../../src/nacos/driver/normalize';

describe('publicNamespaceId', () => {
  it('is an empty string on 1.x and 2.x', () => {
    expect(publicNamespaceId(1)).toBe('');
    expect(publicNamespaceId(2)).toBe('');
  });

  it('is the literal "public" on 3.x', () => {
    expect(publicNamespaceId(3)).toBe('public');
  });

  /**
   * A version this plugin has never seen still gets the newest spelling: 3.x
   * is where the literal was introduced, and nothing suggests a later major
   * would go back to the empty string.
   */
  it('keeps the 3.x spelling for a later major version', () => {
    expect(publicNamespaceId(4)).toBe('public');
  });
});

describe('namespaceParamName', () => {
  it('uses tenant for the v1 config module', () => {
    expect(namespaceParamName('v1', 'config')).toBe('tenant');
  });

  it('uses namespaceId for the v1 naming module even though v1 config uses tenant', () => {
    expect(namespaceParamName('v1', 'naming')).toBe('namespaceId');
  });

  /** 1.x's own console endpoints (namespace create/delete) take namespaceId, never tenant. */
  it('uses namespaceId for the v1 console module', () => {
    expect(namespaceParamName('v1', 'console')).toBe('namespaceId');
  });

  it('uses namespaceId for v2 config, which a major-version argument could not distinguish', () => {
    // A 2.x server serves both the v1 config paths (tenant) and the v2 config
    // paths (namespaceId). Keying on the flavor is what tells them apart.
    expect(namespaceParamName('v2', 'config')).toBe('namespaceId');
    expect(namespaceParamName('v2', 'naming')).toBe('namespaceId');
  });

  it('uses namespaceId for both v3 flavors', () => {
    expect(namespaceParamName('v3-admin', 'config')).toBe('namespaceId');
    expect(namespaceParamName('v3-console', 'config')).toBe('namespaceId');
    expect(namespaceParamName('v3-admin', 'naming')).toBe('namespaceId');
    expect(namespaceParamName('v3-console', 'console')).toBe('namespaceId');
  });
});

describe('groupParamName', () => {
  /** The same split as `namespaceParamName`, and for the same reason: only v1 config is the odd one out. */
  it('uses group for the v1 config module', () => {
    expect(groupParamName('v1', 'config')).toBe('group');
  });

  it('uses groupName for the v1 naming module, which never said group', () => {
    expect(groupParamName('v1', 'naming')).toBe('groupName');
  });

  it('uses groupName from v2 onward', () => {
    expect(groupParamName('v2', 'config')).toBe('groupName');
    expect(groupParamName('v3-admin', 'config')).toBe('groupName');
    expect(groupParamName('v3-console', 'config')).toBe('groupName');
  });

  /**
   * The two spellings have to move together: a request that says `tenant` and
   * `groupName` is half in each dialect, and the half the server does not read
   * is silently ignored rather than refused.
   */
  it('agrees with namespaceParamName about which dialect an endpoint family speaks', () => {
    const flavors = ['v1', 'v2', 'v3-admin', 'v3-console'] as const;
    for (const flavor of flavors) {
      const legacy = namespaceParamName(flavor, 'config') === 'tenant';
      expect(groupParamName(flavor, 'config') === 'group').toBe(legacy);
    }
  });
});

describe('configTagsParamName', () => {
  it('uses the v1 underscore spelling on v1 config endpoints', () => {
    expect(configTagsParamName('v1')).toBe('config_tags');
  });

  it('uses camelCase from v2 onward, including both 3.x flavors', () => {
    expect(configTagsParamName('v2')).toBe('configTags');
    expect(configTagsParamName('v3-admin')).toBe('configTags');
    expect(configTagsParamName('v3-console')).toBe('configTags');
  });
});

describe('normalizeNamespace', () => {
  it('normalizes a 1.x/2.x entry with an empty namespace id', () => {
    expect(
      normalizeNamespace({
        namespace: '',
        namespaceShowName: 'public',
        namespaceDesc: null,
        quota: 200,
        configCount: 3,
        type: 0
      })
    ).toEqual({
      namespaceId: '',
      displayName: 'public',
      description: undefined,
      quota: 200,
      configCount: 3,
      type: 0
    });
  });

  it('normalizes a 3.x entry where the public namespace has a literal id', () => {
    expect(
      normalizeNamespace({
        namespace: 'public',
        namespaceShowName: 'public',
        namespaceDesc: 'Default Namespace',
        quota: 200,
        configCount: 0,
        type: 0
      }).namespaceId
    ).toBe('public');
  });

  it('rejects an entry with no namespace field', () => {
    expect(() => normalizeNamespace({ namespaceShowName: 'x' })).toThrow();
  });

  it('keeps a custom namespace whole', () => {
    expect(
      normalizeNamespace({
        namespace: 'a1b2c3d4-0000-1111-2222-333344445555',
        namespaceShowName: 'dev',
        namespaceDesc: 'development',
        quota: 200,
        configCount: 12,
        type: 2
      })
    ).toEqual({
      namespaceId: 'a1b2c3d4-0000-1111-2222-333344445555',
      displayName: 'dev',
      description: 'development',
      quota: 200,
      configCount: 12,
      type: 2
    });
  });

  it('drops quota and configCount that the server did not send rather than inventing zeros', () => {
    const namespace = normalizeNamespace({ namespace: 'dev', namespaceShowName: 'dev', type: 2 });
    expect(namespace.quota).toBeUndefined();
    expect(namespace.configCount).toBeUndefined();
  });

  /** `namespaceDesc: null` is what every version sends for a namespace with no description. */
  it('turns a null description into undefined', () => {
    expect(normalizeNamespace({ namespace: 'dev', namespaceShowName: 'dev', namespaceDesc: null }).description)
      .toBeUndefined();
  });

  /** `type` drives the public/default/custom distinction, so a missing one defaults to global. */
  it('defaults a missing or non-numeric type to 0', () => {
    expect(normalizeNamespace({ namespace: 'dev' }).type).toBe(0);
    expect(normalizeNamespace({ namespace: 'dev', type: '2' }).type).toBe(0);
  });

  it('falls back to the namespace id when the server sends no show name', () => {
    expect(normalizeNamespace({ namespace: 'dev', type: 2 }).displayName).toBe('dev');
  });

  /**
   * The one case where the fallback produces nothing to render. It cannot be
   * fixed here without inventing presentation text in the domain layer, and
   * the tree has to special-case the public namespace anyway (it renders the
   * localized "public（默认命名空间）"), so it owns this. Pinned so that the
   * blank is a decision rather than an accident.
   */
  it('yields an empty display name for a nameless 1.x public entry, which the tree layer must handle', () => {
    expect(normalizeNamespace({ namespace: '', type: 0 }).displayName).toBe('');
  });

  it('rejects an entry whose namespace is not a string', () => {
    expect(() => normalizeNamespace({ namespace: 42 })).toThrow(NacosApiError);
    expect(() => normalizeNamespace({ namespace: null })).toThrow(NacosApiError);
  });

  it('rejects an entry that is not an object at all', () => {
    expect(() => normalizeNamespace(null)).toThrow(NacosApiError);
    expect(() => normalizeNamespace('public')).toThrow(NacosApiError);
    expect(() => normalizeNamespace(['public'])).toThrow(NacosApiError);
  });

  it('classifies a malformed entry as invalid-response', () => {
    const error = catchError(() => normalizeNamespace({ namespaceShowName: 'x' }));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('invalid-response');
  });
});

describe('unwrapData', () => {
  it('takes data out of the v2/v3 envelope', () => {
    expect(unwrapData({ code: 0, message: 'success', data: [1, 2] })).toEqual([1, 2]);
  });

  it('takes data out of the 1.x RestResult envelope, whose success code is 200', () => {
    expect(unwrapData({ code: 200, message: null, data: ['x'] })).toEqual(['x']);
  });

  /**
   * 1.x answers the config and history lists with a bare `Page` object and no
   * envelope at all, so a payload carrying neither key is the payload.
   */
  it('passes a bare object through untouched', () => {
    const page = { totalCount: 1, pageItems: [{ dataId: 'a' }] };
    expect(unwrapData(page)).toBe(page);
  });

  it('passes a bare array through untouched', () => {
    const rows = [{ namespace: '' }];
    expect(unwrapData(rows)).toBe(rows);
  });

  /**
   * An envelope is recognized by either key, not by both. `{code, message}`
   * with no `data` is a real 1.x/2.x shape for an operation that returns
   * nothing, and reporting the envelope itself as the payload would hand the
   * caller an object that only looks like content.
   */
  it('reports no data for an envelope that carries only a code', () => {
    expect(unwrapData({ code: 0, message: 'success' })).toBeUndefined();
  });

  it('unwraps an envelope that carries data but no code', () => {
    expect(unwrapData({ data: ['x'] })).toEqual(['x']);
  });

  it('passes a null or undefined payload through', () => {
    expect(unwrapData(null)).toBeNull();
    expect(unwrapData(undefined)).toBeUndefined();
  });

  it('unwraps exactly one level, because only the outermost envelope is Nacos-added', () => {
    expect(unwrapData({ code: 0, data: { code: 0, data: ['inner'] } })).toEqual({ code: 0, data: ['inner'] });
  });
});

describe('unwrapDataArray', () => {
  it('returns the array inside an envelope', () => {
    expect(unwrapDataArray({ code: 0, data: [{ namespace: '' }] }, '/v2/console/namespace/list')).toEqual([
      { namespace: '' }
    ]);
  });

  /** A server with only the public namespace is impossible, but zero rows is still not an error. */
  it('returns an empty array as an empty array', () => {
    expect(unwrapDataArray({ code: 0, data: [] }, '/v2/console/namespace/list')).toEqual([]);
  });

  /**
   * Everything below would otherwise reach `.map()` and raise a TypeError,
   * which escapes the resolver's fall-through machinery entirely because it
   * carries no kind to inspect.
   */
  it.each([
    ['a missing data field', { code: 0, message: 'success' }],
    ['a null data field', { code: 0, message: 'success', data: null }],
    ['an object where a list was expected', { code: 0, data: { namespace: '' } }],
    ['a string where a list was expected', { code: 0, data: 'public' }],
    ['a payload that is not JSON content at all', null],
    ['an empty response body', undefined]
  ])('reports %s as a NacosApiError rather than letting map() throw', (_label, payload) => {
    const error = catchError(() => unwrapDataArray(payload, '/v1/console/namespaces'));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('invalid-response');
    expect((error as NacosApiError).message).toContain('/v1/console/namespaces');
  });

  it('names the endpoint it was reading so the message says which version failed', () => {
    const error = catchError(() => unwrapDataArray({ code: 0 }, '/v3/console/core/namespace/list'));
    expect((error as NacosApiError).message).toContain('/v3/console/core/namespace/list');
  });
});

/**
 * A `GET /v1/cs/configs?show=all` response captured verbatim from a real
 * Nacos 2.3.2. Kept as raw text and parsed rather than transcribed into an
 * object literal, so that the `\n` inside `content` is the server's escaping
 * rather than this file's.
 */
const REAL_DETAIL_2_3_2 = String.raw`{"id":"142","dataId":"application-uat.yml","group":"cl-intimfy","content":"spring:\n  autoconfigure:\n    exclude: com.alibaba.druid.spring.boot.autoconfigure.DruidDataSourceAutoConfigure","md5":"e1a9de8c8df94a487159b655a3c8f703","encryptedDataKey":"","tenant":"uat","appName":"","type":"yaml","createTime":1758164587000,"modifyTime":1758164587000,"createUser":null,"createIp":"192.168.66.66","desc":"","use":null,"effect":null,"schema":null,"configTags":null}`;

/** One `pageItems` entry from a real 2.3.2 `search=accurate` config list. */
const ACCURATE_LIST_ITEM = {
  id: '142',
  dataId: 'application-uat.yml',
  group: 'cl-intimfy',
  content: 'spring:\n  autoconfigure:\n    exclude: com.alibaba.druid.spring.boot.autoconfigure.DruidDataSourceAutoConfigure',
  md5: null,
  encryptedDataKey: '',
  tenant: 'uat',
  appName: '',
  type: 'yaml'
};

describe('normalizeConfigSummary', () => {
  it('normalizes an accurate-search list item from a real 2.3.2', () => {
    expect(normalizeConfigSummary(ACCURATE_LIST_ITEM)).toEqual({
      namespaceId: 'uat',
      group: 'cl-intimfy',
      dataId: 'application-uat.yml',
      type: 'yaml',
      appName: undefined,
      md5: undefined
    });
  });

  /**
   * The server puts the whole config body in every list item -- 12 configs
   * measured 38KB on the real server, and there is no v1 parameter to turn it
   * off. Keeping it would mean every tree node holds a full config body, and
   * those bodies contain database passwords. It is dropped here, at the
   * boundary, so that no layer above can leak what it never received.
   */
  it('drops the content the list response carried', () => {
    const summary = normalizeConfigSummary(ACCURATE_LIST_ITEM);
    expect('content' in summary).toBe(false);
    expect(JSON.stringify(summary)).not.toContain('DruidDataSourceAutoConfigure');
  });

  /** Verified on the real server: blur search nulls the type out. */
  it('turns the null type of a blur-search item into undefined', () => {
    expect(normalizeConfigSummary({ ...ACCURATE_LIST_ITEM, type: null }).type).toBeUndefined();
  });

  /**
   * The real 2.3.2 sends `md5: null` in *both* search modes, so the listing
   * never supplies one there. A version that does is still read.
   */
  it('keeps an md5 the server did send', () => {
    expect(normalizeConfigSummary({ ...ACCURATE_LIST_ITEM, md5: 'e1a9de8c' }).md5).toBe('e1a9de8c');
  });

  it('reads the v3 spellings of the group and the namespace', () => {
    expect(
      normalizeConfigSummary({ dataId: 'a.yml', groupName: 'DEFAULT_GROUP', namespaceId: 'public', type: 'yaml' })
    ).toMatchObject({ group: 'DEFAULT_GROUP', namespaceId: 'public' });
  });

  /**
   * A compatibility layer that fills both is the only way both can appear,
   * and it is the legacy alias that goes stale in that arrangement.
   */
  it('prefers the v3 spelling when a server sends both', () => {
    expect(
      normalizeConfigSummary({ dataId: 'a.yml', group: '', groupName: 'DEFAULT_GROUP', tenant: '', namespaceId: 'uat' })
    ).toMatchObject({ group: 'DEFAULT_GROUP', namespaceId: 'uat' });
  });

  /** The public namespace really is the empty string on 1.x/2.x -- see `publicNamespaceId`. */
  it('keeps the empty tenant of a 1.x public config as the namespace id', () => {
    expect(normalizeConfigSummary({ dataId: 'a.yml', group: 'DEFAULT_GROUP', tenant: '' }).namespaceId).toBe('');
  });

  it('turns an empty appName into undefined, which is how 2.3.2 spells "not set"', () => {
    expect(normalizeConfigSummary({ ...ACCURATE_LIST_ITEM, appName: 'billing' }).appName).toBe('billing');
    expect(normalizeConfigSummary({ ...ACCURATE_LIST_ITEM, appName: '' }).appName).toBeUndefined();
  });

  /**
   * The dataId is the entry's identity: without one there is nothing to name
   * in the tree and nothing to fetch. If a future version renames the field
   * then every item is unreadable, so failing loudly on the first beats
   * rendering a page of blanks.
   */
  it('rejects an item with no dataId', () => {
    const error = catchError(() => normalizeConfigSummary({ group: 'DEFAULT_GROUP', tenant: '' }));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('invalid-response');
  });

  it('rejects an item that is not an object at all', () => {
    expect(() => normalizeConfigSummary(null)).toThrow(NacosApiError);
    expect(() => normalizeConfigSummary('application.yml')).toThrow(NacosApiError);
  });
});

describe('normalizeConfigDetail', () => {
  it('round-trips a real 2.3.2 show=all response', () => {
    expect(normalizeConfigDetail(JSON.parse(REAL_DETAIL_2_3_2))).toEqual({
      namespaceId: 'uat',
      group: 'cl-intimfy',
      dataId: 'application-uat.yml',
      type: 'yaml',
      appName: undefined,
      md5: 'e1a9de8c8df94a487159b655a3c8f703',
      content:
        'spring:\n  autoconfigure:\n    exclude: com.alibaba.druid.spring.boot.autoconfigure.DruidDataSourceAutoConfigure',
      createTime: 1758164587000,
      modifyTime: 1758164587000,
      createIp: '192.168.66.66',
      description: undefined
    });
  });

  it('keeps the newlines in the content, which is the whole point of the document', () => {
    expect(normalizeConfigDetail(JSON.parse(REAL_DETAIL_2_3_2)).content.split('\n')).toHaveLength(3);
  });

  it('reads the 1.x/2.x desc field as the description', () => {
    expect(
      normalizeConfigDetail({ dataId: 'a.yml', group: 'g', tenant: '', content: 'x', desc: 'the gateway routes' })
        .description
    ).toBe('the gateway routes');
  });

  /** An empty config is legal and normalizes to an empty document. */
  it('accepts an empty content', () => {
    expect(normalizeConfigDetail({ dataId: 'a.yml', group: 'g', tenant: '', content: '' }).content).toBe('');
  });

  /**
   * The one field a detail exists to carry. Defaulting it to '' would open an
   * empty editor for a config that is not empty -- indistinguishable from the
   * real thing, and something M5's publish path could later overwrite the
   * server with.
   */
  it('rejects a detail whose content is missing rather than opening an empty document', () => {
    const error = catchError(() => normalizeConfigDetail({ dataId: 'a.yml', group: 'g', tenant: '' }));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('invalid-response');
  });

  it('rejects a detail whose content is not a string', () => {
    expect(() => normalizeConfigDetail({ dataId: 'a.yml', group: 'g', content: { text: 'x' } })).toThrow(NacosApiError);
  });

  it('drops timestamps the server did not send rather than inventing an epoch', () => {
    const detail = normalizeConfigDetail({ dataId: 'a.yml', group: 'g', tenant: '', content: 'x' });
    expect(detail.createTime).toBeUndefined();
    expect(detail.modifyTime).toBeUndefined();
    expect(detail.createIp).toBeUndefined();
  });
});

describe('normalizePaged', () => {
  const BARE_PAGE = {
    totalCount: 12,
    pageNumber: 1,
    pagesAvailable: 2,
    pageItems: [ACCURATE_LIST_ITEM]
  };

  /** 1.x and 2.x answer the config list with a bare `Page` and no envelope. */
  it('normalizes the bare Page that 1.x returns', () => {
    expect(normalizePaged(BARE_PAGE, normalizeConfigSummary, '/v1/cs/configs')).toEqual({
      items: [normalizeConfigSummary(ACCURATE_LIST_ITEM)],
      totalCount: 12,
      pageNumber: 1,
      pagesAvailable: 2
    });
  });

  it('normalizes the same Page wrapped in the 3.x envelope', () => {
    expect(
      normalizePaged({ code: 0, message: 'success', data: BARE_PAGE }, normalizeConfigSummary, '/v3/admin/cs/config/list')
    ).toEqual(normalizePaged(BARE_PAGE, normalizeConfigSummary, '/v1/cs/configs'));
  });

  /** 1.x's RestResult envelope says 200 where v2/v3 say 0. */
  it('normalizes a Page wrapped in the 1.x RestResult envelope', () => {
    expect(normalizePaged({ code: 200, data: BARE_PAGE }, normalizeConfigSummary, '/v1/cs/configs').totalCount).toBe(12);
  });

  it('returns an empty page as an empty page rather than as a failure', () => {
    expect(
      normalizePaged(
        { totalCount: 0, pageNumber: 1, pagesAvailable: 0, pageItems: [] },
        normalizeConfigSummary,
        '/v1/cs/configs'
      )
    ).toEqual({ items: [], totalCount: 0, pageNumber: 1, pagesAvailable: 0 });
  });

  /**
   * Same reasoning as `unwrapDataArray`: a raw TypeError out of `.map()`
   * carries no kind, so `NacosCapabilityResolver` cannot judge whether to try
   * the next driver and the chain stops dead. And only the endpoint in the
   * message says which of the four versions answered this way.
   */
  it.each([
    ['a missing data field', { code: 0, message: 'success' }],
    ['a null data field', { code: 0, data: null }],
    ['an object with no pageItems', { code: 0, data: { totalCount: 0 } }],
    ['a pageItems that is not a list', { totalCount: 1, pageItems: { dataId: 'a.yml' } }],
    ['a bare list where a page was expected', [ACCURATE_LIST_ITEM]],
    ['a string where a page was expected', 'config data not exist'],
    ['an empty response body', undefined]
  ])('reports %s as a NacosApiError naming the endpoint', (_label, payload) => {
    const error = catchError(() => normalizePaged(payload, normalizeConfigSummary, '/v1/cs/configs'));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('invalid-response');
    expect((error as NacosApiError).message).toContain('/v1/cs/configs');
  });

  /** "a object" is neither grammar nor a diagnosis. */
  it('names an array as an array when a page was expected', () => {
    const error = catchError(() => normalizePaged([ACCURATE_LIST_ITEM], normalizeConfigSummary, '/v1/cs/configs'));
    expect((error as NacosApiError).message).toContain('an array');
  });

  /**
   * The items are the payload; the counters are only navigation. A server
   * that sends the rows but omits a counter still has rows worth showing, so
   * the page degrades to "one page of what arrived" instead of throwing away
   * the response.
   */
  it('degrades a page whose counters are missing to a single page of what arrived', () => {
    expect(normalizePaged({ pageItems: [ACCURATE_LIST_ITEM] }, normalizeConfigSummary, '/v1/cs/configs')).toMatchObject({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1
    });
  });

  it('lets a failure inside the item mapper travel unchanged', () => {
    const error = catchError(() =>
      normalizePaged({ pageItems: [{ group: 'g' }] }, normalizeConfigSummary, '/v1/cs/configs')
    );
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
