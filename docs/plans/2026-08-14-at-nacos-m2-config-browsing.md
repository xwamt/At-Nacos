# AT Nacos M2 —— 配置浏览 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在配置树中浏览命名空间下的分组与 dataId，点开任意配置在 VS Code 原生编辑器中查看内容，带正确的语法高亮。

**Architecture:** `NacosDriver` 接口扩展出 `listConfigs` / `getConfig` 两个能力，四个 driver 各自实现参数名映射与响应归一化。配置内容通过 `TextDocumentContentProvider` 以 `nacos:` scheme 的虚拟文档呈现，语言模式由 `setTextDocumentLanguage` 显式设置。树按页加载，分组由已加载的页面推导。

**规格真源：** `docs/plans/2026-08-13-at-nacos-architecture.md`。§6 的参数名与响应形状差异、§9 的能力矩阵、§14.1/14.2 的真机验证结论，实现前必读。

**M1 遗留的前置决定：** 本计划的 Task 1 解决架构文档 §5.5 记录的 404 二义性；Task 4 落实 §14.2 的两条真机发现。

---

## 真机验证过的事实（Nacos 2.3.2，本计划的依据）

**404 有两种含义，判据是响应体形状，不是 content-type。**

配置不存在：

```
HTTP 404, Content-Type: application/json;charset=UTF-8
config data not exist
```

注意 content-type **谎报**成 json，body 其实是纯文本。

端点不存在：

```
HTTP 404, Content-Type: application/json;charset=UTF-8
{"timestamp":"2026-08-14T00:34:34.539+08:00","status":404,"error":"Not Found","message":"No message available","path":"/nacos/v1/cs/__nosuchendpoint__"}
```

所以判据是：body 能解析为 JSON **且**同时含 `status` / `error` / `path` 三个键 → Spring 错误页 → 端点不存在 → 该 fall through。其余一律视为资源不存在 → **不** fall through。

**`show=all` 取单条配置的完整字段**（v1/2.x）：

```json
{"id":"142","dataId":"application-uat.yml","group":"cl-intimfy","content":"spring:\n  ...","md5":"e1a9de8c8df94a487159b655a3c8f703","encryptedDataKey":"","tenant":"uat","appName":"","type":"yaml","createTime":1758164587000,"modifyTime":1758164587000,"createUser":null,"createIp":"192.168.66.66","desc":"","use":null,"effect":null,"schema":null,"configTags":null}
```

**配置列表返回完整正文。** `accurate` 与 `blur` 两种模式都在 `pageItems[].content` 里带整条配置。实测 12 条 = 38KB。v1 没有排除内容的参数。

**`type` 只在 `accurate` 模式下被填充，`blur` 下是 `null`。** 而搜索过滤用的正是 blur。

**v1 配置列表没有服务端分页上限。** `pageSize=9999` 被照单全收。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/nacos/NacosApiError.ts` | 新增 `resource-not-found` 类型（不 fall through） |
| `src/nacos/driver/springErrorPage.ts` | 判定一个 404 body 是否 Spring 错误页 |
| `src/nacos/driver/normalize.ts` | 新增 `NacosConfigSummary` / `NacosConfigDetail` / `Paged<T>` 与其归一化 |
| `src/nacos/driver/configLanguage.ts` | `type` 与 dataId 后缀 → VS Code languageId |
| `src/nacos/driver/NacosDriver.ts` | 接口扩展 `listConfigs` / `getConfig` |
| `src/nacos/driver/V{1,2,3Admin,3Console}Driver.ts` | 各版本实现 |
| `src/nacos/NacosClient.ts` | 门面转发两个新能力 |
| `src/document/configUri.ts` | `nacos:` URI 编解码 |
| `src/document/NacosConfigDocumentProvider.ts` | `TextDocumentContentProvider` |
| `src/document/openConfigDocument.ts` | 打开文档 + 设置语言模式 |
| `src/tree/NacosTreeItems.ts` | 新增 `GroupTreeItem` / `ConfigTreeItem` / `LoadMoreTreeItem` |
| `src/tree/ConfigTreeProvider.ts` | 命名空间以下的三层 |

---

## Task 1: 区分「端点不存在」与「资源不存在」

**Files:** `src/nacos/NacosApiError.ts`, `src/nacos/driver/springErrorPage.ts`, 测试同名

- [ ] **Step 1: 写失败测试**

`test/nacos/driver/springErrorPage.test.ts` 覆盖：真机抓到的两个 body 各自判定正确；空 body；非 JSON；JSON 但缺 `path`；JSON 数组；`{"status":404}` 但无 `error`/`path`（应判为**非**错误页，宁可少 fall through 也不能把资源缺失误判成端点缺失）。

`test/nacos/NacosApiError.test.ts` 追加：`resource-not-found` 的 `shouldFallThrough()` 为 `false`。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

```ts
/**
 * Whether a 404 body is Spring Boot's error page rather than Nacos's own
 * answer.
 *
 * Nacos overloads 404 for two unrelated things: this server version has no
 * such endpoint, and this server has no such config. The first must make the
 * resolver try the next driver; the second must not, or every lookup of a
 * dataId that does not exist walks the whole chain and reports "no API flavor
 * could serve this" instead of "no such config".
 *
 * The content type cannot be used to tell them apart -- Nacos answers
 * `config data not exist` with `Content-Type: application/json`, which is a
 * lie. Only the body shape discriminates, and all three keys are required so
 * that a Nacos error body that happens to carry a `status` field is not
 * mistaken for a missing endpoint.
 */
export function isSpringErrorPage(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return isRecord(parsed) && 'status' in parsed && 'error' in parsed && 'path' in parsed;
}
```

`NacosApiError.ts` 新增 kind `'resource-not-found'`，**不**加入 `FALL_THROUGH_KINDS`，并在 `describeFailure` 中给它一句说明。

- [ ] **Step 4: 运行确认通过，提交**

---

## Task 2: 配置的领域模型与归一化

**Files:** `src/nacos/driver/normalize.ts`, `src/nacos/driver/configLanguage.ts`, 测试同名

- [ ] **Step 1: 写失败测试**

`configLanguage.test.ts`：`type` 为 `yaml`/`yml` → `yaml`；`properties` → `properties`；`json`/`xml`/`html` 各自；`text` → `plaintext`；未知 type → 走后缀；**`type` 为 null 时按 dataId 后缀推断**（`.yml`/`.yaml`/`.properties`/`.json`/`.xml`/`.txt`/`.conf`）；两者都没有 → `plaintext`；后缀大小写不敏感；dataId 含多个点时只看最后一段（`application-uat.yml` → yaml，`a.b.c` → plaintext）。

`normalize.test.ts` 追加：用本计划开头那段真机 JSON 做 `normalizeConfigDetail` 的往返；`normalizeConfigSummary` 对 accurate 与 blur 两种条目（后者 `type` 为 null）；`Paged` 从 1.x 裸 Page（`totalCount`/`pageNumber`/`pagesAvailable`/`pageItems`）与 3.x 包装体两种形状归一。

- [ ] **Step 2-4: 确认失败 → 实现 → 确认通过 → 提交**

领域模型：

```ts
export interface Paged<T> {
  items: T[];
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
}

export interface NacosConfigRef {
  namespaceId: string;
  group: string;
  dataId: string;
}

export interface NacosConfigSummary extends NacosConfigRef {
  /** null on a blur search; callers fall back to the dataId suffix. */
  type?: string;
  appName?: string;
  md5?: string;
}

export interface NacosConfigDetail extends NacosConfigSummary {
  content: string;
  createTime?: number;
  modifyTime?: number;
  createIp?: string;
  description?: string;
}
```

**`content` 不进 `NacosConfigSummary`。** 服务端会送来，但列表层面刻意丢弃它——保留它意味着树的每个节点都攥着一整份配置正文，而其中含密码。

---

## Task 3: Driver 的两个新能力

**Files:** `src/nacos/driver/NacosDriver.ts` 与四个 driver，测试 `test/nacos/driver/configDrivers.test.ts`

- [ ] **Step 1: 写失败测试**

对四个 driver 各自断言：请求路径正确；命名空间参数名正确（**v1 config 用 `tenant`，v2/v3 用 `namespaceId`**，通过已有的 `namespaceParamName(flavor, 'config')`）；分组参数名正确（v1 `group`，v3 `groupName`）；响应归一化正确；`getConfig` 命中 404 + `config data not exist` 时抛 `resource-not-found`；命中 404 + Spring 错误页时抛 `not-found`。

- [ ] **Step 2-4: 确认失败 → 实现 → 确认通过 → 提交**

路径与参数（依据架构文档 §9）：

| flavor | listConfigs | getConfig |
|---|---|---|
| v1 | `GET /v1/cs/configs?search=accurate&dataId=&group=&tenant=&pageNo=&pageSize=` | `GET /v1/cs/configs?show=all&dataId=&group=&tenant=` |
| v2 | 同 v1（v2 **没有**配置列表接口） | `GET /v1/cs/configs?show=all&...`（v2 的 `/v2/cs/config` 拿不到 `type`） |
| v3-admin | `GET /v3/admin/cs/config/list?...&namespaceId=&groupName=` | `GET /v3/admin/cs/config?...` |
| v3-console | `GET /v3/console/cs/config/list?...`（`baseUrlOverride`） | `GET /v3/console/cs/config?...` |

**v2 的两个方法都落到 v1 路径**，这不是偷懒：v2 从未提供配置列表接口，而 `/v2/cs/config` 的 `data` 只是内容字符串、拿不到 `type`。在 driver 里写明理由。

**`getConfig` 必须用 `requestRaw`。** 三个原因：v1 的纯文本端点；`show=all` 虽是 JSON 但我们要自己看 404 的 body 形状；以及 content-type 不可信。

**列表请求必须设 `maxResponseBytes`。** 服务端在列表里塞完整正文，100 条 × 100KB 上限 = 10MB。取 `pageSize * 128KB` 加一个 4MB 的天花板。

- [ ] **Step 5: 真机验证**

```bash
AT_NACOS_LIVE_URL=http://192.168.99.90:8848/nacos npx vitest run test/live
```

在 `test/live/liveServer.test.ts` 追加：列出 `uat` 命名空间的配置并打印前三条的 `dataId`/`group`/`type`；取其中一条的内容并断言非空、`type` 为 `yaml`；取一个不存在的 dataId 并断言抛的是 `resource-not-found` 而非 `not-found`。

---

## Task 4: 虚拟文档

**Files:** `src/document/{configUri,NacosConfigDocumentProvider,openConfigDocument}.ts`，测试同名

- [ ] **Step 1: 写失败测试**

`configUri.test.ts`：编解码往返；dataId 含 `/`、`?`、`#`、空格、中文时不破坏 URI；空 namespaceId（1.x/2.x 的 public）能往返；两个实例的同名配置产生不同 URI；URI 不含凭据。

`NacosConfigDocumentProvider.test.ts`：`provideTextDocumentContent` 返回内容；未知实例返回一条可读的错误文本而不是抛异常（VS Code 会把 reject 显示成一个空编辑器）；`onDidChange` 在刷新时触发。

- [ ] **Step 2-4: 确认失败 → 实现 → 确认通过 → 提交**

**URI 设计。** scheme 固定 `nacos`，authority 放 instanceId，path 放 `/<namespace>/<group>/<dataId>`，各段 `encodeURIComponent`。namespaceId 为空串时用一个哨兵段（如 `_public_`），因为空 path 段会在 URI 归一化中消失。

**语言模式不靠 URI 后缀。** 用 `vscode.languages.setTextDocumentLanguage(doc, languageId)`，languageId 由 Task 2 的 `configLanguage` 给出。靠后缀意味着要在 URI 上拼一个 dataId 本来没有的扩展名，那会污染标签页标题，而且 dataId 本身常常已经带后缀。

**文档只读。** `TextDocumentContentProvider` 提供的文档天然只读，M5 的编辑走另一条路（`WorkspaceEdit` + 显式发布），不在这里放开。

---

## Task 5: 配置树的三层与分页

**Files:** `src/tree/NacosTreeItems.ts`, `src/tree/ConfigTreeProvider.ts`，测试同名

- [ ] **Step 1: 写失败测试**

覆盖：展开命名空间返回按 group 归组的 `GroupTreeItem`；展开 group 返回 `ConfigTreeItem`；配置节点的 `command` 指向打开文档；总数超过一页时命名空间下出现 `LoadMoreTreeItem`；点击 Load more 后 group 列表增长而不是重建（已展开的 group 不塌陷）；`refresh()` 清空已加载页；一个命名空间加载失败不影响另一个；配置节点 tooltip 显示 group 与 dataId 而非内容。

- [ ] **Step 2-4: 确认失败 → 实现 → 确认通过 → 提交**

**分组来自已加载的页，这是有意的取舍。** Nacos 没有「列出分组」的接口，分组只能从配置列表里推导；而列表必须分页（服务端在列表里塞正文）。所以树显示的是「已加载配置所属的分组」，随 Load more 增长。在 `GroupTreeItem` 的 tooltip 里说明这一点，否则用户会以为分组列表是完整的。

**每页 100 条。** 服务端没有上限，客户端必须自己设——依据是架构文档 §14.1。

**`LoadMoreTreeItem` 挂在命名空间下而不是 group 下**，因为下一页可能带来新的 group。

---

## Task 6: 搜索过滤

**Files:** `src/tree/ConfigTreeProvider.ts`, `package.json`, `src/extension.ts`

- [ ] **Step 1: 写失败测试**

覆盖：设置过滤后请求走 `search=blur` 且 `dataId` 带 `*` 通配；清除过滤后回到 `accurate`；过滤态下 `type` 为 null 的条目仍能推断出语言模式（与 Task 2 的后缀回退串起来）；过滤文本显示在 TreeView 的 `message` 上；过滤会重置分页。

- [ ] **Step 2-4: 确认失败 → 实现 → 确认通过 → 提交**

新增命令 `atNacos.filterConfigs` / `atNacos.clearConfigFilter`，图标 `$(filter)` / `$(clear-all)`，挂在 configs 视图的 `view/title`。nls 键两份都要加。

**blur 模式下 `type` 为 null**，所以 Task 2 的后缀回退在这里从「兜底」变成「主路径」。测试必须覆盖过滤态下打开配置仍有正确高亮。

---

## Task 7: 组装与真机验收

**Files:** `src/extension.ts`, `package.json`

- [ ] 注册 `NacosConfigDocumentProvider` 与 `atNacos.openConfig` 命令
- [ ] 两条过滤命令入 `contributes` 与 `subscriptions`
- [ ] `npx tsc --noEmit`、全量 `npx vitest run`、`npm run build` 全绿
- [ ] 真机跑 `test/live`
- [ ] 把新增的真机结论回填进架构文档 §14

---

## M2 验收标准

- [ ] 展开命名空间能看到分组，展开分组能看到 dataId
- [ ] 点击 dataId 在编辑器中打开内容，YAML 有语法高亮
- [ ] 配置数超过一页时有 Load more，点击后新分组出现且已展开的分组不塌陷
- [ ] 过滤生效，且过滤态下打开的配置仍有正确高亮
- [ ] 查询一个不存在的 dataId 报「配置不存在」而不是「没有 API 版本能服务此请求」
- [ ] 中文界面下新增文案全部本地化
- [ ] 真机（Nacos 2.3.2）上以上全部通过
