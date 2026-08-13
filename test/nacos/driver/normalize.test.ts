import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import {
  namespaceParamName,
  normalizeNamespace,
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
  it('uses tenant for the 1.x config module', () => {
    expect(namespaceParamName(1, 'config')).toBe('tenant');
  });

  it('uses namespaceId for the 1.x naming module even though config uses tenant', () => {
    expect(namespaceParamName(1, 'naming')).toBe('namespaceId');
  });

  /** 1.x's own console endpoints (namespace create/delete) take namespaceId, never tenant. */
  it('uses namespaceId for the 1.x console module', () => {
    expect(namespaceParamName(1, 'console')).toBe('namespaceId');
  });

  /**
   * 2.x keeps the whole v1 surface, so a config call made against a v1 path
   * still spells it `tenant`. The v2 config paths spell it `namespaceId`, and
   * the major version alone cannot tell those two apart -- whoever adds the
   * first v2 config call site has to key this off the driver flavor instead.
   */
  it('uses the v1 spelling on 2.x, which is right for v1 paths and wrong for v2 paths', () => {
    expect(namespaceParamName(2, 'config')).toBe('tenant');
    expect(namespaceParamName(2, 'naming')).toBe('namespaceId');
  });

  it('uses namespaceId everywhere on 3.x', () => {
    expect(namespaceParamName(3, 'config')).toBe('namespaceId');
    expect(namespaceParamName(3, 'naming')).toBe('namespaceId');
    expect(namespaceParamName(3, 'console')).toBe('namespaceId');
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

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
