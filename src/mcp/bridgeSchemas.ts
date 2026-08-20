import { z } from 'zod';
import type { JsonSchemaObject } from '@at-series/mcp-hub';

/** Agents must use the id `nacos_list_namespaces` returns; "public" is not portable. */
const NAMESPACE_ID_DESCRIPTION =
  'Optional namespace ID. Omit for the instance default (empty string on 1.x/2.x). Use the namespaceId from nacos_list_namespaces; do not send "public" on 1.x/2.x.';

const PAGE_SIZE_DESCRIPTION =
  'Page size (default 100, max 500). Larger pages cost more memory and model context; prefer filters over max pageSize.';

/**
 * Server-side input validation for every AT Nacos MCP tool (M6).
 * Every tool except `nacos_list_instances` requires `instanceId`.
 *
 * `.strict()` rejects unknown properties outright rather than silently
 * dropping them, matching `additionalProperties: false` on the JSON Schema
 * twins below.
 */
export const nacosListInstancesSchema = z.object({}).strict();

export const nacosListNamespacesSchema = z
  .object({
    instanceId: z.string().min(1)
  })
  .strict();

export const nacosListConfigsSchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    group: z.string().optional(),
    dataId: z.string().optional(),
    type: z.string().optional(),
    configTags: z.string().optional(),
    appName: z.string().optional(),
    search: z.enum(['blur', 'accurate']).optional(),
    pageNo: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(500).optional()
  })
  .strict();

export const nacosGetConfigSchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    group: z.string().min(1),
    dataId: z.string().min(1),
    raw: z.boolean().optional()
  })
  .strict();

export const nacosListServicesSchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    group: z.string().optional(),
    serviceName: z.string().optional(),
    ignoreEmptyService: z.boolean().optional(),
    pageNo: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(500).optional()
  })
  .strict();

export const nacosGetServiceSchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    group: z.string().min(1).optional(),
    serviceName: z.string().min(1)
  })
  .strict();

export const nacosListServiceInstancesSchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    group: z.string().min(1).optional(),
    serviceName: z.string().min(1),
    cluster: z.string().optional()
  })
  .strict();

export const nacosGetClusterNodesSchema = z
  .object({
    instanceId: z.string().min(1)
  })
  .strict();

export const nacosListConfigHistorySchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    group: z.string().min(1),
    dataId: z.string().min(1),
    pageNo: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(500).optional()
  })
  .strict();

export const nacosGetConfigHistorySchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    group: z.string().min(1),
    dataId: z.string().min(1),
    nid: z.string().min(1),
    raw: z.boolean().optional()
  })
  .strict();

export const nacosListConfigListenersSchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    group: z.string().min(1),
    dataId: z.string().min(1),
    aggregation: z.boolean().optional()
  })
  .strict();

export const nacosListServiceSubscribersSchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    group: z.string().min(1).optional(),
    serviceName: z.string().min(1),
    aggregation: z.boolean().optional()
  })
  .strict();

export const nacosListListenedConfigsSchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    ip: z.string().min(1),
    aggregation: z.boolean().optional()
  })
  .strict();

export type NacosListInstancesInput = z.infer<typeof nacosListInstancesSchema>;
export type NacosListNamespacesInput = z.infer<typeof nacosListNamespacesSchema>;
export type NacosListConfigsInput = z.infer<typeof nacosListConfigsSchema>;
export type NacosGetConfigInput = z.infer<typeof nacosGetConfigSchema>;
export type NacosListServicesInput = z.infer<typeof nacosListServicesSchema>;
export type NacosGetServiceInput = z.infer<typeof nacosGetServiceSchema>;
export type NacosListServiceInstancesInput = z.infer<typeof nacosListServiceInstancesSchema>;
export type NacosGetClusterNodesInput = z.infer<typeof nacosGetClusterNodesSchema>;
export type NacosListConfigHistoryInput = z.infer<typeof nacosListConfigHistorySchema>;
export type NacosGetConfigHistoryInput = z.infer<typeof nacosGetConfigHistorySchema>;
export type NacosListConfigListenersInput = z.infer<typeof nacosListConfigListenersSchema>;
export type NacosListServiceSubscribersInput = z.infer<typeof nacosListServiceSubscribersSchema>;
export type NacosListListenedConfigsInput = z.infer<typeof nacosListListenedConfigsSchema>;

export const NACOS_LIST_INSTANCES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {},
  additionalProperties: false
};

export const NACOS_LIST_NAMESPACES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID discovered via nacos_list_instances.'
    }
  },
  required: ['instanceId'],
  additionalProperties: false
};

export const NACOS_LIST_CONFIGS_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    },
    namespaceId: {
      type: 'string',
      description: NAMESPACE_ID_DESCRIPTION
    },
    group: {
      type: 'string',
      description:
        'Optional group forwarded to Nacos as-is. In blur mode, `*` is a wildcard per official Nacos rules.'
    },
    dataId: {
      type: 'string',
      description:
        'Optional dataId forwarded to Nacos as-is. In blur mode, `*` is a wildcard per official Nacos rules.'
    },
    type: {
      type: 'string',
      description: 'Optional configuration type filter (for example yaml, json, text).'
    },
    configTags: {
      type: 'string',
      description: 'Optional configuration tags forwarded to Nacos as-is.'
    },
    appName: {
      type: 'string',
      description: 'Optional application name forwarded to Nacos as-is.'
    },
    search: {
      type: 'string',
      enum: ['blur', 'accurate'],
      description:
        'Nacos list search mode: blur (prefix/suffix `*` wildcards allowed) or accurate. Omit for accurate (this plugin default, not official blur).'
    },
    pageNo: {
      type: 'integer',
      minimum: 1,
      description: 'Page number (default 1).'
    },
    pageSize: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: PAGE_SIZE_DESCRIPTION
    }
  },
  required: ['instanceId'],
  additionalProperties: false
};

export const NACOS_GET_CONFIG_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    },
    namespaceId: {
      type: 'string',
      description: NAMESPACE_ID_DESCRIPTION
    },
    group: {
      type: 'string',
      description: 'Configuration group name.'
    },
    dataId: {
      type: 'string',
      description: 'Configuration data ID.'
    },
    raw: {
      type: 'boolean',
      description: 'Whether to return raw unredacted content (default false: sensitive keywords are masked).'
    }
  },
  required: ['instanceId', 'group', 'dataId'],
  additionalProperties: false
};

export const NACOS_LIST_SERVICES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    },
    namespaceId: {
      type: 'string',
      description: NAMESPACE_ID_DESCRIPTION
    },
    group: {
      type: 'string',
      description:
        'Optional group forwarded as official groupNameParam (prefix/suffix match). Omit or blank means every group.'
    },
    serviceName: {
      type: 'string',
      description:
        'Optional service name forwarded as official serviceNameParam (prefix/suffix match). Blank means no name filter.'
    },
    ignoreEmptyService: {
      type: 'boolean',
      description:
        'When true, hide services that have no instances (MCP default true). withInstances is never exposed.'
    },
    pageNo: {
      type: 'integer',
      minimum: 1,
      description: 'Page number (default 1).'
    },
    pageSize: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: PAGE_SIZE_DESCRIPTION
    }
  },
  required: ['instanceId'],
  additionalProperties: false
};

export const NACOS_GET_SERVICE_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    },
    namespaceId: {
      type: 'string',
      description: NAMESPACE_ID_DESCRIPTION
    },
    group: {
      type: 'string',
      description: 'Optional service group name (defaults to DEFAULT_GROUP).'
    },
    serviceName: {
      type: 'string',
      description: 'Service name.'
    }
  },
  required: ['instanceId', 'serviceName'],
  additionalProperties: false
};

export const NACOS_LIST_SERVICE_INSTANCES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    },
    namespaceId: {
      type: 'string',
      description: NAMESPACE_ID_DESCRIPTION
    },
    group: {
      type: 'string',
      description: 'Optional service group name (defaults to DEFAULT_GROUP).'
    },
    serviceName: {
      type: 'string',
      description: 'Service name whose registered hosts should be listed.'
    },
    cluster: {
      type: 'string',
      description: 'Optional cluster of the service. Omit to list hosts in every cluster.'
    }
  },
  required: ['instanceId', 'serviceName'],
  additionalProperties: false
};

export const NACOS_GET_CLUSTER_NODES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    }
  },
  required: ['instanceId'],
  additionalProperties: false
};

export const NACOS_LIST_CONFIG_HISTORY_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    },
    namespaceId: {
      type: 'string',
      description: NAMESPACE_ID_DESCRIPTION
    },
    group: {
      type: 'string',
      description: 'Configuration group name.'
    },
    dataId: {
      type: 'string',
      description: 'Configuration data ID.'
    },
    pageNo: {
      type: 'integer',
      minimum: 1,
      description: 'Page number (default 1).'
    },
    pageSize: {
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: PAGE_SIZE_DESCRIPTION
    }
  },
  required: ['instanceId', 'group', 'dataId'],
  additionalProperties: false
};

export const NACOS_GET_CONFIG_HISTORY_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    },
    namespaceId: {
      type: 'string',
      description: NAMESPACE_ID_DESCRIPTION
    },
    group: {
      type: 'string',
      description: 'Configuration group name.'
    },
    dataId: {
      type: 'string',
      description: 'Configuration data ID.'
    },
    nid: {
      type: 'string',
      description: 'History revision id (nid).'
    },
    raw: {
      type: 'boolean',
      description: 'Whether to return raw unredacted content (default false: sensitive keywords are masked).'
    }
  },
  required: ['instanceId', 'group', 'dataId', 'nid'],
  additionalProperties: false
};

export const NACOS_LIST_CONFIG_LISTENERS_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    },
    namespaceId: {
      type: 'string',
      description: NAMESPACE_ID_DESCRIPTION
    },
    group: {
      type: 'string',
      description: 'Configuration group name.'
    },
    dataId: {
      type: 'string',
      description: 'Configuration data ID.'
    },
    aggregation: {
      type: 'boolean',
      description: 'Whether to aggregate listeners across the Nacos cluster (default true).'
    }
  },
  required: ['instanceId', 'group', 'dataId'],
  additionalProperties: false
};

export const NACOS_LIST_SERVICE_SUBSCRIBERS_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    },
    namespaceId: {
      type: 'string',
      description: NAMESPACE_ID_DESCRIPTION
    },
    group: {
      type: 'string',
      description: 'Optional service group name (defaults to DEFAULT_GROUP).'
    },
    serviceName: {
      type: 'string',
      description: 'Service name whose subscribers should be listed.'
    },
    aggregation: {
      type: 'boolean',
      description: 'Whether to aggregate subscribers across the Nacos cluster (default true).'
    }
  },
  required: ['instanceId', 'serviceName'],
  additionalProperties: false
};

export const NACOS_LIST_LISTENED_CONFIGS_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: {
      type: 'string',
      description: 'Nacos instance ID.'
    },
    namespaceId: {
      type: 'string',
      description: NAMESPACE_ID_DESCRIPTION
    },
    ip: {
      type: 'string',
      description: 'Client IP whose listened configurations should be listed.'
    },
    aggregation: {
      type: 'boolean',
      description: 'Whether to aggregate listened configs across the Nacos cluster (default true).'
    }
  },
  required: ['instanceId', 'ip'],
  additionalProperties: false
};

export const BRIDGE_SCHEMAS_BY_TOOL_NAME: Record<string, z.ZodTypeAny> = {
  nacos_list_instances: nacosListInstancesSchema,
  nacos_list_namespaces: nacosListNamespacesSchema,
  nacos_list_configs: nacosListConfigsSchema,
  nacos_get_config: nacosGetConfigSchema,
  nacos_list_services: nacosListServicesSchema,
  nacos_get_service: nacosGetServiceSchema,
  nacos_list_service_instances: nacosListServiceInstancesSchema,
  nacos_get_cluster_nodes: nacosGetClusterNodesSchema,
  nacos_list_config_history: nacosListConfigHistorySchema,
  nacos_get_config_history: nacosGetConfigHistorySchema,
  nacos_list_config_listeners: nacosListConfigListenersSchema,
  nacos_list_listened_configs: nacosListListenedConfigsSchema,
  nacos_list_service_subscribers: nacosListServiceSubscribersSchema
};

export function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
