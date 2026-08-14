import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import {
  AT_SERIES_PROTOCOL_VERSION,
  AT_SERIES_TOKEN_HEADER,
  BRIDGE_HOST,
  BRIDGE_MAX_BODY_BYTES,
  createBridgeToken,
  FsBridgePublisher,
  timingSafeEqualToken,
  type HostApp
} from '@at-series/mcp-hub';
import type { NacosAgentToolService } from '../agent/NacosAgentToolService';
import { formatError } from '../utils/errors';
import { asRedactedLog, noopLog, type AtNacosLog } from '../utils/logger';
import { AT_NACOS_PLUGIN_DISPLAY_NAME } from './BridgeProtocol';
import { BRIDGE_SCHEMAS_BY_TOOL_NAME, describeZodError } from './bridgeSchemas';
import { AT_NACOS_PLUGIN_ID, AT_NACOS_TOOL_CATALOG } from './toolCatalog';

const BRIDGE_HEARTBEAT_INTERVAL_MS = 30_000;

export interface BridgeServerOptions {
  home?: string;
  hostApp: HostApp;
  pluginVersion?: string;
  toolService?: NacosAgentToolService;
  limits?: Partial<BridgeServerLimits>;
  log?: AtNacosLog;
}

export interface BridgeServerLimits {
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  maxConnections: number;
}

export const DEFAULT_BRIDGE_SERVER_LIMITS: BridgeServerLimits = {
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  maxConnections: 64
};

export interface BridgeHandlerDependencies {
  bridgeId: string;
  token: string;
  hostApp: HostApp;
  pluginVersion: string;
  pluginDisplayName?: string;
  toolService?: NacosAgentToolService;
  log?: AtNacosLog;
}

export interface BridgeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

export interface BridgeResponse {
  status: number;
  body: unknown;
}

const DEFAULT_PLUGIN_VERSION = '0.1.0';

export class BridgeServer {
  private server: Server | undefined;
  private token = '';
  private port: number | undefined;
  private publisher: FsBridgePublisher | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly bridgeId = randomUUID();
  private readonly home: string;
  private readonly hostApp: HostApp;
  private readonly pluginVersion: string;
  private readonly toolService: NacosAgentToolService | undefined;
  private readonly limits: BridgeServerLimits;
  private readonly log: AtNacosLog;

  constructor(options: BridgeServerOptions) {
    this.home = options.home ?? homedir();
    this.hostApp = options.hostApp;
    this.pluginVersion = options.pluginVersion ?? DEFAULT_PLUGIN_VERSION;
    this.toolService = options.toolService;
    this.limits = { ...DEFAULT_BRIDGE_SERVER_LIMITS, ...options.limits };
    this.log = asRedactedLog(options.log);
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.token = createBridgeToken();
    const token = this.token;
    const handler = createBridgeRequestHandler({
      bridgeId: this.bridgeId,
      token,
      hostApp: this.hostApp,
      pluginVersion: this.pluginVersion,
      toolService: this.toolService,
      log: this.log
    });
    this.server = createServer(
      {
        connectionsCheckingInterval: Math.min(30_000, Math.max(500, this.limits.headersTimeoutMs)),
        requestTimeout: this.limits.requestTimeoutMs,
        headersTimeout: this.limits.headersTimeoutMs
      },
      (request, response) => {
        void handleNodeRequest(handler, token, request, response, this.log);
      }
    );
    this.server.maxConnections = this.limits.maxConnections;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, BRIDGE_HOST, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Bridge server did not bind to a TCP port');
    }
    this.port = address.port;
    this.log.info(`Bridge listening on ${BRIDGE_HOST}:${this.port} (bridgeId=${this.bridgeId})`);

    this.publisher = new FsBridgePublisher({
      bridgeId: this.bridgeId,
      hostApp: this.hostApp,
      home: this.home
    });

    try {
      await this.publisher.publish({
        protocolVersion: AT_SERIES_PROTOCOL_VERSION,
        bridgeId: this.bridgeId,
        pluginId: AT_NACOS_PLUGIN_ID,
        pluginDisplayName: AT_NACOS_PLUGIN_DISPLAY_NAME,
        pluginVersion: this.pluginVersion,
        hostApp: this.hostApp,
        port: this.port,
        token: this.token,
        pid: process.pid,
        updatedAt: Date.now(),
        tools: AT_NACOS_TOOL_CATALOG
      });
      this.log.info(`Bridge registered with Hub at ~/.at-series/bridges/${this.hostApp}/${this.bridgeId}.json`);
    } catch (error) {
      this.log.error(`Failed to publish Bridge registry file: ${formatError(error)}`);
    }

    this.heartbeatTimer = setInterval(() => {
      this.publisher?.heartbeat().catch((error) => {
        this.log.warn(`Bridge heartbeat failed: ${formatError(error)}`);
      });
    }, BRIDGE_HEARTBEAT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.publisher) {
      try {
        await this.publisher.unpublish();
        this.log.info(`Bridge unregistered (bridgeId=${this.bridgeId})`);
      } catch (error) {
        this.log.warn(`Failed to unpublish Bridge registry file: ${formatError(error)}`);
      }
      this.publisher = undefined;
    }
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  getPort(): number | undefined {
    return this.port;
  }

  getToken(): string {
    return this.token;
  }

  getBridgeId(): string {
    return this.bridgeId;
  }
}

export function createBridgeRequestHandler(
  deps: BridgeHandlerDependencies
): (request: BridgeRequest) => Promise<BridgeResponse> {
  const log = deps.log ?? noopLog;
  const pluginDisplayName = deps.pluginDisplayName ?? AT_NACOS_PLUGIN_DISPLAY_NAME;

  return async (request: BridgeRequest): Promise<BridgeResponse> => {
    const rawToken = request.headers[AT_SERIES_TOKEN_HEADER];
    const candidateToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    if (!candidateToken || !timingSafeEqualToken(candidateToken, deps.token)) {
      return {
        status: 401,
        body: {
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid AT Series Bridge authorization token'
          }
        }
      };
    }

    if (request.method === 'GET' && request.path === '/health') {
      return {
        status: 200,
        body: {
          ok: true,
          protocolVersion: AT_SERIES_PROTOCOL_VERSION,
          bridgeId: deps.bridgeId,
          pluginId: AT_NACOS_PLUGIN_ID,
          pluginDisplayName,
          pluginVersion: deps.pluginVersion,
          hostApp: deps.hostApp
        }
      };
    }

    if (request.method === 'GET' && request.path === '/tools') {
      return {
        status: 200,
        body: {
          protocolVersion: AT_SERIES_PROTOCOL_VERSION,
          tools: AT_NACOS_TOOL_CATALOG
        }
      };
    }

    if (request.method === 'POST' && request.path === '/invoke') {
      return handleInvoke(request, deps.toolService, log);
    }

    return {
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: `Cannot ${request.method} ${request.path}`
        }
      }
    };
  };
}

async function handleInvoke(
  request: BridgeRequest,
  toolService: NacosAgentToolService | undefined,
  log: AtNacosLog
): Promise<BridgeResponse> {
  let parsedBody: unknown;
  try {
    parsedBody = request.body ? JSON.parse(request.body) : undefined;
  } catch {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Malformed JSON request body'
        }
      }
    };
  }

  if (typeof parsedBody !== 'object' || parsedBody === null || Array.isArray(parsedBody)) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a JSON object with "name" and optional "arguments"'
        }
      }
    };
  }

  const { name, arguments: args } = parsedBody as { name?: unknown; arguments?: unknown };
  if (typeof name !== 'string' || name.length === 0) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Tool name is required and must be a non-empty string'
        }
      }
    };
  }

  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Tool arguments must be a JSON object'
        }
      }
    };
  }

  const schema = BRIDGE_SCHEMAS_BY_TOOL_NAME[name];
  if (!schema) {
    return {
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: `Unknown MCP tool: ${name}`
        }
      }
    };
  }

  const validated = schema.safeParse(args ?? {});
  if (!validated.success) {
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: describeZodError(validated.error)
        }
      }
    };
  }

  if (!toolService) {
    return {
      status: 500,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Tool execution service is not available'
        }
      }
    };
  }

  try {
    const result = await toolService.invoke(name, validated.data);
    if (!result.ok) {
      const status = result.code === 'VALIDATION_ERROR' ? 400 : result.code === 'NOT_FOUND' ? 404 : 500;
      return {
        status,
        body: {
          error: {
            code: result.code,
            message: result.message
          }
        }
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        name,
        result: result.result
      }
    };
  } catch (error) {
    const message = formatError(error);
    log.error(`Bridge tool invocation exception for ${name}: ${message}`);
    return {
      status: 500,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message
        }
      }
    };
  }
}

async function handleNodeRequest(
  handler: (request: BridgeRequest) => Promise<BridgeResponse>,
  _token: string,
  request: IncomingMessage,
  response: ServerResponse,
  log: AtNacosLog
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${BRIDGE_HOST}`);
  const path = url.pathname;

  let body = '';
  let bytesReceived = 0;
  let exceeded = false;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesReceived += buffer.length;
    if (bytesReceived > BRIDGE_MAX_BODY_BYTES) {
      exceeded = true;
      break;
    }
    body += buffer.toString('utf8');
  }

  if (exceeded) {
    response.writeHead(413, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Request body exceeds maximum size of ${BRIDGE_MAX_BODY_BYTES} bytes`
        }
      })
    );
    return;
  }

  try {
    const bridgeResponse = await handler({
      method,
      path,
      headers: request.headers as Record<string, string | string[] | undefined>,
      body: body.length > 0 ? body : undefined
    });

    response.writeHead(bridgeResponse.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(bridgeResponse.body));
  } catch (error) {
    log.error(`Unhandled Bridge error: ${formatError(error)}`);
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal bridge error'
        }
      })
    );
  }
}
