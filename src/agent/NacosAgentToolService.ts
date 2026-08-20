import type { z } from 'zod';
import type { NacosInstanceConfigManager } from '../config/NacosInstanceConfigManager';
import type { NacosInstanceConfig } from '../config/schema';
import type { NacosCertTrustStore, NacosCertVerifier } from '../nacos/NacosCertTrustStore';
import type { NacosClient } from '../nacos/NacosClient';
import { formatError } from '../utils/errors';
import type { AtNacosLog } from '../utils/logger';
import { redactSensitiveText } from '../utils/redaction';
import {
  describeZodError,
  nacosGetClusterNodesSchema,
  nacosGetConfigSchema,
  nacosGetServiceSchema,
  nacosListConfigsSchema,
  nacosListInstancesSchema,
  nacosListNamespacesSchema,
  nacosListServicesSchema,
  type NacosGetClusterNodesInput,
  type NacosGetConfigInput,
  type NacosGetServiceInput,
  type NacosListConfigsInput,
  type NacosListInstancesInput,
  type NacosListNamespacesInput,
  type NacosListServicesInput
} from '../mcp/bridgeSchemas';

export type NacosApiClientLike = Pick<
  NacosClient,
  | 'listNamespaces'
  | 'listConfigs'
  | 'getConfig'
  | 'listServices'
  | 'getService'
  | 'listClusterNodes'
  | 'getServerMetrics'
>;

export type NacosAgentClientFactory = (
  instance: NacosInstanceConfig,
  certVerifier: NacosCertVerifier
) => Promise<NacosApiClientLike>;

export type ToolInvokeErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTERNAL_ERROR' | 'UNAVAILABLE';

export interface ToolInvokeSuccess {
  ok: true;
  result: unknown;
}

export interface ToolInvokeFailure {
  ok: false;
  code: ToolInvokeErrorCode;
  message: string;
}

export type ToolInvokeResult = ToolInvokeSuccess | ToolInvokeFailure;

export interface NacosAgentToolServiceDependencies {
  configManager: Pick<NacosInstanceConfigManager, 'listInstances' | 'getInstance'>;
  certTrustStore: NacosCertTrustStore;
  createClient: NacosAgentClientFactory;
  log?: AtNacosLog;
}

export class NacosAgentToolService {
  private readonly configManager: Pick<NacosInstanceConfigManager, 'listInstances' | 'getInstance'>;
  private readonly certTrustStore: NacosCertTrustStore;
  private readonly createClient: NacosAgentClientFactory;
  private readonly log?: AtNacosLog;

  constructor(deps: NacosAgentToolServiceDependencies) {
    this.configManager = deps.configManager;
    this.certTrustStore = deps.certTrustStore;
    this.createClient = deps.createClient;
    this.log = deps.log;
  }

  async invoke(name: string, args: unknown): Promise<ToolInvokeResult> {
    switch (name) {
      case 'nacos_list_instances':
        return this.handleParsed(nacosListInstancesSchema, args, (input) => this.listInstances(input));
      case 'nacos_list_namespaces':
        return this.handleParsed(nacosListNamespacesSchema, args, (input) => this.listNamespaces(input));
      case 'nacos_list_configs':
        return this.handleParsed(nacosListConfigsSchema, args, (input) => this.listConfigs(input));
      case 'nacos_get_config':
        return this.handleParsed(nacosGetConfigSchema, args, (input) => this.getConfig(input));
      case 'nacos_list_services':
        return this.handleParsed(nacosListServicesSchema, args, (input) => this.listServices(input));
      case 'nacos_get_service':
        return this.handleParsed(nacosGetServiceSchema, args, (input) => this.getService(input));
      case 'nacos_get_cluster_nodes':
        return this.handleParsed(nacosGetClusterNodesSchema, args, (input) => this.getClusterNodes(input));
      default:
        return {
          ok: false,
          code: 'NOT_FOUND',
          message: `Unknown MCP tool: ${name}`
        };
    }
  }

  private async handleParsed<T>(
    schema: z.ZodType<T>,
    args: unknown,
    handler: (input: T) => Promise<ToolInvokeResult>
  ): Promise<ToolInvokeResult> {
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: describeZodError(parsed.error)
      };
    }
    try {
      return await handler(parsed.data);
    } catch (error) {
      const message = formatError(error);
      this.log?.error(`Tool invocation failed: ${message}`);
      return {
        ok: false,
        code: 'INTERNAL_ERROR',
        message
      };
    }
  }

  private async resolveInstance(instanceId: string): Promise<
    | { ok: true; instance: NacosInstanceConfig; client: NacosApiClientLike }
    | { ok: false; failure: ToolInvokeFailure }
  > {
    const instance = await this.configManager.getInstance(instanceId);
    if (!instance) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: 'NOT_FOUND',
          message: `Nacos instance not found: ${instanceId}`
        }
      };
    }
    if (!instance.allowBackgroundAccess) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: 'UNAVAILABLE',
          message: `Nacos instance ${instance.label} (${instanceId}) does not allow background Agent access.`
        }
      };
    }

    const certTrustStore = this.certTrustStore;
    const certVerifier: NacosCertVerifier = {
      async verify(host: string, port: number, fingerprint: string): Promise<boolean> {
        const status = await certTrustStore.check(host, port, fingerprint);
        return status === 'trusted';
      }
    };

    const client = await this.createClient(instance, certVerifier);
    return { ok: true, instance, client };
  }

  private async listInstances(_input: NacosListInstancesInput): Promise<ToolInvokeResult> {
    const all = await this.configManager.listInstances();
    const allowed = all.filter((inst) => inst.allowBackgroundAccess);
    return {
      ok: true,
      result: {
        instances: allowed.map((inst) => ({
          id: inst.id,
          label: inst.label,
          serverUrl: inst.serverUrl
        }))
      }
    };
  }

  private async listNamespaces(input: NacosListNamespacesInput): Promise<ToolInvokeResult> {
    const resolved = await this.resolveInstance(input.instanceId);
    if (!resolved.ok) {
      return resolved.failure;
    }
    const namespaces = await resolved.client.listNamespaces();
    return {
      ok: true,
      result: { namespaces }
    };
  }

  private async listConfigs(input: NacosListConfigsInput): Promise<ToolInvokeResult> {
    const resolved = await this.resolveInstance(input.instanceId);
    if (!resolved.ok) {
      return resolved.failure;
    }
    const page = await resolved.client.listConfigs({
      namespaceId: input.namespaceId ?? '',
      group: input.group,
      dataId: input.dataId,
      searchMode: input.search,
      type: input.type,
      configTags: input.configTags,
      appName: input.appName,
      pageNo: input.pageNo ?? 1,
      pageSize: input.pageSize ?? 100
    });
    const items = page.items.map((item) => {
      const { content: _content, ...rest } = item as typeof item & { content?: string };
      return rest;
    });
    return {
      ok: true,
      result: {
        totalCount: page.totalCount,
        pageNo: input.pageNo ?? 1,
        pageSize: input.pageSize ?? 100,
        items
      }
    };
  }

  private async getConfig(input: NacosGetConfigInput): Promise<ToolInvokeResult> {
    const resolved = await this.resolveInstance(input.instanceId);
    if (!resolved.ok) {
      return resolved.failure;
    }
    const detail = await resolved.client.getConfig({
      namespaceId: input.namespaceId ?? '',
      group: input.group,
      dataId: input.dataId
    });

    if (!detail) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: `Configuration not found: group=${input.group}, dataId=${input.dataId}`
      };
    }

    const isRaw = input.raw === true;
    const content = isRaw ? detail.content : redactSensitiveText(detail.content);

    return {
      ok: true,
      result: {
        ...detail,
        content,
        isRedacted: !isRaw
      }
    };
  }

  private async listServices(input: NacosListServicesInput): Promise<ToolInvokeResult> {
    const resolved = await this.resolveInstance(input.instanceId);
    if (!resolved.ok) {
      return resolved.failure;
    }
    const page = await resolved.client.listServices({
      namespaceId: input.namespaceId ?? '',
      group: input.group,
      pageNo: input.pageNo ?? 1,
      pageSize: input.pageSize ?? 100
    });

    return {
      ok: true,
      result: {
        totalCount: page.totalCount,
        count: page.items.length,
        services: page.items
      }
    };
  }

  private async getService(input: NacosGetServiceInput): Promise<ToolInvokeResult> {
    const resolved = await this.resolveInstance(input.instanceId);
    if (!resolved.ok) {
      return resolved.failure;
    }
    const detail = await resolved.client.getService({
      namespaceId: input.namespaceId ?? '',
      group: input.group,
      serviceName: input.serviceName
    });

    if (!detail) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: `Service not found: group=${input.group}, serviceName=${input.serviceName}`
      };
    }

    return {
      ok: true,
      result: detail
    };
  }

  private async getClusterNodes(input: NacosGetClusterNodesInput): Promise<ToolInvokeResult> {
    const resolved = await this.resolveInstance(input.instanceId);
    if (!resolved.ok) {
      return resolved.failure;
    }
    const nodes = await resolved.client.listClusterNodes().catch(() => []);
    const metrics = await resolved.client.getServerMetrics().catch(() => undefined);

    return {
      ok: true,
      result: {
        nodes,
        metrics
      }
    };
  }
}
