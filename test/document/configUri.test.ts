import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import {
  NACOS_CONFIG_SCHEME,
  buildConfigHistoryUri,
  buildConfigUri,
  parseConfigUri
} from '../../src/document/configUri';
import type { NacosConfigRef } from '../../src/nacos/driver/normalize';

function ref(overrides: Partial<NacosConfigRef> = {}): NacosConfigRef {
  return { namespaceId: 'uat', group: 'cl-intimfy', dataId: 'application-uat.yml', ...overrides };
}

/** What a caller has: an id, and a ref that came out of `normalizeConfigSummary`. */
function roundTrip(instanceId: string, target: NacosConfigRef) {
  return parseConfigUri(buildConfigUri(instanceId, target));
}

describe('buildConfigUri', () => {
  it('uses the nacos scheme, which is the one the content provider registers for', () => {
    expect(buildConfigUri('instance-1', ref()).scheme).toBe(NACOS_CONFIG_SCHEME);
    expect(NACOS_CONFIG_SCHEME).toBe('nacos');
  });

  /**
   * `vscode.Uri` refuses a path that begins with two slashes when there is no
   * authority -- it would be re-read as one on the way back -- and appends the
   * path to the authority without a separator when it does not begin with one.
   */
  it('writes an absolute path that begins with exactly one slash', () => {
    const uri = buildConfigUri('instance-1', ref());

    expect(uri.path.startsWith('/')).toBe(true);
    expect(uri.path.startsWith('//')).toBe(false);
  });

  /**
   * The instance id is a path segment rather than the URI's authority. An
   * authority is case-folded by `Uri.toString()` and carries its own
   * `user:pass@host:port` syntax, and `NacosInstanceConfig.id` is only
   * `z.string().min(1)` -- so an id from an older build could be read back as
   * a credential, in the one string VS Code prints in the tab and in Ctrl+P.
   */
  it('never turns any part of the address into URI userinfo, whatever the instance id holds', () => {
    const uri = buildConfigUri('admin:hunter2@legacy', ref());

    expect(uri.authority).toBe('');
    expect(uri.toString()).not.toContain('hunter2@');
    expect(parseConfigUri(uri)?.instanceId).toBe('admin:hunter2@legacy');
  });

  /**
   * A shape guard on the signature: the URI is built from the instance's *id*,
   * never from its address, so no credential typed into a server URL can reach
   * the editor tab, Ctrl+P or the recently-opened list. The instance below is
   * written by hand rather than parsed, because `parseNacosInstanceConfig`
   * strips the userinfo itself and would hide a regression here.
   */
  it('carries no credential even for an instance whose server URL was typed with one', () => {
    const instance = {
      id: 'instance-1',
      serverUrl: 'http://admin:hunter2@nacos.example.com:8848/nacos'
    } as NacosInstanceConfig;

    const uri = buildConfigUri(instance.id, ref());

    expect(uri.toString()).not.toContain('hunter2');
    expect(uri.toString()).not.toContain('nacos.example.com');
    expect(uri.path).not.toContain('hunter2');
  });

  it('gives two instances holding the same config two different URIs', () => {
    const first = buildConfigUri('instance-1', ref());
    const second = buildConfigUri('instance-2', ref());

    expect(first.toString()).not.toBe(second.toString());
    expect(parseConfigUri(first)?.instanceId).toBe('instance-1');
    expect(parseConfigUri(second)?.instanceId).toBe('instance-2');
  });

  it('ends the path with the dataId, so the editor tab is titled after it', () => {
    const uri = buildConfigUri('instance-1', ref({ dataId: 'application-uat.yml' }));

    expect(uri.path.endsWith('/application-uat.yml')).toBe(true);
  });
});

describe('configUri round trip', () => {
  it('round-trips an ordinary ref', () => {
    expect(roundTrip('instance-1', ref())).toEqual({ instanceId: 'instance-1', ref: ref() });
  });

  it('round-trips a dataId containing a slash, which is legal in Nacos and would split the path', () => {
    const target = ref({ dataId: 'com/example/service.yml' });

    expect(roundTrip('instance-1', target)?.ref).toEqual(target);
  });

  it('round-trips a dataId containing a question mark, which would otherwise start the query', () => {
    const target = ref({ dataId: 'feature?enabled.properties' });

    expect(roundTrip('instance-1', target)?.ref).toEqual(target);
  });

  it('round-trips a dataId containing a hash, which would otherwise start the fragment', () => {
    const target = ref({ dataId: 'release#2024.json' });

    expect(roundTrip('instance-1', target)?.ref).toEqual(target);
  });

  it('round-trips a dataId containing a space', () => {
    const target = ref({ dataId: 'my service.yaml' });

    expect(roundTrip('instance-1', target)?.ref).toEqual(target);
  });

  it('round-trips a dataId written in Chinese', () => {
    const target = ref({ dataId: '订单服务-生产.yaml' });

    expect(roundTrip('instance-1', target)?.ref).toEqual(target);
  });

  /** Decoding once too often would hand the driver a dataId that does not exist. */
  it('round-trips a dataId that is itself a percent escape, without decoding it twice', () => {
    const target = ref({ dataId: '%2Fnot-a-slash.yml' });

    expect(roundTrip('instance-1', target)?.ref).toEqual(target);
  });

  it('round-trips a group containing a slash', () => {
    const target = ref({ group: 'team/payments' });

    expect(roundTrip('instance-1', target)?.ref).toEqual(target);
  });

  it('round-trips an instance id containing a slash', () => {
    expect(roundTrip('legacy/instance', ref())?.instanceId).toBe('legacy/instance');
  });

  /** 1.x and 2.x spell the public namespace as the empty string, and an empty path segment vanishes. */
  it('round-trips the empty namespaceId that 1.x and 2.x use for the public namespace', () => {
    const target = ref({ namespaceId: '' });

    expect(roundTrip('instance-1', target)?.ref).toEqual(target);
  });

  it('round-trips the literal "public" that 3.x uses, distinctly from the empty one', () => {
    const empty = buildConfigUri('instance-1', ref({ namespaceId: '' }));
    const literal = buildConfigUri('instance-1', ref({ namespaceId: 'public' }));

    expect(empty.toString()).not.toBe(literal.toString());
    expect(parseConfigUri(literal)?.ref.namespaceId).toBe('public');
  });

  /**
   * The sentinel standing in for the empty namespace cannot be the encoding of
   * any string at all: every real namespace id goes through
   * `encodeURIComponent` first, and that escapes the character the sentinel is
   * built from. This is the test of that claim -- a server that somehow serves
   * a namespace named after the sentinel still gets its own URI.
   */
  it('does not confuse a namespace whose id looks like the public sentinel with the public namespace', () => {
    for (const impostor of ['$public', '_public_', 'public']) {
      const spoofed = buildConfigUri('instance-1', ref({ namespaceId: impostor }));
      const real = buildConfigUri('instance-1', ref({ namespaceId: '' }));

      expect(spoofed.toString(), impostor).not.toBe(real.toString());
      expect(parseConfigUri(spoofed)?.ref.namespaceId, impostor).toBe(impostor);
    }
  });
});

describe('buildConfigHistoryUri', () => {
  /**
   * The whole reason the history address exists. `vscode.diff` is handed two
   * URIs and VS Code keys open documents by `Uri.toString()`, so two equal
   * addresses are one buffer -- and a diff of a buffer against itself renders
   * as a file with no changes, which is indistinguishable from a version that
   * really is identical.
   */
  it('addresses a history version differently from the current version', () => {
    const current = buildConfigUri('instance-1', ref());
    const history = buildConfigHistoryUri('instance-1', ref(), '1044');

    expect(history.toString()).not.toBe(current.toString());
  });

  it('keeps that difference for every ref shape the current address handles', () => {
    for (const target of [
      ref(),
      ref({ namespaceId: '' }),
      ref({ namespaceId: '$public' }),
      ref({ dataId: 'com/example/service.yml' }),
      ref({ dataId: 'release#2024.json' }),
      ref({ group: 'team?payments' })
    ]) {
      expect(buildConfigHistoryUri('instance-1', target, '1044').toString(), target.dataId).not.toBe(
        buildConfigUri('instance-1', target).toString()
      );
    }
  });

  it('gives two versions of one configuration two different addresses', () => {
    const older = buildConfigHistoryUri('instance-1', ref(), '1044');
    const newer = buildConfigHistoryUri('instance-1', ref(), '1045');

    expect(older.toString()).not.toBe(newer.toString());
  });

  /**
   * The version is the only thing that differs. Both sides of a diff have to
   * name the same configuration, or the editor is comparing two files.
   */
  it('addresses the same configuration as the current version does', () => {
    const current = parseConfigUri(buildConfigUri('instance-1', ref()));
    const history = parseConfigUri(buildConfigHistoryUri('instance-1', ref(), '1044'));

    expect(history?.instanceId).toBe(current?.instanceId);
    expect(history?.ref).toEqual(current?.ref);
    expect(current?.nid).toBeUndefined();
    expect(history?.nid).toBe('1044');
  });

  it('uses the same scheme, so one content provider serves both sides', () => {
    expect(buildConfigHistoryUri('instance-1', ref(), '1044').scheme).toBe(NACOS_CONFIG_SCHEME);
  });

  /** The tab title is the last path segment, and a history tab titled `1044` names nothing. */
  it('still ends its path with the dataId rather than with the version', () => {
    const uri = buildConfigHistoryUri('instance-1', ref({ dataId: 'application-uat.yml' }), '1044');

    expect(uri.path.endsWith('/application-uat.yml')).toBe(true);
    expect(uri.path).not.toContain('1044');
  });

  it('round-trips a ref that needs encoding, exactly as the current address does', () => {
    const target = ref({ namespaceId: '', group: 'team/payments', dataId: '订单服务?v=1.yaml' });

    const parsed = parseConfigUri(buildConfigHistoryUri('legacy/instance', target, '1044'));

    expect(parsed).toEqual({ instanceId: 'legacy/instance', ref: target, nid: '1044' });
  });

  /**
   * A record id is a database bigint in practice, so this is defence rather
   * than a case anyone has met -- but an unencoded `&` or `#` would end the
   * query and turn the address into the current version's.
   */
  it('round-trips a version id carrying characters that would end the query', () => {
    for (const nid of ['1044&nid=1', 'a#b', 'a=b', 'a b', '%2F']) {
      const parsed = parseConfigUri(buildConfigHistoryUri('instance-1', ref(), nid));

      expect(parsed?.nid, nid).toBe(nid);
      expect(parsed?.ref, nid).toEqual(ref());
    }
  });
});

describe('parseConfigUri on a URI it did not build', () => {
  it('rejects a URI of another scheme, so the provider never answers for one', () => {
    expect(parseConfigUri(vscode.Uri.from({ scheme: 'file', path: '/i/ns/g/d.yml' }))).toBeUndefined();
  });

  it('rejects a path with too few segments', () => {
    expect(parseConfigUri(vscode.Uri.from({ scheme: 'nacos', path: '/instance-1/uat/app.yml' }))).toBeUndefined();
  });

  it('rejects a path with too many segments, since every segment is encoded and cannot split', () => {
    expect(
      parseConfigUri(vscode.Uri.from({ scheme: 'nacos', path: '/instance-1/uat/group/app.yml/extra' }))
    ).toBeUndefined();
  });

  it('rejects a broken percent escape rather than throwing URIError at the provider', () => {
    expect(parseConfigUri(vscode.Uri.from({ scheme: 'nacos', path: '/instance-1/%zz/group/app.yml' }))).toBeUndefined();
  });

  it('rejects an empty dataId, which no config has and no driver could fetch', () => {
    expect(parseConfigUri(vscode.Uri.from({ scheme: 'nacos', path: '/instance-1/uat/group/' }))).toBeUndefined();
  });

  /** The sentinel is the only spelling of the public namespace, so a literally empty segment is not one. */
  it('rejects an empty segment rather than reading it as the public namespace', () => {
    expect(parseConfigUri(vscode.Uri.from({ scheme: 'nacos', path: '/instance-1//group/app.yml' }))).toBeUndefined();
  });

  it('rejects an empty path', () => {
    expect(parseConfigUri(vscode.Uri.from({ scheme: 'nacos', path: '' }))).toBeUndefined();
  });

  /**
   * The query is the only thing that tells the two versions of one
   * configuration apart, so a query this module did not write is refused
   * rather than ignored: reading it as the current version would answer a
   * question nobody asked, with the content the other side of the diff
   * already holds.
   */
  it.each([['ref=1044'], ['nid='], ['nid=1044&nid=1045'], ['nid=1044&show=all'], ['1044'], ['nid=%zz']])(
    'rejects the query %s, which it never writes',
    (query) => {
      expect(parseConfigUri(vscode.Uri.from({ scheme: 'nacos', path: '/i/uat/g/app.yml', query }))).toBeUndefined();
    }
  );

  it('reads a well-formed history query it did write', () => {
    expect(
      parseConfigUri(vscode.Uri.from({ scheme: 'nacos', path: '/i/uat/g/app.yml', query: 'nid=1044' }))
    ).toEqual({ instanceId: 'i', ref: { namespaceId: 'uat', group: 'g', dataId: 'app.yml' }, nid: '1044' });
  });
});
