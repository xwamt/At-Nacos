# AT Nacos —— P1 工具描述契约 补齐计划

> **For agentic workers:** 本计划只补 Agent 可见文案。Driver / handler / 树调用不要改。

**Goal:** 把对照画布 P1「工具描述写成契约」补完：默认值、通配符、`public` / `DEFAULT_GROUP`、内存代价写进 catalog 与 JSON Schema description。

**Architecture:** 六个 P1 能力里，过滤、服务检索、aggregation、去 content、按 IP 反查已经在 `feat/nacos-mcp-official-alignment` 落地。缺口只在模型读到的 description。

**Tech Stack:** 现有 `toolCatalog.ts` + `bridgeSchemas.ts` twins；vitest。

---

## 对照结论（不要重做已落地能力）

| P1 | 能力 | 状态 |
|---|---|---|
| 配置列表 `type` / `configTags` / `appName` / 显式 `search` | Driver + MCP schema + handler | 已对齐 |
| 服务列表 `groupNameParam` / `serviceNameParam`；MCP 默认忽略空服务；树仍显示空服务 | `countedServiceParams` + `ignoreEmptyService ?? true`；树不传该字段 | 已对齐 |
| 订阅者 / 监听者 `aggregation` 默认 true | 3.x 发 `'true'`/`'false'`；v1/v2 不发 | 已对齐 |
| 列表丢掉 `content` | `listConfigs` handler 剥离 | 已对齐 |
| 按 IP 反查 `nacos_list_listened_configs` | v1 `/v1/cs/listener`；3.x admin `/v3/admin/cs/listener`；console `/v3/console/cs/config/listener/ip` | 已对齐 |
| **工具描述写成契约** | catalog / JSON Schema 仍偏短；`namespaceId` 写成 “defaults to public”；`group` 没写 `groupNameParam`；缺内存代价 | **本计划** |

---

### Task 1: 把契约写进 description

**Files:**

- Modify: `src/mcp/toolCatalog.ts`
- Modify: `src/mcp/bridgeSchemas.ts`（只改 JSON Schema `description` 字符串）
- Test: `test/mcp/toolCatalog.test.ts`

契约要点（catalog 用英文，与现有工具一致）：

1. `nacos_list_configs`：服务端过滤字段名单；省略 `search` = `accurate`（不是官方默认 blur）；blur 才允许 `*`；无正文；pageSize 默认 100、上限 500，大页贵。
2. `nacos_list_services`：`group` → `groupNameParam` 前后缀；`serviceName` → `serviceNameParam`；省略 group = 全部组；`ignoreEmptyService` 默认 true；**永不**暴露 `withInstances`（会把每页所有主机展开，吃内存），实例走 `nacos_list_service_instances`。
3. `nacos_list_service_instances`：去掉 `NacosInstanceQuery` 泄漏；省略 `cluster` = 该服务所有 cluster。
4. 所有带 `namespaceId` 的 JSON Schema：不要写 “defaults to public namespace”。改为省略则用实例默认（1.x/2.x 空串），用 `nacos_list_namespaces` 返回的 id，1.x/2.x 不要传 `public`。
5. 带 `pageSize` 的列表：description 写默认 100 / max 500，以及大页的内存与上下文代价。

- [x] **Step 1: 写会失败的 catalog 测试**
- [x] **Step 2: `npm test -- test/mcp/toolCatalog.test.ts` 确认红**
- [x] **Step 3: 改 description**
- [x] **Step 4: 测试转绿**
- [x] **Step 5: Commit**

```
docs(nacos): write MCP tool descriptions as calling contracts

Defaults, wildcards, namespace ids and listing cost belong in
the text Agents actually read.
```
