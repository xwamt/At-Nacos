import type { ToolCatalogEntry } from '@at-series/mcp-hub';
import {
  NACOS_GET_CLUSTER_NODES_INPUT_SCHEMA,
  NACOS_GET_CONFIG_HISTORY_INPUT_SCHEMA,
  NACOS_GET_CONFIG_INPUT_SCHEMA,
  NACOS_GET_SERVICE_INPUT_SCHEMA,
  NACOS_LIST_CONFIG_HISTORY_INPUT_SCHEMA,
  NACOS_LIST_CONFIG_LISTENERS_INPUT_SCHEMA,
  NACOS_LIST_CONFIGS_INPUT_SCHEMA,
  NACOS_LIST_INSTANCES_INPUT_SCHEMA,
  NACOS_LIST_LISTENED_CONFIGS_INPUT_SCHEMA,
  NACOS_LIST_NAMESPACES_INPUT_SCHEMA,
  NACOS_LIST_SERVICE_INSTANCES_INPUT_SCHEMA,
  NACOS_LIST_SERVICE_SUBSCRIBERS_INPUT_SCHEMA,
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
      'List configured plugin instances (Nacos connections with "Allow Agent background access" enabled), as [{id, label, serverUrl}], not Nacos service hosts. ' +
      'Credentials are never returned. Call this first to discover valid instanceId values for other nacos_* tools.',
    risk: 'read',
    inputSchema: NACOS_LIST_INSTANCES_INPUT_SCHEMA
  },
  {
    name: 'nacos_list_namespaces',
    title: 'List Nacos namespaces',
    description:
      'List namespaces on a Nacos instance, including namespaceId, display name, description, and configCount. ' +
      'The default namespace uses an empty id on 1.x/2.x and the literal "public" on 3.x; both appear in this list.',
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
    title: 'Get Nacos service metadata',
    description:
      'Get Nacos service metadata (protect threshold, clusters, metadata), not including instance list. ' +
      'Use nacos_list_service_instances to list registered hosts. Group defaults to DEFAULT_GROUP.',
    risk: 'read',
    inputSchema: NACOS_GET_SERVICE_INPUT_SCHEMA
  },
  {
    name: 'nacos_list_service_instances',
    title: 'List Nacos service instances',
    description:
      'List registered Nacos service hosts (IP, port, health, weight, cluster, metadata) for one service. ' +
      'Group defaults to DEFAULT_GROUP. Optional cluster maps to NacosInstanceQuery.cluster. ' +
      'Distinct from nacos_list_instances, which lists configured plugin instances.',
    risk: 'read',
    inputSchema: NACOS_LIST_SERVICE_INSTANCES_INPUT_SCHEMA
  },
  {
    name: 'nacos_get_cluster_nodes',
    title: 'Get Nacos cluster nodes and metrics',
    description:
      'Get Nacos server cluster node topology, server status, raft roles, and operational metrics. ' +
      '3.x console serves nodes but has no metrics endpoint, so metrics may be omitted. ' +
      'Requires only instanceId.',
    risk: 'read',
    inputSchema: NACOS_GET_CLUSTER_NODES_INPUT_SCHEMA
  },
  {
    name: 'nacos_list_config_history',
    title: 'List Nacos configuration history',
    description:
      'List configuration history metadata (no bodies) for a group and dataId. ' +
      'Pagination defaults to pageNo 1 and pageSize 100 (max 500). ' +
      'Use nacos_get_config_history for a specific revision body.',
    risk: 'read',
    inputSchema: NACOS_LIST_CONFIG_HISTORY_INPUT_SCHEMA
  },
  {
    name: 'nacos_get_config_history',
    title: 'Get Nacos configuration history detail',
    description:
      'Get one configuration history revision by nid. ' +
      'Sensitive values (passwords, tokens, keys) are redacted by default; pass raw: true only when unredacted content is explicitly required.',
    risk: 'read',
    inputSchema: NACOS_GET_CONFIG_HISTORY_INPUT_SCHEMA
  },
  {
    name: 'nacos_list_config_listeners',
    title: 'List Nacos configuration listeners',
    description:
      'List clients currently listening to a configuration. ' +
      'aggregation defaults to true (whether to aggregate across the cluster). ' +
      'Nacos 3.x admin config-listener reads need WRITE, so the existing console fallback still applies.',
    risk: 'read',
    inputSchema: NACOS_LIST_CONFIG_LISTENERS_INPUT_SCHEMA
  },
  {
    name: 'nacos_list_listened_configs',
    title: 'List configs a client IP is listening to',
    description:
      'Reverse lookup of configs one client IP is listening to. ' +
      'aggregation defaults to true (whether to aggregate across the cluster). ' +
      'Distinct from nacos_list_config_listeners, which lists IPs for one config.',
    risk: 'read',
    inputSchema: NACOS_LIST_LISTENED_CONFIGS_INPUT_SCHEMA
  },
  {
    name: 'nacos_list_service_subscribers',
    title: 'List Nacos service subscribers',
    description:
      'List subscribers of a registered service. Group defaults to DEFAULT_GROUP. ' +
      'aggregation defaults to true (whether to aggregate across the cluster).',
    risk: 'read',
    inputSchema: NACOS_LIST_SERVICE_SUBSCRIBERS_INPUT_SCHEMA
  }
];
