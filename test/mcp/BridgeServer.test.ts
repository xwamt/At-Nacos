import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AT_SERIES_TOKEN_HEADER, BRIDGE_HOST } from '@at-series/mcp-hub';
import { BridgeServer } from '../../src/mcp/BridgeServer';
import type { NacosAgentToolService } from '../../src/agent/NacosAgentToolService';

describe('BridgeServer', () => {
  let tmpHome: string;
  let server: BridgeServer;
  let mockToolService: Partial<NacosAgentToolService>;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'at-nacos-bridge-test-'));
    mockToolService = {
      invoke: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'nacos_list_instances') {
          return { ok: true, result: { instances: [] } };
        }
        return { ok: false, code: 'NOT_FOUND', message: 'Not found' };
      })
    };
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    await rm(tmpHome, { recursive: true, force: true });
  });

  async function makeRequest(
    path: string,
    options: {
      method?: string;
      token?: string;
      body?: unknown;
    } = {}
  ): Promise<{ status: number; body: unknown }> {
    const port = server.getPort();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (options.token !== undefined) {
      headers[AT_SERIES_TOKEN_HEADER] = options.token;
    }

    const res = await fetch(`http://${BRIDGE_HOST}:${port}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    return {
      status: res.status,
      body
    };
  }

  it('serves GET /health with 200 and plugin metadata when authenticated', async () => {
    server = new BridgeServer({
      home: tmpHome,
      hostApp: 'cursor',
      pluginVersion: '0.1.0',
      toolService: mockToolService as never
    });
    await server.start();

    const res = await makeRequest('/health', { token: server.getToken() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        pluginId: 'at.nacos',
        pluginDisplayName: 'AT Nacos',
        pluginVersion: '0.1.0',
        hostApp: 'cursor'
      })
    );
  });

  it('rejects unauthenticated requests with 401', async () => {
    server = new BridgeServer({
      home: tmpHome,
      hostApp: 'cursor',
      toolService: mockToolService as never
    });
    await server.start();

    const resNoToken = await makeRequest('/health');
    expect(resNoToken.status).toBe(401);

    const resWrongToken = await makeRequest('/health', { token: 'wrong-token' });
    expect(resWrongToken.status).toBe(401);
  });

  it('serves GET /tools with 200 and catalog entries', async () => {
    server = new BridgeServer({
      home: tmpHome,
      hostApp: 'cursor',
      toolService: mockToolService as never
    });
    await server.start();

    const res = await makeRequest('/tools', { token: server.getToken() });
    expect(res.status).toBe(200);
    const body = res.body as { tools: { name: string }[] };
    expect(body.tools).toHaveLength(12);
  });

  it('handles POST /invoke for registered tools', async () => {
    server = new BridgeServer({
      home: tmpHome,
      hostApp: 'cursor',
      toolService: mockToolService as never
    });
    await server.start();

    const res = await makeRequest('/invoke', {
      method: 'POST',
      token: server.getToken(),
      body: {
        name: 'nacos_list_instances',
        arguments: {}
      }
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      name: 'nacos_list_instances',
      result: { instances: [] }
    });
  });

  it('returns 400 for malformed POST /invoke payloads', async () => {
    server = new BridgeServer({
      home: tmpHome,
      hostApp: 'cursor',
      toolService: mockToolService as never
    });
    await server.start();

    const resMissingName = await makeRequest('/invoke', {
      method: 'POST',
      token: server.getToken(),
      body: { arguments: {} }
    });
    expect(resMissingName.status).toBe(400);

    const resInvalidArgs = await makeRequest('/invoke', {
      method: 'POST',
      token: server.getToken(),
      body: { name: 'nacos_list_instances', arguments: { extra: 123 } }
    });
    expect(resInvalidArgs.status).toBe(400);
  });

  it('returns 404 for unknown endpoints and unknown tools', async () => {
    server = new BridgeServer({
      home: tmpHome,
      hostApp: 'cursor',
      toolService: mockToolService as never
    });
    await server.start();

    const resUnknownPath = await makeRequest('/non-existent', { token: server.getToken() });
    expect(resUnknownPath.status).toBe(404);

    const resUnknownTool = await makeRequest('/invoke', {
      method: 'POST',
      token: server.getToken(),
      body: { name: 'nacos_unknown', arguments: {} }
    });
    expect(resUnknownTool.status).toBe(404);
  });
});
