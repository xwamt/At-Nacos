import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { NACOS_CONFIG_SCHEME, buildConfigUri, parseConfigUri } from '../../src/document/configUri';
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
});
