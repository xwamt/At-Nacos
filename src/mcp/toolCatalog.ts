import type { ToolCatalogEntry } from '@at-series/mcp-hub';
import {
  NACOS_GET_CLUSTER_NODES_INPUT_SCHEMA,
  NACOS_GET_CONFIG_INPUT_SCHEMA,
  NACOS_GET_SERVICE_INPUT_SCHEMA,
  NACOS_LIST_CONFIGS_INPUT_SCHEMA,
  NACOS_LIST_INSTANCES_INPUT_SCHEMA,
  NACOS_LIST_NAMESPACES_INPUT_SCHEMA,
  NACOS_LIST_SERVICES_INPUT_SCHEMA
} from './bridgeSchemas';

/**
 * Stable reverse-domain plugin ID (AT Series Hub Protocol v1 §4.2).
 */
export const AT_NACOS_PLUGIN_ID = 'at.nacos' as const;

export const AT_NACOS_TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: 'nacos_list_instances',
    title: 'List Nacos instances',
    description:
      'List configured Nacos instances that have "Allow Agent background access" enabled, as [{id, label, serverUrl}]. ' +
      'Credentials are never returned. Call this first to discover valid instanceId values for other nacos_* tools.',
    risk: 'read',
    inputSchema: NACOS_LIST_INSTANCES_INPUT_SCHEMA
  },
  {
    name: 'nacos_list_namespaces',
    title: 'List Nacos namespaces',
    description:
      'List namespaces available on a Nacos instance, including namespaceId, namespaceName, description, and configCount.',
    risk: 'read',
    inputSchema: NACOS_LIST_NAMESPACES_INPUT_SCHEMA
  },
  {
    name: 'nacos_list_configs',
    title: 'List Nacos configurations',
    description:
      'List configuration metadata (no bodies). Filters run on the Nacos server. ' +
      'Use nacos_get_config for configuration content.',
    risk: 'read',
    inputSchema: NACOS_LIST_CONFIGS_INPUT_SCHEMA
  },
  {
    name: 'nacos_get_config',
    title: 'Get Nacos configuration detail',
    description:
      'Get detailed information and content of a specific Nacos configuration by group and dataId. ' +
      'Sensitive values (passwords, tokens, keys) are redacted by default; pass raw: true only when unredacted content is explicitly required.',
    risk: 'read',
    inputSchema: NACOS_GET_CONFIG_INPUT_SCHEMA
  },
  {
    name: 'nacos_list_services',
    title: 'List Nacos registered services',
    description:
      'List registered services on a Nacos instance with healthy and total instance counts. ' +
      'Optional serviceName maps to official serviceNameParam (prefix/suffix). ' +
      'Empty services are hidden by default (ignoreEmptyService); withInstances is never exposed.',
    risk: 'read',
    inputSchema: NACOS_LIST_SERVICES_INPUT_SCHEMA
  },
  {
    name: 'nacos_get_service',
    title: 'Get Nacos service and instance details',
    description:
      'Get detailed service information along with its registered service instances (IP, port, health, weight, cluster, metadata).',
    risk: 'read',
    inputSchema: NACOS_GET_SERVICE_INPUT_SCHEMA
  },
  {
    name: 'nacos_get_cluster_nodes',
    title: 'Get Nacos cluster nodes and metrics',
    description:
      'Get Nacos server cluster node topology, server status, raft roles, and operational metrics.',
    risk: 'read',
    inputSchema: NACOS_GET_CLUSTER_NODES_INPUT_SCHEMA
  }
];
