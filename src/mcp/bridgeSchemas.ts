import { z } from 'zod';
import type { JsonSchemaObject } from '@at-series/mcp-hub';

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
    group: z.string().min(1),
    serviceName: z.string().min(1)
  })
  .strict();

export const nacosGetClusterNodesSchema = z
  .object({
    instanceId: z.string().min(1)
  })
  .strict();

export type NacosListInstancesInput = z.infer<typeof nacosListInstancesSchema>;
export type NacosListNamespacesInput = z.infer<typeof nacosListNamespacesSchema>;
export type NacosListConfigsInput = z.infer<typeof nacosListConfigsSchema>;
export type NacosGetConfigInput = z.infer<typeof nacosGetConfigSchema>;
export type NacosListServicesInput = z.infer<typeof nacosListServicesSchema>;
export type NacosGetServiceInput = z.infer<typeof nacosGetServiceSchema>;
export type NacosGetClusterNodesInput = z.infer<typeof nacosGetClusterNodesSchema>;

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
      description: 'Optional namespace ID (defaults to public namespace).'
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
      description: 'Nacos list search mode: blur (prefix/suffix `*` wildcards allowed) or accurate.'
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
      description: 'Page size (default 100, max 500).'
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
      description: 'Optional namespace ID (defaults to public namespace).'
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
      description: 'Optional namespace ID.'
    },
    group: {
      type: 'string',
      description: 'Optional group name.'
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
      description: 'Page size (default 100, max 500).'
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
      description: 'Optional namespace ID.'
    },
    group: {
      type: 'string',
      description: 'Service group name.'
    },
    serviceName: {
      type: 'string',
      description: 'Service name.'
    }
  },
  required: ['instanceId', 'group', 'serviceName'],
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

export const BRIDGE_SCHEMAS_BY_TOOL_NAME: Record<string, z.ZodTypeAny> = {
  nacos_list_instances: nacosListInstancesSchema,
  nacos_list_namespaces: nacosListNamespacesSchema,
  nacos_list_configs: nacosListConfigsSchema,
  nacos_get_config: nacosGetConfigSchema,
  nacos_list_services: nacosListServicesSchema,
  nacos_get_service: nacosGetServiceSchema,
  nacos_get_cluster_nodes: nacosGetClusterNodesSchema
};

export function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
