import { describe, expect, it } from 'vitest';
import { normalizeListenedConfigs, parseGroupKey } from '../../../src/nacos/driver/normalize';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import { NacosHttpClient } from '../../../src/nacos/NacosHttpClient';
import { V1Driver } from '../../../src/nacos/driver/V1Driver';
import { V3AdminDriver } from '../../../src/nacos/driver/V3AdminDriver';
import { V3ConsoleDriver } from '../../../src/nacos/driver/V3ConsoleDriver';
import { startTestHttpServer } from '../testHttpServer';

describe('parseGroupKey', () => {
  it('splits dataId+group+tenant at the first two pluses', () => {
    expect(parseGroupKey('db.yaml+DEFAULT_GROUP+dev')).toEqual({
      dataId: 'db.yaml',
      group: 'DEFAULT_GROUP'
    });
  });

  it('keeps a dataId that contains no plus', () => {
    expect(parseGroupKey('only-data-id')).toEqual({ dataId: 'only-data-id', group: '' });
  });

  it('splits dataId+group when tenant is absent', () => {
    expect(parseGroupKey('app.yaml+DEFAULT_GROUP')).toEqual({
      dataId: 'app.yaml',
      group: 'DEFAULT_GROUP'
    });
  });
});

describe('normalizeListenedConfigs', () => {
  it('reads the misspelled status map as configs one IP holds', () => {
    expect(
      normalizeListenedConfigs(
        { collectStatus: 200, lisentersGroupkeyStatus: { 'db.yaml+DEFAULT_GROUP+dev': 'abc' } },
        '/v1/cs/listener'
      )
    ).toEqual([{ dataId: 'db.yaml', group: 'DEFAULT_GROUP', md5: 'abc' }]);
  });

  it('accepts an empty map', () => {
    expect(
      normalizeListenedConfigs({ collectStatus: 200, lisentersGroupkeyStatus: {} }, '/v1/cs/listener')
    ).toEqual([]);
  });

  it('raises invalid-response when the map is missing', () => {
    expect(() => normalizeListenedConfigs({ collectStatus: 200 }, '/v1/cs/listener')).toThrow(NacosApiError);
  });

  it('reads 3.x ConfigListenerInfo listenersStatus from the code/data envelope', () => {
    expect(
      normalizeListenedConfigs(
        {
          code: 0,
          data: {
            queryType: 'ip',
            listenersStatus: { 'db.yaml+DEFAULT_GROUP+dev': 'abc' }
          }
        },
        '/v3/admin/cs/listener'
      )
    ).toEqual([{ dataId: 'db.yaml', group: 'DEFAULT_GROUP', md5: 'abc' }]);
  });
});

describe('listListenedConfigs drivers', () => {
  const body = '{"collectStatus":200,"lisentersGroupkeyStatus":{"db.yaml+DEFAULT_GROUP+dev":"abc"}}';

  it('v1 asks /v1/cs/listener with tenant and ip', async () => {
    const server = await startTestHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' });
      res.end(body);
    });
    try {
      const http = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
      const result = await new V1Driver(http).listListenedConfigs({
        namespaceId: 'dev',
        ip: '10.0.0.8'
      });
      expect(result).toEqual([{ dataId: 'db.yaml', group: 'DEFAULT_GROUP', md5: 'abc' }]);
      const url = new URL(server.requests[0]?.url ?? '', 'http://127.0.0.1');
      expect(url.pathname).toBe('/nacos/v1/cs/listener');
      expect(url.searchParams.get('ip')).toBe('10.0.0.8');
      expect(url.searchParams.get('tenant')).toBe('dev');
      expect(url.searchParams.has('aggregation')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('v3-admin asks /v3/admin/cs/listener with aggregation', async () => {
    const v3Body =
      '{"code":0,"data":{"queryType":"ip","listenersStatus":{"db.yaml+DEFAULT_GROUP+dev":"abc"}}}';
    const server = await startTestHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' });
      res.end(v3Body);
    });
    try {
      const http = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
      const result = await new V3AdminDriver(http).listListenedConfigs({
        namespaceId: 'dev',
        ip: '10.0.0.8'
      });
      expect(result).toEqual([{ dataId: 'db.yaml', group: 'DEFAULT_GROUP', md5: 'abc' }]);
      const url = new URL(server.requests[0]?.url ?? '', 'http://127.0.0.1');
      expect(url.pathname).toBe('/nacos/v3/admin/cs/listener');
      expect(url.searchParams.get('namespaceId')).toBe('dev');
      expect(url.searchParams.get('aggregation')).toBe('true');
    } finally {
      await server.close();
    }
  });

  it('v3-console asks /v3/console/cs/config/listener/ip on the console origin', async () => {
    const v3Body =
      '{"code":0,"data":{"queryType":"ip","listenersStatus":{"db.yaml+DEFAULT_GROUP+dev":"abc"}}}';
    const server = await startTestHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' });
      res.end(v3Body);
    });
    try {
      const http = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
      const result = await new V3ConsoleDriver(http, server.origin).listListenedConfigs({
        namespaceId: 'dev',
        ip: '10.0.0.8'
      });
      expect(result).toEqual([{ dataId: 'db.yaml', group: 'DEFAULT_GROUP', md5: 'abc' }]);
      const url = new URL(server.requests[0]?.url ?? '', 'http://127.0.0.1');
      expect(url.pathname).toBe('/v3/console/cs/config/listener/ip');
      expect(url.searchParams.get('namespaceId')).toBe('dev');
      expect(url.searchParams.get('aggregation')).toBe('true');
    } finally {
      await server.close();
    }
  });
});
