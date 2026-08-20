# AT Nacos —— 对齐官方 MCP 工具面 实现计划

> **Status:** 已在 `feat/nacos-mcp-official-alignment` 落地（文档提交起算含 13 工具目录）。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `at.nacos` 的 MCP 只读工具面对齐 [nacos-group/nacos-mcp-server](https://github.com/nacos-group/nacos-mcp-server) 的 Admin API 切分与查询语义，同时保留多版本 Driver、Bearer、脱敏和集群节点这些产品优势。

**Architecture:** 查询参数下推到已有 Driver（树视图调用方式不变）；MCP 一层只做 schema、默认值、脱敏和工具描述。不把官方 Python 代理的 3.x-only、`AccessToken` 头、明文 HTTP 抄进来。界面可写、MCP 只读这条边界不变。

**Tech Stack:** TypeScript 5.9 strict、vitest、zod、`@at-series/mcp-hub`、现有 `NacosDriver` 四条 flavor 链。

**规格真源：**

- 对照结论：聊天中的官方仓库分析；画布 [nacos-mcp-official-compare.canvas.tsx](/Users/clkj/.cursor/projects/Users-clkj-at/canvases/nacos-mcp-official-compare.canvas.tsx)
- 领域层：`docs/plans/2026-08-13-at-nacos-architecture.md`
- 官方工具与路径：nacos-mcp-server v0.1.2 `src/mcp_server_nacos/nacos_tools.py`

---

## 非目标（不要做）

- 不改成只打 `/nacos/v3/admin/*`。1.x/2.x 与 console 降级保留。
- 不改鉴权头为 `AccessToken`。继续 `Authorization: Bearer`。
- 不把写操作暴露给 MCP。
- 不重命名 `nacos_list_instances`（它列出的是插件里的 Nacos 连接）。服务实例用新名字 `nacos_list_service_instances`。
- 不为了「工具变多」去改 Hub 协议。Hub v2 的 `at_search_tools` / `at_select_tools` 就是为这种目录设计的。

---

## 完成后的 MCP 目录（13 个，全部 `risk: 'read'`）

| 工具名 | 来源 | 本计划动作 |
|---|---|---|
| `nacos_list_instances` | 已有 | 描述写明是插件实例 |
| `nacos_list_namespaces` | 已有 | 描述补默认命名空间语义 |
| `nacos_list_configs` | 已有 | 过滤下推服务端；结果不含 `content` |
| `nacos_get_config` | 已有 | 保留默认脱敏 |
| `nacos_list_services` | 已有 | 补 `serviceName` / `ignoreEmptyService` |
| `nacos_get_service` | 已有 | 改描述（不含实例）；`group` 默认 `DEFAULT_GROUP` |
| `nacos_get_cluster_nodes` | 已有 | 保留 |
| `nacos_list_service_instances` | 新增 | 包装已有 `listInstances` |
| `nacos_list_service_subscribers` | 新增 | 包装已有 `listSubscribers`，带 `aggregation` |
| `nacos_list_config_history` | 新增 | 包装已有 `listConfigHistory` |
| `nacos_get_config_history` | 新增 | 包装已有 `getConfigHistory`，同样脱敏 |
| `nacos_list_config_listeners` | 新增 | 包装已有 `listConfigListeners`，带 `aggregation` |
| `nacos_list_listened_configs` | 新增 | 新 Driver 能力 + MCP |

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/nacos/driver/NacosDriver.ts` | `NacosConfigListQuery` / `NacosServiceListQuery` 加字段；`configListParams`；`NacosListenerQuery` / `NacosSubscriberQuery` / `NacosListenedConfigQuery`；Driver 接口加 `listListenedConfigs` |
| `src/nacos/driver/normalize.ts` | `configTagsParamName`；`NacosListenedConfig`；`normalizeListenedConfigs` |
| `src/nacos/driver/history.ts` | `fetchConfigListeners` 传 `aggregation`；新增 `fetchListenedConfigs` |
| `src/nacos/driver/naming.ts` | `countedServiceParams` 加 `serviceNameParam` 与 `ignoreEmptyService`；`fetchSubscribers` 传 `aggregation` |
| `src/nacos/driver/V1Driver.ts` `V2Driver.ts` `V3AdminDriver.ts` `V3ConsoleDriver.ts` | 实现新方法；v1/v2 反查走 `/v1/cs/listener` |
| `src/nacos/NacosClient.ts` | 门面加 `listListenedConfigs`；listeners/subscribers 接受带可选 `aggregation` 的 query |
| `src/nacos/NacosCapabilityResolver.ts` | 能力联合加上 `'listened-configs'` |
| `src/mcp/bridgeSchemas.ts` | 全部工具的 zod + JSON Schema |
| `src/mcp/toolCatalog.ts` | 13 条目录与描述 |
| `src/agent/NacosAgentToolService.ts` | 调用映射；列表去掉 `content`；`DEFAULT_GROUP` 默认值 |
| `docs/plans/2026-08-13-at-nacos-architecture.md` | §3 MCP 行从「约 7 个」改为 13 个只读工具 |

树视图（`ConfigTreeProvider.fetchPage`、`ServiceTreeProvider`）**不改调用形状**：继续只传现在那几个字段，新字段保持 optional，缺省行为与今天一致。

---

### Task 1: 配置列表过滤下推 Driver

**Files:**

- Modify: `src/nacos/driver/NacosDriver.ts`（`NacosConfigListQuery`、`configListParams`）
- Modify: `src/nacos/driver/normalize.ts`（`configTagsParamName`）
- Test: `test/nacos/driver/configDrivers.test.ts`（现有 `DRIVER_CASES` 循环内追加）
- Test: `test/nacos/driver/normalize.test.ts`

查询契约（锁定，后面任务必须沿用这些名字）：

```ts
export interface NacosConfigListQuery {
  namespaceId: string;
  pageNo: number;
  pageSize: number;
  /**
   * 树过滤器：有值则 blur，并把该字符串包成 `*term*` 作为 dataId。
   * 仅当 `dataId` 未设时生效，避免和 MCP 的精确/通配 dataId 抢同一参数。
   */
  search?: string;
  group?: string;
  dataId?: string;
  /** 未设时：有树 `search` 则 blur，否则 accurate（与今天无过滤列举相同）。 */
  searchMode?: 'accurate' | 'blur';
  type?: string;
  configTags?: string;
  appName?: string;
}
```

`configListParams` 规则：

1. `group` 缺省仍发空串（v1 的 `@RequestParam` 不能省略）。
2. `dataId` 已设 → 原样发送，**不再**包 `*`。
3. `dataId` 未设且 `search` 有字 → `dataId=*${term}*`，`search=blur`（除非 `searchMode` 显式覆盖）。
4. 两者都无 → `dataId=`、`search=accurate`（保持现有测试）。
5. `type` / `appName` / `configTags` 只在有值时出现在 query 里。
6. v1 配置标签参数名是 `config_tags`，v2 路径也走 v1 方言；v3 是 `configTags`。

- [ ] **Step 1: 写会失败的参数名测试**

在 `test/nacos/driver/normalize.test.ts` 的 `groupParamName` describe 旁追加：

```ts
import { configTagsParamName } from '../../../src/nacos/driver/normalize';

describe('configTagsParamName', () => {
  it('uses the v1 underscore spelling on v1 config endpoints', () => {
    expect(configTagsParamName('v1')).toBe('config_tags');
  });

  it('uses camelCase from v2 onward, including both 3.x flavors', () => {
    expect(configTagsParamName('v2')).toBe('configTags');
    expect(configTagsParamName('v3-admin')).toBe('configTags');
    expect(configTagsParamName('v3-console')).toBe('configTags');
  });
});
```

在 `test/nacos/driver/configDrivers.test.ts` 的 `DRIVER_CASES` 循环里、现有「wraps the term in wildcards」用例之后追加：

```ts
it('sends a caller-supplied group instead of an empty one', async () => {
  const { requests } = await drive(
    driverCase,
    respondWith(200, wrap(REAL_ACCURATE_PAGE)),
    (driver) =>
      driver.listConfigs({
        namespaceId: NAMESPACE_ID,
        pageNo: 1,
        pageSize: 100,
        group: GROUP,
        dataId: DATA_ID,
        searchMode: 'accurate'
      })
  );
  const query = queryOf(requests[0]?.url ?? '');
  expect(query.get(groupParam)).toBe(GROUP);
  expect(query.get('dataId')).toBe(DATA_ID);
  expect(query.get('search')).toBe('accurate');
});

it('does not wrap an explicit dataId in wildcards', async () => {
  const { requests } = await drive(
    driverCase,
    respondWith(200, wrap(REAL_BLUR_PAGE)),
    (driver) =>
      driver.listConfigs({
        namespaceId: NAMESPACE_ID,
        pageNo: 1,
        pageSize: 100,
        dataId: 'app.yaml',
        searchMode: 'blur'
      })
  );
  expect(queryOf(requests[0]?.url ?? '').get('dataId')).toBe('app.yaml');
});

it('still wraps the tree search term when dataId is omitted', async () => {
  const { requests } = await drive(
    driverCase,
    respondWith(200, wrap(REAL_BLUR_PAGE)),
    (driver) =>
      driver.listConfigs({
        namespaceId: NAMESPACE_ID,
        pageNo: 1,
        pageSize: 100,
        search: 'uat'
      })
  );
  const query = queryOf(requests[0]?.url ?? '');
  expect(query.get('search')).toBe('blur');
  expect(query.get('dataId')).toBe('*uat*');
});

it('sends type, appName and the dialect-correct tags parameter only when set', async () => {
  const { requests } = await drive(
    driverCase,
    respondWith(200, wrap(REAL_ACCURATE_PAGE)),
    (driver) =>
      driver.listConfigs({
        namespaceId: NAMESPACE_ID,
        pageNo: 1,
        pageSize: 100,
        type: 'yaml',
        appName: 'order',
        configTags: 'prod,core'
      })
  );
  const query = queryOf(requests[0]?.url ?? '');
  expect(query.get('type')).toBe('yaml');
  expect(query.get('appName')).toBe('order');
  const tagName = groupParam === 'group' ? 'config_tags' : 'configTags';
  const otherTag = tagName === 'config_tags' ? 'configTags' : 'config_tags';
  expect(query.get(tagName)).toBe('prod,core');
  expect(query.has(otherTag)).toBe(false);
});
```

`groupParam` 已在该循环里从 `driverCase.groupParam` 解构。v1/v2 的 `groupParam === 'group'`，v3 为 `'groupName'`。

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/nacos/driver/normalize.test.ts test/nacos/driver/configDrivers.test.ts
```

Expected: FAIL，`configTagsParamName` is not exported；新 list 用例里 `group` 仍是 `''`、`dataId` 仍是 `''`。

- [ ] **Step 3: 最小实现**

`normalize.ts`，紧挨 `groupParamName`：

```ts
export function configTagsParamName(flavor: NacosApiFlavor): 'config_tags' | 'configTags' {
  return flavor === 'v1' ? 'config_tags' : 'configTags';
}
```

`NacosDriver.ts` 里扩展 `NacosConfigListQuery`（按本任务顶部的接口），并把 `configListParams` 换成：

```ts
function configListParams(flavor: NacosApiFlavor, query: NacosConfigListQuery): Record<string, string> {
  const term = query.search?.trim();
  const searchMode = query.searchMode ?? (term ? 'blur' : 'accurate');
  const dataId = query.dataId !== undefined ? query.dataId : term ? `*${term}*` : '';
  const params: Record<string, string> = {
    search: searchMode,
    dataId,
    [groupParamName(flavor, 'config')]: query.group ?? '',
    [namespaceParamName(flavor, 'config')]: query.namespaceId,
    pageNo: String(query.pageNo),
    pageSize: String(query.pageSize)
  };
  if (query.type) {
    params.type = query.type;
  }
  if (query.appName) {
    params.appName = query.appName;
  }
  if (query.configTags) {
    params[configTagsParamName(flavor)] = query.configTags;
  }
  return params;
}
```

在 `NacosDriver.ts` 增加 `configTagsParamName` 的 import。更新 `NacosConfigListQuery` 上方那句「Neither the search mode nor the wildcards are the caller's business」——MCP 现在需要显式 `searchMode`，树仍然不需要。

- [ ] **Step 4: 再跑测试确认通过**

```bash
npx vitest run test/nacos/driver/normalize.test.ts test/nacos/driver/configDrivers.test.ts
```

Expected: PASS。现有「empty dataId and group when no term」与「wraps the term」两条必须仍然绿。

- [ ] **Step 5: Commit**

```bash
git add src/nacos/driver/NacosDriver.ts src/nacos/driver/normalize.ts test/nacos/driver/normalize.test.ts test/nacos/driver/configDrivers.test.ts
git commit -m "$(cat <<'EOF'
feat(nacos): push config list filters to the server

Let callers set group, dataId, searchMode, type, tags and appName
on the wire so MCP does not have to filter a page locally.
EOF
)"
```

---

### Task 2: MCP `nacos_list_configs` 使用服务端过滤并丢掉 content

**Files:**

- Modify: `src/mcp/bridgeSchemas.ts`
- Modify: `src/mcp/toolCatalog.ts`
- Modify: `src/agent/NacosAgentToolService.ts`（`listConfigs`）
- Test: `test/mcp/bridgeSchemas.test.ts`
- Test: `test/agent/NacosAgentToolService.test.ts`

官方语义：`search` 是 `blur|accurate`（默认 blur）；`groupName`/`dataId`/`type`/`configTags`/`appName` 原样给服务端。AT 工具参数名继续用 `group`（领域模型），不要改成 `groupName` 以免和树/Driver 分裂。

- [ ] **Step 1: 写会失败的 schema 与 handler 测试**

替换 `test/mcp/bridgeSchemas.test.ts` 里 `nacosListConfigsSchema validates...`：

```ts
it('nacosListConfigsSchema accepts official list filters and rejects a bad search mode', () => {
  expect(
    nacosListConfigsSchema.safeParse({
      instanceId: 'inst-1',
      namespaceId: 'dev',
      group: 'DEFAULT_GROUP',
      dataId: 'app.yaml',
      type: 'yaml',
      configTags: 'prod',
      appName: 'order',
      search: 'accurate',
      pageNo: 1,
      pageSize: 50
    }).success
  ).toBe(true);
  expect(nacosListConfigsSchema.safeParse({ instanceId: 'inst-1', search: 'fuzzy' }).success).toBe(false);
  expect(nacosListConfigsSchema.safeParse({ instanceId: 'inst-1', pageSize: 501 }).success).toBe(false);
});
```

替换 `test/agent/NacosAgentToolService.test.ts` 里 `nacos_list_configs redacts...`：

```ts
it('nacos_list_configs forwards filters to the client and omits content', async () => {
  const { service, client } = createMockDeps();
  const res = await service.invoke('nacos_list_configs', {
    instanceId: 'inst-allowed',
    namespaceId: 'dev',
    group: 'DEFAULT_GROUP',
    dataId: 'db.yaml',
    search: 'accurate',
    type: 'yaml',
    appName: 'order',
    configTags: 'prod'
  });
  expect(res.ok).toBe(true);
  expect(client.listConfigs).toHaveBeenCalledWith({
    namespaceId: 'dev',
    group: 'DEFAULT_GROUP',
    dataId: 'db.yaml',
    searchMode: 'accurate',
    type: 'yaml',
    appName: 'order',
    configTags: 'prod',
    pageNo: 1,
    pageSize: 100
  });
  if (res.ok) {
    const data = res.result as { items: Array<Record<string, unknown>> };
    expect(data.items[0]).not.toHaveProperty('content');
    expect(JSON.stringify(data)).not.toContain('super-secret-password');
  }
});
```

`createMockDeps` 里 mock 的 list 项可以继续带 `content`——handler 必须丢掉它。Driver 的 `normalizeConfigSummary` 本来就不留 `content`；MCP 这一层是第二道闸，防止以后有人把原文塞回 summary。

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/mcp/bridgeSchemas.test.ts test/agent/NacosAgentToolService.test.ts
```

Expected: FAIL，`search: 'accurate'` 被 `.strict()` 丢掉或当 unknown；handler 仍把 `dataId` 塞进 `search` 并做客户端 `group` filter。

- [ ] **Step 3: 最小实现**

`bridgeSchemas.ts` 中 `nacosListConfigsSchema`：

```ts
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
```

同步改 `NACOS_LIST_CONFIGS_INPUT_SCHEMA`：`search` 的 description 写 `blur`（可用 `*` 前后缀）或 `accurate`；`dataId`/`group` 写「原样发给 Nacos，blur 时按官方规则把 `*` 当通配」；`additionalProperties: false`。

`NacosAgentToolService.listConfigs`：

```ts
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
```

`toolCatalog.ts` 里 `nacos_list_configs` 的 description 改为：列出配置元数据（不含正文）；过滤在服务端执行；正文只用 `nacos_get_config`。

- [ ] **Step 4: 再跑测试确认通过**

```bash
npx vitest run test/mcp/bridgeSchemas.test.ts test/agent/NacosAgentToolService.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/mcp/bridgeSchemas.ts src/mcp/toolCatalog.ts src/agent/NacosAgentToolService.ts test/mcp/bridgeSchemas.test.ts test/agent/NacosAgentToolService.test.ts
git commit -m "$(cat <<'EOF'
feat(nacos): list configs via server filters without bodies

Stop client-side group filtering and keep list payloads out of
Agent context; content stays on nacos_get_config.
EOF
)"
```

---

### Task 3: 服务列表补 `serviceName` 与 `ignoreEmptyService`

**Files:**

- Modify: `src/nacos/driver/NacosDriver.ts`（`NacosServiceListQuery`）
- Modify: `src/nacos/driver/naming.ts`（`countedServiceParams`）
- Modify: `src/mcp/bridgeSchemas.ts`、`src/mcp/toolCatalog.ts`、`src/agent/NacosAgentToolService.ts`
- Test: `test/nacos/driver/namingDrivers.test.ts`
- Test: `test/mcp/bridgeSchemas.test.ts`
- Test: `test/agent/NacosAgentToolService.test.ts`

缺省必须保持树行为：`ignoreEmptyService` 未设 → 发 `'false'`（现有用例 `asks the listing to keep services that have no instances`）。MCP 默认传 `true`，与官方一致。

`countedServiceParams` 最终形状：

```ts
function countedServiceParams(
  query: NacosServiceListQuery,
  emptyServiceParam: 'hasIpCount' | 'ignoreEmptyService'
): Record<string, string> {
  return {
    namespaceId: query.namespaceId,
    groupNameParam: query.group ?? '',
    serviceNameParam: query.serviceName ?? '',
    pageNo: String(query.pageNo),
    pageSize: String(query.pageSize),
    withInstances: 'false',
    [emptyServiceParam]: query.ignoreEmptyService === true ? 'true' : 'false'
  };
}
```

`NacosServiceListQuery` 增加可选 `serviceName?: string` 与 `ignoreEmptyService?: boolean`。`withInstances` 继续硬编码 false，不暴露给 MCP。

- [ ] **Step 1: 写会失败的测试**

在 `namingDrivers.test.ts` 的 `asks the listing to keep services that have no instances` 之后：

```ts
it('sends serviceNameParam when the caller named a service', async () => {
  const { requests } = await drive(
    driverCase,
    respondWith(200, driverCase.servicePrimaryBody),
    (driver) =>
      driver.listServices({
        namespaceId: NAMESPACE_ID,
        pageNo: 1,
        pageSize: 100,
        serviceName: 'order'
      })
  );
  const query = queryOf(requests[0]?.url ?? '');
  if (driverCase.serviceGroupParam === 'groupNameParam') {
    expect(query.get('serviceNameParam')).toBe('order');
  }
});

it('hides empty services only when the caller asks', async () => {
  const { requests } = await drive(
    driverCase,
    respondWith(200, driverCase.servicePrimaryBody),
    (driver) =>
      driver.listServices({
        namespaceId: NAMESPACE_ID,
        pageNo: 1,
        pageSize: 100,
        ignoreEmptyService: true
      })
  );
  const query = queryOf(requests[0]?.url ?? '');
  if (driverCase.serviceGroupParam === 'groupNameParam') {
    expect(query.get('hasIpCount') ?? query.get('ignoreEmptyService')).toBe('true');
  }
});
```

name-only 回退路径（`serviceGroupParam === 'groupName'`）没有 `serviceNameParam`，那些 flavor 的第一条可以 `expect(query.has('serviceNameParam')).toBe(false)`——不要对回退路径假装 Nacos 支持模糊检索。

`bridgeSchemas.test.ts`：

```ts
it('nacosListServicesSchema accepts serviceName and ignoreEmptyService', () => {
  expect(
    nacosListServicesSchema.safeParse({
      instanceId: 'inst-1',
      serviceName: 'order',
      ignoreEmptyService: false
    }).success
  ).toBe(true);
});
```

`NacosAgentToolService.test.ts`：

```ts
it('nacos_list_services defaults ignoreEmptyService to true and forwards serviceName', async () => {
  const { service, client } = createMockDeps();
  await service.invoke('nacos_list_services', {
    instanceId: 'inst-allowed',
    serviceName: 'order'
  });
  expect(client.listServices).toHaveBeenCalledWith({
    namespaceId: '',
    group: undefined,
    serviceName: 'order',
    ignoreEmptyService: true,
    pageNo: 1,
    pageSize: 100
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/nacos/driver/namingDrivers.test.ts test/mcp/bridgeSchemas.test.ts test/agent/NacosAgentToolService.test.ts
```

Expected: FAIL，query 没有 `serviceNameParam`；MCP 调用没有 `ignoreEmptyService: true`。

- [ ] **Step 3: 最小实现**

改 `NacosServiceListQuery` 与 `countedServiceParams`（见上）。

`nacosListServicesSchema` 增加：

```ts
serviceName: z.string().optional(),
ignoreEmptyService: z.boolean().optional(),
```

JSON Schema 同步；description 写清：`serviceName` 对应官方 `serviceNameParam`（前后缀匹配）；`ignoreEmptyService` 默认 true；`withInstances` 永不开放。

`listServices` handler：

```ts
const page = await resolved.client.listServices({
  namespaceId: input.namespaceId ?? '',
  group: input.group,
  serviceName: input.serviceName,
  ignoreEmptyService: input.ignoreEmptyService ?? true,
  pageNo: input.pageNo ?? 1,
  pageSize: input.pageSize ?? 100
});
```

- [ ] **Step 4: 再跑测试确认通过**

```bash
npx vitest run test/nacos/driver/namingDrivers.test.ts test/mcp/bridgeSchemas.test.ts test/agent/NacosAgentToolService.test.ts
```

Expected: PASS。原「keep services that have no instances」仍为 `'false'`。

- [ ] **Step 5: Commit**

```bash
git add src/nacos/driver/NacosDriver.ts src/nacos/driver/naming.ts src/mcp/bridgeSchemas.ts src/mcp/toolCatalog.ts src/agent/NacosAgentToolService.ts test/nacos/driver/namingDrivers.test.ts test/mcp/bridgeSchemas.test.ts test/agent/NacosAgentToolService.test.ts
git commit -m "$(cat <<'EOF'
feat(nacos): align service list search with Admin API

Forward serviceNameParam and let MCP hide empty services by
default without changing the service tree.
EOF
)"
```

---

### Task 4: 拆开服务元数据与实例列表

**Files:**

- Modify: `src/mcp/bridgeSchemas.ts`、`src/mcp/toolCatalog.ts`、`src/agent/NacosAgentToolService.ts`
- Test: `test/mcp/bridgeSchemas.test.ts`、`test/mcp/toolCatalog.test.ts`、`test/agent/NacosAgentToolService.test.ts`

常量（只放 agent 层，不要从 `naming.ts` 的私有 `DEFAULT_GROUP` 重新 export，避免 MCP 依赖 naming 实现细节）：

```ts
const DEFAULT_SERVICE_GROUP = 'DEFAULT_GROUP';
```

`nacos_get_service`：`group` 改为 optional，缺省 `DEFAULT_GROUP`。description 必须写「不含实例列表，实例用 `nacos_list_service_instances`」。

`nacos_list_service_instances` 入参：`instanceId`、`namespaceId?`、`group?`（默认 `DEFAULT_GROUP`）、`serviceName`（必填）、`cluster?`（对应 Driver `NacosInstanceQuery.cluster`）。

`NacosApiClientLike` 增加 `listInstances`。

- [ ] **Step 1: 写会失败的测试**

`toolCatalog.test.ts` 把「exactly 7」改成至少包含新名字（完整 13 要到 Task 7 才齐，本任务先变成 8）：

```ts
it('declares read-only nacos_ tools including service instances as a separate tool', () => {
  const names = AT_NACOS_TOOL_CATALOG.map((tool) => tool.name);
  expect(names).toContain('nacos_list_service_instances');
  expect(names).toContain('nacos_list_instances');
  const getService = AT_NACOS_TOOL_CATALOG.find((tool) => tool.name === 'nacos_get_service');
  expect(getService?.description).toMatch(/not including instance list|不含实例/i);
  expect(getService?.description).toContain('nacos_list_service_instances');
  for (const tool of AT_NACOS_TOOL_CATALOG) {
    expect(tool.name).toMatch(/^nacos_[a-z0-9_]+$/);
    expect(tool.risk).toBe('read');
    expect(BRIDGE_SCHEMAS_BY_TOOL_NAME[tool.name]).toBeDefined();
  }
});
```

`bridgeSchemas.test.ts`：

```ts
it('nacosGetServiceSchema defaults group to optional', () => {
  expect(
    nacosGetServiceSchema.safeParse({
      instanceId: 'inst-1',
      serviceName: 'order-service'
    }).success
  ).toBe(true);
});

it('nacosListServiceInstancesSchema requires serviceName', () => {
  expect(
    nacosListServiceInstancesSchema.safeParse({
      instanceId: 'inst-1',
      serviceName: 'order-service',
      cluster: 'DEFAULT'
    }).success
  ).toBe(true);
  expect(nacosListServiceInstancesSchema.safeParse({ instanceId: 'inst-1' }).success).toBe(false);
});
```

把 `contains schema for all 7 tools` 的期望数组加上 `'nacos_list_service_instances'`。

`NacosAgentToolService.test.ts` 的 mock client 增加：

```ts
listInstances: vi.fn().mockResolvedValue([
  { ip: '192.168.1.10', port: 8080, healthy: true, enabled: true, weight: 1, cluster: 'DEFAULT', metadata: {} }
]),
```

新用例：

```ts
it('nacos_get_service fills DEFAULT_GROUP and does not call listInstances', async () => {
  const { service, client } = createMockDeps();
  const res = await service.invoke('nacos_get_service', {
    instanceId: 'inst-allowed',
    serviceName: 'order-service'
  });
  expect(res.ok).toBe(true);
  expect(client.getService).toHaveBeenCalledWith({
    namespaceId: '',
    group: 'DEFAULT_GROUP',
    serviceName: 'order-service'
  });
  expect(client.listInstances).not.toHaveBeenCalled();
});

it('nacos_list_service_instances lists instances for one service', async () => {
  const { service, client } = createMockDeps();
  const res = await service.invoke('nacos_list_service_instances', {
    instanceId: 'inst-allowed',
    serviceName: 'order-service',
    cluster: 'DEFAULT'
  });
  expect(res.ok).toBe(true);
  expect(client.listInstances).toHaveBeenCalledWith({
    namespaceId: '',
    group: 'DEFAULT_GROUP',
    serviceName: 'order-service',
    cluster: 'DEFAULT'
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/mcp/toolCatalog.test.ts test/mcp/bridgeSchemas.test.ts test/agent/NacosAgentToolService.test.ts
```

Expected: FAIL，未知工具 `nacos_list_service_instances`；get_service 无 group 仍 VALIDATION_ERROR。

- [ ] **Step 3: 最小实现**

`nacosGetServiceSchema`：`group: z.string().min(1).optional()`，`required` JSON 只留 `instanceId`、`serviceName`。

新增：

```ts
export const nacosListServiceInstancesSchema = z
  .object({
    instanceId: z.string().min(1),
    namespaceId: z.string().optional(),
    group: z.string().min(1).optional(),
    serviceName: z.string().min(1),
    cluster: z.string().optional()
  })
  .strict();
```

`BRIDGE_SCHEMAS_BY_TOOL_NAME` 登记 `'nacos_list_service_instances'`。

`NacosApiClientLike` 加上 `'listInstances'`。

handler：

```ts
case 'nacos_list_service_instances':
  return this.handleParsed(nacosListServiceInstancesSchema, args, (input) =>
    this.listServiceInstances(input)
  );

private async getService(input: NacosGetServiceInput): Promise<ToolInvokeResult> {
  const resolved = await this.resolveInstance(input.instanceId);
  if (!resolved.ok) {
    return resolved.failure;
  }
  const detail = await resolved.client.getService({
    namespaceId: input.namespaceId ?? '',
    group: input.group ?? DEFAULT_SERVICE_GROUP,
    serviceName: input.serviceName
  });
  if (!detail) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `Service not found: group=${input.group ?? DEFAULT_SERVICE_GROUP}, serviceName=${input.serviceName}`
    };
  }
  return { ok: true, result: detail };
}

private async listServiceInstances(input: NacosListServiceInstancesInput): Promise<ToolInvokeResult> {
  const resolved = await this.resolveInstance(input.instanceId);
  if (!resolved.ok) {
    return resolved.failure;
  }
  const instances = await resolved.client.listInstances({
    namespaceId: input.namespaceId ?? '',
    group: input.group ?? DEFAULT_SERVICE_GROUP,
    serviceName: input.serviceName,
    cluster: input.cluster
  });
  return { ok: true, result: { instances } };
}
```

`toolCatalog`：插入 `nacos_list_service_instances`；重写 `nacos_get_service` 与 `nacos_list_instances` 的 description（后者点明「configured plugin instances, not Nacos service hosts」）。

- [ ] **Step 4: 再跑测试确认通过**

```bash
npx vitest run test/mcp/toolCatalog.test.ts test/mcp/bridgeSchemas.test.ts test/agent/NacosAgentToolService.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/mcp/bridgeSchemas.ts src/mcp/toolCatalog.ts src/agent/NacosAgentToolService.ts test/mcp/bridgeSchemas.test.ts test/mcp/toolCatalog.test.ts test/agent/NacosAgentToolService.test.ts
git commit -m "$(cat <<'EOF'
feat(nacos): split service metadata from instance listing

Match the official MCP split so Agents do not expect hosts on
get_service, and stop colliding with plugin instance listing.
EOF
)"
```

---

### Task 5: 监听者 / 订阅者的 `aggregation`

**Files:**

- Modify: `src/nacos/driver/NacosDriver.ts`（`NacosListenerQuery`、`NacosSubscriberQuery`；Driver 方法参数类型）
- Modify: `src/nacos/driver/history.ts`（`fetchConfigListeners`）
- Modify: `src/nacos/driver/naming.ts`（`fetchSubscribers`）
- Modify: 四个 Driver 的方法签名（参数类型换成 Query；调用处把同一对象传下去）
- Modify: `src/nacos/NacosClient.ts`
- Test: `test/nacos/driver/historyDrivers.test.ts`

类型：

```ts
export interface NacosListenerQuery extends NacosConfigRef {
  /** 3.x：是否汇总整个集群。缺省 true。v1/v2 不发这个参数。 */
  aggregation?: boolean;
}

export interface NacosSubscriberQuery extends NacosServiceRef {
  aggregation?: boolean;
}
```

现有调用方传 `NacosConfigRef` / `NacosServiceRef` 仍然成立（结构兼容）。

v3 才把 `aggregation` 放进 query，值为 `'true'` / `'false'`。缺省按官方：未设则 `'true'`。v1/v2 不出现该键（现有 `sampleTime=1` 断言不受影响）。

- [ ] **Step 1: 写会失败的测试**

在 `historyDrivers.test.ts` 的 listener describe 里追加（该文件的 `DRIVER_CASES` 带 `flavor`）：

```ts
it('sends aggregation on 3.x listener requests and omits it on v1/v2', async () => {
  const { requests } = await drive(
    driverCase,
    respondWith(200, driverCase.wrap(LISTENER_STATUS)),
    (driver) => driver.listConfigListeners(CONFIG_REF)
  );
  const query = queryOf(requests[0]?.url ?? '');
  if (flavor === 'v3-admin' || flavor === 'v3-console') {
    expect(query.get('aggregation')).toBe('true');
  } else {
    expect(query.has('aggregation')).toBe(false);
  }
});

it('lets the caller disable listener aggregation on 3.x', async () => {
  const { requests } = await drive(
    driverCase,
    respondWith(200, driverCase.wrap(LISTENER_STATUS)),
    (driver) => driver.listConfigListeners({ ...CONFIG_REF, aggregation: false })
  );
  const query = queryOf(requests[0]?.url ?? '');
  if (flavor === 'v3-admin' || flavor === 'v3-console') {
    expect(query.get('aggregation')).toBe('false');
  }
});
```

在同一个文件的 subscriber describe 里追加。`HistoryDriverCase.subscribersBody` 已存在：

```ts
it('sends aggregation on 3.x subscriber requests and omits it on v1/v2', async () => {
  const { requests } = await drive(
    driverCase,
    respondWith(200, driverCase.subscribersBody),
    (driver) => driver.listSubscribers(SERVICE_REF)
  );
  const query = queryOf(requests[0]?.url ?? '');
  if (flavor === 'v3-admin' || flavor === 'v3-console') {
    expect(query.get('aggregation')).toBe('true');
  } else {
    expect(query.has('aggregation')).toBe(false);
  }
});

it('lets the caller disable subscriber aggregation on 3.x', async () => {
  const { requests } = await drive(
    driverCase,
    respondWith(200, driverCase.subscribersBody),
    (driver) => driver.listSubscribers({ ...SERVICE_REF, aggregation: false })
  );
  const query = queryOf(requests[0]?.url ?? '');
  if (flavor === 'v3-admin' || flavor === 'v3-console') {
    expect(query.get('aggregation')).toBe('false');
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/nacos/driver/historyDrivers.test.ts
```

Expected: FAIL，3.x 请求没有 `aggregation=true`。

- [ ] **Step 3: 最小实现**

`history.ts` 的 `fetchConfigListeners` 第三个业务参数改为 `query: NacosListenerQuery`，query 对象里：

```ts
...(endpointFlavor === 'v3-admin' || endpointFlavor === 'v3-console'
  ? { aggregation: query.aggregation === false ? 'false' : 'true' }
  : {})
```

`naming.ts` 的 `fetchSubscribers` 同样处理。四个 Driver 与 `NacosClient` 的签名跟着改，调用继续把整个 query 传下去。

- [ ] **Step 4: 再跑测试确认通过**

```bash
npx vitest run test/nacos/driver/historyDrivers.test.ts test/webview/ConfigListenersPanel.test.ts test/webview/ServiceSubscribersPanel.test.ts
```

Expected: PASS。面板测试不传 `aggregation`，3.x 会多一个 query 键，不断言完整 URL 的测试应仍绿。

- [ ] **Step 5: Commit**

```bash
git add src/nacos/driver/NacosDriver.ts src/nacos/driver/history.ts src/nacos/driver/naming.ts src/nacos/driver/V1Driver.ts src/nacos/driver/V2Driver.ts src/nacos/driver/V3AdminDriver.ts src/nacos/driver/V3ConsoleDriver.ts src/nacos/NacosClient.ts test/nacos/driver/historyDrivers.test.ts
git commit -m "$(cat <<'EOF'
feat(nacos): send cluster aggregation on 3.x listeners

Default true to match Admin API; v1/v2 stay on sampleTime only.
EOF
)"
```

---

### Task 6: 把历史、监听者、订阅者挂上 MCP

**Files:**

- Modify: `src/mcp/bridgeSchemas.ts`、`src/mcp/toolCatalog.ts`、`src/agent/NacosAgentToolService.ts`
- Test: `test/mcp/bridgeSchemas.test.ts`、`test/mcp/toolCatalog.test.ts`、`test/agent/NacosAgentToolService.test.ts`

工具与入参：

| 工具 | 必填 | 可选 | 默认 |
|---|---|---|---|
| `nacos_list_config_history` | `instanceId`, `group`, `dataId` | `namespaceId`, `pageNo`, `pageSize` | page 1/100，pageSize max 500 |
| `nacos_get_config_history` | `instanceId`, `group`, `dataId`, `nid` | `namespaceId`, `raw` | 脱敏，与 `nacos_get_config` 相同 |
| `nacos_list_config_listeners` | `instanceId`, `group`, `dataId` | `namespaceId`, `aggregation` | aggregation true |
| `nacos_list_service_subscribers` | `instanceId`, `serviceName` | `namespaceId`, `group`, `aggregation` | group=`DEFAULT_GROUP`，aggregation true |

`nid` 用 `z.string().min(1)`（Driver 已把历史 id 收成 string）。官方 schema 漏了 required，这里不要跟着漏。

`NacosApiClientLike` 再加：`'listConfigHistory' | 'getConfigHistory' | 'listConfigListeners' | 'listSubscribers'`。

- [ ] **Step 1: 写会失败的测试**

`createMockDeps` 的 mock client 增加：

```ts
listConfigHistory: vi.fn().mockResolvedValue({
  totalCount: 1,
  pageNumber: 1,
  pagesAvailable: 1,
  items: [{ id: '203', group: 'DEFAULT_GROUP', dataId: 'db.yaml', namespaceId: 'dev', opType: 'U' }]
}),
getConfigHistory: vi.fn().mockResolvedValue({
  namespaceId: 'dev',
  group: 'DEFAULT_GROUP',
  dataId: 'db.yaml',
  type: 'yaml',
  content: 'password: super-secret-password'
}),
listConfigListeners: vi.fn().mockResolvedValue([{ ip: '10.0.0.1', md5: 'abc' }]),
listSubscribers: vi.fn().mockResolvedValue([{ ip: '10.0.0.1', port: 0, group: 'DEFAULT_GROUP', serviceName: 'order-service', namespaceId: 'dev' }]),
```

```ts
it('nacos_list_config_history pages history without content', async () => {
  const { service, client } = createMockDeps();
  const res = await service.invoke('nacos_list_config_history', {
    instanceId: 'inst-allowed',
    group: 'DEFAULT_GROUP',
    dataId: 'db.yaml'
  });
  expect(res.ok).toBe(true);
  expect(client.listConfigHistory).toHaveBeenCalledWith({
    namespaceId: '',
    group: 'DEFAULT_GROUP',
    dataId: 'db.yaml',
    pageNo: 1,
    pageSize: 100
  });
});

it('nacos_get_config_history redacts unless raw is true', async () => {
  const { service } = createMockDeps();
  const redacted = await service.invoke('nacos_get_config_history', {
    instanceId: 'inst-allowed',
    group: 'DEFAULT_GROUP',
    dataId: 'db.yaml',
    nid: '203'
  });
  expect(redacted.ok).toBe(true);
  if (redacted.ok) {
    const data = redacted.result as { content: string; isRedacted: boolean };
    expect(data.isRedacted).toBe(true);
    expect(data.content).not.toContain('super-secret-password');
  }
});

it('nacos_get_config_history requires nid', async () => {
  const { service } = createMockDeps();
  const res = await service.invoke('nacos_get_config_history', {
    instanceId: 'inst-allowed',
    group: 'DEFAULT_GROUP',
    dataId: 'db.yaml'
  });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.code).toBe('VALIDATION_ERROR');
  }
});

it('nacos_list_config_listeners forwards aggregation', async () => {
  const { service, client } = createMockDeps();
  await service.invoke('nacos_list_config_listeners', {
    instanceId: 'inst-allowed',
    group: 'DEFAULT_GROUP',
    dataId: 'db.yaml',
    aggregation: false
  });
  expect(client.listConfigListeners).toHaveBeenCalledWith({
    namespaceId: '',
    group: 'DEFAULT_GROUP',
    dataId: 'db.yaml',
    aggregation: false
  });
});

it('nacos_list_service_subscribers defaults group and aggregation', async () => {
  const { service, client } = createMockDeps();
  await service.invoke('nacos_list_service_subscribers', {
    instanceId: 'inst-allowed',
    serviceName: 'order-service'
  });
  expect(client.listSubscribers).toHaveBeenCalledWith({
    namespaceId: '',
    group: 'DEFAULT_GROUP',
    serviceName: 'order-service',
    aggregation: true
  });
});
```

`toolCatalog` 测试：`names` 包含这四个新名字。`BRIDGE_SCHEMAS_BY_TOOL_NAME` 的 keys 排序数组补上它们。

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/mcp/toolCatalog.test.ts test/mcp/bridgeSchemas.test.ts test/agent/NacosAgentToolService.test.ts
```

Expected: FAIL，Unknown MCP tool。

- [ ] **Step 3: 最小实现**

四个 zod schema + JSON Schema twins（`additionalProperties: false`）。history 详情的 `raw` 与 `get_config` 相同。

`invoke` switch 增加四条。handler 里：

- history 列表：直接返回 `listConfigHistory` 的 page（`NacosConfigHistoryEntry` 没有正文）。
- history 详情：

```ts
const detail = await resolved.client.getConfigHistory({
  namespaceId: input.namespaceId ?? '',
  group: input.group,
  dataId: input.dataId,
  nid: input.nid
});
if (!detail) {
  return {
    ok: false,
    code: 'NOT_FOUND',
    message: `Configuration history not found: nid=${input.nid}`
  };
}
const isRaw = input.raw === true;
return {
  ok: true,
  result: {
    ...detail,
    content: isRaw ? detail.content : redactSensitiveText(detail.content),
    isRedacted: !isRaw
  }
};
```

- listeners：`listConfigListeners({ namespaceId: input.namespaceId ?? '', group: input.group, dataId: input.dataId, aggregation: input.aggregation ?? true })`
- subscribers：`listSubscribers({ namespaceId: input.namespaceId ?? '', group: input.group ?? DEFAULT_SERVICE_GROUP, serviceName: input.serviceName, aggregation: input.aggregation ?? true })`

`nacos_list_instances` 的 description 保持 Task 4 的写法。新工具 description 必须写默认值、`aggregation` 含义、以及 3.x admin 监听者要 WRITE、会走现有 console 降级（一句话即可）。

- [ ] **Step 4: 再跑测试确认通过**

```bash
npx vitest run test/mcp/toolCatalog.test.ts test/mcp/bridgeSchemas.test.ts test/agent/NacosAgentToolService.test.ts
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/mcp/bridgeSchemas.ts src/mcp/toolCatalog.ts src/agent/NacosAgentToolService.ts test/mcp/bridgeSchemas.test.ts test/mcp/toolCatalog.test.ts test/agent/NacosAgentToolService.test.ts
git commit -m "$(cat <<'EOF'
feat(nacos): expose history, listeners and subscribers to MCP

These reads already exist on the driver; Agents could not reach
them because M6 capped the catalog at seven tools.
EOF
)"
```

---

### Task 7: 按客户端 IP 反查已订阅配置

**Files:**

- Modify: `src/nacos/driver/normalize.ts`（类型 + `normalizeListenedConfigs` + `parseGroupKey`）
- Modify: `src/nacos/driver/history.ts`（`fetchListenedConfigs`）
- Modify: `src/nacos/driver/NacosDriver.ts`（接口方法）
- Modify: `src/nacos/driver/V1Driver.ts`、`V2Driver.ts`、`V3AdminDriver.ts`、`V3ConsoleDriver.ts`
- Modify: `src/nacos/NacosClient.ts`、`src/nacos/NacosCapabilityResolver.ts`
- Modify: `test/nacos/NacosClient.test.ts` 的 `stubDriver`、`test/nacos/NacosCapabilityResolver.test.ts` 的 `driver()`
- Create: `test/nacos/driver/listenedConfigs.test.ts`
- Modify: MCP 三件套 + agent 测试

路径：

| flavor | path |
|---|---|
| v1 / v2 | `/v1/cs/listener`（V1Driver 注释已把这条和 `configs/listener` 分开） |
| v3-admin | `/v3/admin/cs/listener` |
| v3-console | `/v3/console/cs/config/listener/ip`（官方 Console API 2.8；不是 admin 路径换前缀） |

v2 没有自己的 listener 反查（与「配置→监听者」相同），走 v1 路径。

Query：`ip` 必填；命名空间用 `namespaceParamName(flavor, 'config')`；3.x 另发 `aggregation`（缺省 true）。

响应：1.x/2.x 是拼错的 `lisentersGroupkeyStatus` 地图；3.x `ConfigListenerInfo` 是 `listenersStatus`。key 是 Nacos `GroupKey`（`dataId+group` 或 `dataId+group+tenant`），value 是 md5。3.x 包在 `{code,data}` 里时走现有 `unwrapData`。`listenerStatusIn` 三种键名都收。

```ts
export interface NacosListenedConfigQuery {
  namespaceId: string;
  ip: string;
  aggregation?: boolean;
}

export interface NacosListenedConfig {
  group: string;
  dataId: string;
  md5: string;
}
```

`parseGroupKey`：按 `+` 切开；第一段 dataId，第二段 group；不足两段则整段当作 dataId、group 为 `''`。不要 URL decode 两次——`requestJson` 拿到的已是 JSON 字符串。

能力名：`'listened-configs'`（加入 `NacosCapability` 联合）。不要和 `'config-listeners'` 共用缓存：一个 404 不能把另一个的 winner 赶走。

- [ ] **Step 1: 写会失败的归一化与驱动测试**

`test/nacos/driver/listenedConfigs.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { normalizeListenedConfigs, parseGroupKey } from '../../../src/nacos/driver/normalize';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import { NacosHttpClient } from '../../../src/nacos/NacosHttpClient';
import { V1Driver } from '../../../src/nacos/driver/V1Driver';
import { V3AdminDriver } from '../../../src/nacos/driver/V3AdminDriver';
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
    const server = await startTestHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json;charset=UTF-8' });
      res.end(`{"code":0,"data":${body}}`);
    });
    try {
      const http = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
      await new V3AdminDriver(http).listListenedConfigs({
        namespaceId: 'dev',
        ip: '10.0.0.8'
      });
      const url = new URL(server.requests[0]?.url ?? '', 'http://127.0.0.1');
      expect(url.pathname).toBe('/nacos/v3/admin/cs/listener');
      expect(url.searchParams.get('namespaceId')).toBe('dev');
      expect(url.searchParams.get('aggregation')).toBe('true');
    } finally {
      await server.close();
    }
  });
});
```

Agent 测试：

```ts
it('nacos_list_listened_configs requires ip', async () => {
  const { service } = createMockDeps();
  const res = await service.invoke('nacos_list_listened_configs', { instanceId: 'inst-allowed' });
  expect(res.ok).toBe(false);
});

it('nacos_list_listened_configs forwards ip and aggregation', async () => {
  const { service, client } = createMockDeps();
  await service.invoke('nacos_list_listened_configs', {
    instanceId: 'inst-allowed',
    ip: '10.0.0.8'
  });
  expect(client.listListenedConfigs).toHaveBeenCalledWith({
    namespaceId: '',
    ip: '10.0.0.8',
    aggregation: true
  });
});
```

`createMockDeps` 增加 `listListenedConfigs: vi.fn().mockResolvedValue([])`。

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run test/nacos/driver/listenedConfigs.test.ts test/agent/NacosAgentToolService.test.ts test/nacos/NacosClient.test.ts test/nacos/NacosCapabilityResolver.test.ts
```

Expected: FAIL，`listListenedConfigs` 不存在；两个 stub `driver()` / `stubDriver()` 缺方法导致 typecheck/测试装载失败。先把两个 stub 补上 `listListenedConfigs: unused` / `behavior as never` 再跑，确认业务测试仍红。

- [ ] **Step 3: 最小实现**

`parseGroupKey` / `normalizeListenedConfigs` 放在 `normalize.ts`，复用 `listenerStatusIn`（已接受拼错键名）。不要新写一份地图读取。

`fetchListenedConfigs` 放 `history.ts`，与 `fetchConfigListeners` 并列。

四个 Driver：

```ts
listListenedConfigs(query: NacosListenedConfigQuery): Promise<NacosListenedConfig[]> {
  return fetchListenedConfigs(this.http, this.flavor /* v2 传 v1 */, PATH, query);
}
```

`V2Driver` 的 endpoint flavor 与 listener 正向查询一样用 v1。`V3ConsoleDriver` 传 `onConsoleOrigin()`。

`NacosClient`：

```ts
listListenedConfigs(query: NacosListenedConfigQuery): Promise<NacosListenedConfig[]> {
  return this.resolver.run('listened-configs', (driver) => driver.listListenedConfigs(query));
}
```

MCP：schema 必填 `instanceId`+`ip`；catalog 一条；handler 调 `listListenedConfigs`。

- [ ] **Step 4: 再跑测试确认通过**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: 全绿。`toolCatalog` 此时应为 13 条；把「exactly 7」彻底改成：

```ts
expect(AT_NACOS_TOOL_CATALOG).toHaveLength(13);
expect(AT_NACOS_TOOL_CATALOG.map((tool) => tool.name).sort()).toEqual([
  'nacos_get_cluster_nodes',
  'nacos_get_config',
  'nacos_get_config_history',
  'nacos_get_service',
  'nacos_list_config_history',
  'nacos_list_config_listeners',
  'nacos_list_configs',
  'nacos_list_instances',
  'nacos_list_listened_configs',
  'nacos_list_namespaces',
  'nacos_list_service_instances',
  'nacos_list_service_subscribers',
  'nacos_list_services'
]);
```

`BRIDGE_SCHEMAS_BY_TOOL_NAME` 的 keys 与上表相同。

- [ ] **Step 5: Commit**

```bash
git add src/nacos src/mcp src/agent test
git commit -m "$(cat <<'EOF'
feat(nacos): look up listened configs by client IP

Add the official reverse listener query across v1 and 3.x, and
expose it as nacos_list_listened_configs.
EOF
)"
```

---

### Task 8: 架构文档与剩余描述

**Files:**

- Modify: `docs/plans/2026-08-13-at-nacos-architecture.md` §3 MCP 行、§12 如需、§13 M6 验收句
- Modify: `src/mcp/toolCatalog.ts`（给仍偏短的 `nacos_list_namespaces`、`nacos_get_cluster_nodes` 补默认值说明）

§3 表格「MCP」格子改为：

> 13 个只读工具，切分对齐 Nacos 3.x Admin API；读配置与历史详情默认脱敏，`raw: true` 才出原文；列表接口不返回正文。多版本 Driver 与插件多实例保留。

§13 M6 验收句里「7 个只读工具」改为「13 个只读工具」。不要改 M6 已经做完的历史叙述以外的决策表时，在 §3 加一句「2026-08-20 由 7 扩到 13，见 `docs/plans/2026-08-20-nacos-mcp-official-alignment.md`」。

- [ ] **Step 1: 改文档**（无失败测试；用 grep 确认旧口径不残留）

```bash
rg "7 个只读" docs/plans src/mcp
```

Expected: 只留下本计划文件和「由 7 扩到 13」那句。

- [ ] **Step 2: 全量验证**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: PASS，exit 0。

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-08-13-at-nacos-architecture.md src/mcp/toolCatalog.ts
git commit -m "$(cat <<'EOF'
docs(nacos): record the 13-tool MCP catalog

The coarse seven-tool cap was an M6 scope choice, not an API
constraint; Hub v2 search is how Agents discover the extras.
EOF
)"
```

---

## 执行时注意

- **TDD 顺序不要倒。** 先红后绿。Driver 测试走现有 `drive()` + 真 HTTP，不要改成断言 `options.query` 的假客户端。
- **树不能变空。** Task 1/3 的缺省值必须让 `ConfigTreeProvider.fetchPage` 与服务树现有调用继续发出和今天一样的 query。
- **3.x 反查未经真机。** 与架构文档 §14 其它 3.x 路径相同：归一化同时收 v1 拼错地图、`listenersStatus` 和 `{code,data}` 包装；console 反查路径以官方 Console API 为准。live 测试有环境再补，不要阻塞合并。
- **不要抄官方 Python。** 它的 `type: int` schema、启动日志里的 token、`http://` 写死，都不是本计划的一部分。

---

## Self-review

1. **规格覆盖：** P0 三条对应 Task 1–4 与 6；P1 过滤项在 Task 1–3；aggregation 在 Task 5；列表去 content 在 Task 2；反查在 Task 7；描述与架构口径在 Task 4/8。集群节点、Bearer、脱敏、只读 MCP 明确列为非目标/保留。
2. **占位符：** 无 TBD。`parseGroupKey` 的 3.x 包装路径写了具体收法。
3. **类型一致：** `searchMode` 只存在于 Driver query；MCP 入参官方同名 `search` 映射为 `searchMode`。`DEFAULT_SERVICE_GROUP` 仅 agent 层。能力名 `'listened-configs'`。工具名 `nacos_list_service_instances` 全程未改成别的拼写。
