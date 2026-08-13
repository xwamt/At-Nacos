import { describe, expect, it } from 'vitest';
import {
  NACOS_AUTH_MODES,
  parseNacosInstanceConfig,
  parseNacosInstanceConfigList
} from '../../src/config/schema';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'prod',
  serverUrl: 'http://nacos.example.com:8848/nacos',
  authMode: 'userPassword' as const,
  username: 'nacos',
  readOnly: true,
  allowBackgroundAccess: false,
  createdAt: 1,
  updatedAt: 2
};

describe('parseNacosInstanceConfig', () => {
  it('accepts a full config', () => {
    expect(parseNacosInstanceConfig(base).label).toBe('prod');
  });

  it('strips a trailing slash from serverUrl so path joins stay predictable', () => {
    const parsed = parseNacosInstanceConfig({ ...base, serverUrl: 'http://h:8848/nacos///' });
    expect(parsed.serverUrl).toBe('http://h:8848/nacos');
  });

  it('trims surrounding whitespace from serverUrl', () => {
    const parsed = parseNacosInstanceConfig({ ...base, serverUrl: '  http://h:8848/nacos  ' });
    expect(parsed.serverUrl).toBe('http://h:8848/nacos');
  });

  it('rejects a serverUrl without an http(s) scheme', () => {
    expect(() => parseNacosInstanceConfig({ ...base, serverUrl: 'nacos.example.com' })).toThrow();
  });

  it('rejects a serverUrl whose scheme is not http(s)', () => {
    expect(() => parseNacosInstanceConfig({ ...base, serverUrl: 'ftp://h:8848' })).toThrow();
  });

  it('accepts an https serverUrl', () => {
    expect(parseNacosInstanceConfig({ ...base, serverUrl: 'https://h:8848/nacos' }).serverUrl).toBe(
      'https://h:8848/nacos'
    );
  });

  it('rejects an empty label', () => {
    expect(() => parseNacosInstanceConfig({ ...base, label: '' })).toThrow();
  });

  it('rejects an unknown authMode', () => {
    expect(() => parseNacosInstanceConfig({ ...base, authMode: 'kerberos' })).toThrow();
  });

  it('accepts every declared auth mode, including the deferred akSk', () => {
    // akSk has no implementation in M1, but a config written by a later
    // version must still load here rather than blank the whole instance list.
    for (const authMode of NACOS_AUTH_MODES) {
      expect(parseNacosInstanceConfig({ ...base, authMode }).authMode).toBe(authMode);
    }
    expect(NACOS_AUTH_MODES).toContain('akSk');
  });

  it('normalizes consoleUrl the same way it normalizes serverUrl', () => {
    const parsed = parseNacosInstanceConfig({ ...base, consoleUrl: 'http://h:8080/' });
    expect(parsed.consoleUrl).toBe('http://h:8080');
  });

  it('accepts a config without a consoleUrl, which probing fills in later', () => {
    expect(parseNacosInstanceConfig(base).consoleUrl).toBeUndefined();
  });

  it('rejects a consoleUrl without an http(s) scheme', () => {
    expect(() => parseNacosInstanceConfig({ ...base, consoleUrl: 'h:8080' })).toThrow();
  });

  it('defaults readOnly to false when absent so existing records keep working', () => {
    const { readOnly, ...withoutReadOnly } = base;
    expect(parseNacosInstanceConfig(withoutReadOnly).readOnly).toBe(false);
  });

  it('defaults allowBackgroundAccess to false so Agent access stays opt-in', () => {
    const { allowBackgroundAccess, ...withoutFlag } = base;
    expect(parseNacosInstanceConfig(withoutFlag).allowBackgroundAccess).toBe(false);
  });

  it('drops a field it does not know instead of rejecting the record', () => {
    // The reason this schema strips rather than being strict: a later
    // milestone adds fields (AK/SK region), and a user who downgrades must
    // still be able to read the records the newer version wrote.
    const parsed = parseNacosInstanceConfig({ ...base, region: 'cn-hangzhou' });
    expect(parsed.label).toBe('prod');
    expect('region' in parsed).toBe(false);
  });

  it('still rejects a record that is missing a required field', () => {
    // Stripping unknown fields must not turn into tolerating real corruption.
    const { createdAt, ...withoutCreatedAt } = base;
    expect(() => parseNacosInstanceConfig(withoutCreatedAt)).toThrow();
  });
});

describe('parseNacosInstanceConfigList', () => {
  it('parses an empty list', () => {
    expect(parseNacosInstanceConfigList([])).toEqual([]);
  });

  it('parses every record in a list', () => {
    const second = { ...base, id: '22222222-2222-4222-8222-222222222222', label: 'dev' };
    expect(parseNacosInstanceConfigList([base, second]).map((entry) => entry.label)).toEqual(['prod', 'dev']);
  });

  it('rejects a value that is not an array', () => {
    expect(() => parseNacosInstanceConfigList('nope')).toThrow();
    expect(() => parseNacosInstanceConfigList(null)).toThrow();
  });

  it('rejects a list holding a corrupt record', () => {
    expect(() => parseNacosInstanceConfigList([base, { id: 'orphan' }])).toThrow();
  });
});
