# AT Nacos 代码库地图 + 实现手册（Codebase Map & Implementation Cookbook）

> **给后续实现 Agent 的第二份该读的文档**（第一份是 [Agent 执行总入口](./2026-08-27-followup-agent-guide.md)，顺序/禁止项/Phase 依赖都在那边，本文不重复）。
> 本文回答的问题是：**在这个仓库里加一个命令、加一个 Driver 方法、加一个 Webview 面板、加一个 MCP 工具，分别要碰哪些文件、抄哪段现成代码、改哪些测试。**
>
> **基线状态约定：** 本文描述的是「Phase 0 完成后」的代码，即分支 `cursor/nacos-opt-1-8-6a9b`。被 1–8 批次改过的文件（`src/extension.ts`、`src/tree/ServiceTreeProvider.ts`、`src/document/openDraftDocument.ts`、`src/nacos/driver/configLanguage.ts`、`src/agent/NacosAgentToolService.ts`、`src/webview/NacosInstanceFormPanel.ts`、`package.json`、两个 `package.nls*.json`、`l10n/bundle.l10n.zh-cn.json`、`webview/nacos-instance-form/*` 及对应测试）以该分支为准，行号也指该分支版本；查看方式：
>
> ```bash
> git show origin/cursor/nacos-opt-1-8-6a9b:src/extension.ts | less
> ```
>
> 其余文件 `main` 与 1–8 分支相同，行号两边通用。

---

## 1. `src/` 目录地图（每文件一句话）

### 根

| 文件 | 职责 |
|---|---|
| `src/extension.ts` | **唯一组装根**。`activate` 里构建全部协作者并注入依赖；注册 27 个命令、2 个树视图、2 个文档 provider、2 个文档监听器（共 36 个 subscriptions）；`createNacosClient` 是「每次全新构建客户端」的出口，被树/面板/MCP 复用。除 UI 模块与两个薄适配器（`i18n/t`、`utils/notifications`）外，只有这里 import `vscode`。 |

### `src/config/` — 实例配置与凭据

| 文件 | 职责 |
|---|---|
| `schema.ts` | zod schema：`NacosInstanceConfig`（id/label/serverUrl/consoleUrl/authMode/readOnly/allowBackgroundAccess/时间戳）。`httpUrlSchema` 剥掉 URL userinfo（密码不落 globalState）。`.strip()` 不是 `.strict()`：为降级安装保留可读性。 |
| `NacosInstanceConfigManager.ts` | 实例 CRUD：明文字段进 `globalState`（`atNacos.instances`），密码/自定义头进 `SecretStorage`（`atNacos.password.<id>` / `atNacos.headers.<id>`）。读写都过 schema parse。 |

### `src/nacos/` — 协议层（**不 import `vscode`**，唯一例外见下）

| 文件 | 职责 |
|---|---|
| `NacosHttpClient.ts` | node:http(s) 薄封装：`requestJson`（检查业务 code）与 `requestRaw`（不抛非 2xx，调用方要读失败 body）；`form` vs `body` vs `query`；`maxResponseBytes` 流式截断；`baseUrlOverride`（3.x console 独立 origin）；`normalizeBaseUrl` 剥 query/fragment/userinfo；`SUCCESS_CODES = {0, 200}`。 |
| `NacosClient.ts` | 驱动层之上的唯一入口：每个能力一行 `resolver.run('<capability>', d => d.xxx())`；`buildDriverChain`（1.x→[v1]，2.x→[v2,v1]，3.x→[v3Admin,(v3Console),v2,v1]）；`buildChainAdvice`（admin 403 且无 console 地址时的一句话建议）。 |
| `NacosCapabilityResolver.ts` | 能力→驱动的缓存与降级步进：`NacosCapability` 字符串联合（拼错=编译错）；只对 `shouldFallThrough()`（403/404/410）走链；in-flight probe 去重；`snapshot()` 诊断。 |
| `NacosClientPool.ts` | **1–8 新增**的客户端池：按 `instance.id` 缓存 `Promise<NacosClient>`，`instanceFingerprint`（serverUrl/consoleUrl/authMode/username/readOnly/updatedAt）变更即失效；构建失败自淘汰；`evict(id)` / `clear()`。 |
| `NacosApiError.ts` | 错误分类：`network/tls/forbidden/not-found/gone/api-error/invalid-response/response-too-large/timeout/validation/resource-not-found`；`shouldFallThrough()` 决定 resolver 是否换驱动；`classifyHttpStatus` / `describeFailure`。 |
| `NacosCertTrustStore.ts` | TLS TOFU 指纹存储（globalState），`check` → `unknown/trusted/changed`。 |
| `createInteractiveCertVerifier.ts` | TOFU 的交互确认弹窗。**`src/nacos/**` 里唯一有意 import `vscode` 的文件**（弹窗天然是 UI）。 |
| `jsonGuards.ts` | `isRecord` / `toStringRecord`。 |
| `testNacosConnection.ts` | 实例表单的「测试连接」：候选 baseUrl 探测、context path 发现、console 地址发现、版本探测，一次跑完并返回诊断结构。 |
| `probe/probeServerState.ts` | `GET /v1/console/server/state`：版本、majorVersion、standalone/cluster、authEnabled；`standalone_mode` 与 `startup_mode` 两个键都读。 |
| `probe/resolveBaseUrl.ts` | `candidateBaseUrls`（裸 origin ↔ `/nacos`）、`discoverConsoleBaseUrl` / `parseConsoleHint`（3.x console 提示句）、`CONSOLE_MAJOR_VERSION = 3`。 |
| `auth/NacosAuthStrategy.ts` | 接口：`authHeaders()` + `refresh()`。 |
| `auth/NoAuthStrategy.ts` | 空头；`refresh` 恒 false。 |
| `auth/UserPasswordStrategy.ts` | `/v1/auth/login` 与 `/v3/auth/user/login`，token 缓存、in-flight 登录去重。 |
| `auth/CustomHeaderStrategy.ts` | 用户给定头的副本透传。 |
| `auth/createAuthStrategy.ts` | authMode → 策略工厂；`akSk` 目前 throw（保护未实现的表单选项）。 |
| `auth/withAuth.ts` | 把策略包在 http 客户端外：注入头、403 时 `refresh()` 后重试一次。产出与 `NacosHttpClient` 同形（`requestJson`+`requestRaw`）。 |

### `src/nacos/driver/` — 四方言驱动

| 文件 | 职责 |
|---|---|
| `NacosDriver.ts` | **接口真源**：`NacosDriver`（16 个方法，加一个 = 四个实现全要动，TypeScript 强制）；查询类型（`NacosConfigListQuery` 等）；配置读路径的共享实现 `fetchNamespaces` / `fetchConfigPage` / `fetchConfigDetail`；列表响应字节上限 `listResponseCap`。 |
| `normalize.ts` | 响应归一化 + **参数方言映射**：`namespaceParamName` / `groupParamName` / `configTagsParamName` / `clusterParamName`、`publicNamespaceId`、`splitGroupedServiceName` / `groupedServiceName`、`unwrapData` / `unwrapDataArray` / `normalizePaged`、各 `normalizeXxx`（列表条目**主动丢弃 `content`**）。 |
| `naming.ts` | 服务/实例/集群的共享实现：catalog vs 名字列举 vs 3.x 分页（`listServicesPreferringCounts` 内部降级，不走 resolver）；`serviceIdentityParams`；`fetchInstances` / `fetchSubscribers` / `fetchClusterNodes` / `fetchServerMetrics`；`missingCapability`（`not-found`，不发请求即拒绝）。 |
| `history.ts` | 历史/监听者共享实现：`fetchConfigHistoryPage` / `fetchConfigHistoryDetail` / `fetchConfigListeners` / `fetchListenedConfigs`。 |
| `writes.ts` | 三个写的共享实现：`publishConfigAt`（**form**）、`deleteConfigAt`（**query**）、`updateInstanceHealthAt`（**整行 form**）；`requiredType`（空 type 直接 `validation` 拒绝）；`assertWriteAccepted`（HTTP 200+`false` = 拒绝，不降级）。 |
| `configLanguage.ts` | `type`/dataId 后缀 → VS Code language id；**1–8 新增** `configTypeForDataId`（新建配置的反向推断，复用同一后缀表防漂移）。 |
| `springErrorPage.ts` | `isSpringErrorPage`：区分「端点不存在的 404」与「资源不存在的 404」。 |
| `V1Driver.ts` | v1 路径集（`/v1/cs/configs`、`/v1/ns/...`、`/v1/console/namespaces`），config 模块说 `tenant`/`group` 方言。 |
| `V2Driver.ts` | v2 路径集；**配置/历史/订阅者/监听者全部借 v1 路径与 v1 方言**（v2 没有这些端点，真机验证 §14.8）。 |
| `V3AdminDriver.ts` | `/v3/admin/**`，同 origin 同 context path，admin 权限。 |
| `V3ConsoleDriver.ts` | `/v3/console/**`，**不同 origin**（默认 8080、空 context path）——每个请求必须带 `onConsoleOrigin()`；`getServerMetrics` 用 `missingCapability` 直接拒绝（console 没有该端点）。 |

### `src/tree/` — 两个树视图

| 文件 | 职责 |
|---|---|
| `NacosTreeBase.ts` | 实例层+命名空间层的共享 `TreeDataProvider`：in-flight Promise 缓存、失败自淘汰+身份校验、错误渲染为 `ErrorTreeItem` 而不是抛（抛=整个视图变空）。 |
| `NacosTreeItems.ts` | 所有节点类 + `contextValueFor`（readOnly → `.readonly` 后缀）+ `treeItemId`（分段百分号编码）+ 三个命令 id 常量（`OPEN_CONFIG_COMMAND` 等）。 |
| `ConfigTreeProvider.ts` | 配置树：命名空间→分组（由已加载页推导）→配置；每页 100；`loadMore` 只重画该命名空间子树；dataId 过滤（交给 driver 的 `search`，blur+`*term*`）。 |
| `ServiceTreeProvider.ts` | 服务树（**1–8 加了服务名过滤**）：命名空间→分组→服务→实例；`fetchPage` **不传 `group`**（见 §12 地雷 ④）；`serviceName` 过滤透传给 driver 的 `serviceNameParam`。 |

### `src/document/` — 虚拟文档与草稿

| 文件 | 职责 |
|---|---|
| `configUri.ts` | `nacos:` 只读地址：`/<instance>/<ns>/<group>/<dataId>`，公共命名空间哨兵 `$public`，历史版本走 `?nid=`；`buildConfigUri` / `buildConfigHistoryUri` / `parseConfigUri`。 |
| `draftUri.ts` | `nacos-draft:` 草稿地址，同四段结构；`buildDraftUri` / `parseDraftUri`。 |
| `NacosConfigDocumentProvider.ts` | `nacos:` 的 `TextDocumentContentProvider`：**失败以可读文案 resolve 而不是 reject**；`refresh(instanceId, ref)` 触发重取。 |
| `NacosDraftFileSystemProvider.ts` | `nacos-draft:` 的内存 `FileSystemProvider`：Ctrl+S 只落内存（保存≠发布）；`DraftEntry` 携带 `baseContent`/`type`/`appName`/`description` 供发布回写整行；`isDirty` / `markClean` / `deleteDraft`。 |
| `openConfigDocument.ts` | 打开只读配置：`openTextDocument` + `setTextDocumentLanguage`（不改 tab 名）。 |
| `openDraftDocument.ts` | 打开草稿（**1–8 加 `createNew`**）：`assertWritable` → 取详情或空详情（`resource-not-found` 视为空 = upsert 语义）→ 建草稿 → 设语言。 |
| `diffConfig.ts` | 三个 diff 入口：与上一版对比、历史版本对比、跨环境对比；`historyVersionLabel`；命名空间挑选样板。 |

### `src/write/` — 写路径（确认闸门）

| 文件 | 职责 |
|---|---|
| `confirmWrite.ts` | `assertWritable`（只读双层的第二层）+ `confirmWrite`（可选先开 diff，再 modal 确认）。 |
| `publishConfig.ts` | 发布管线：重读服务端（`resource-not-found` → 空内容）→ 冲突检测（`baseContent` vs 服务端）→ diff+modal → 携带 type/appName/description 整行发布 → `markClean` + `refreshDocument` + `onPublished`。 |
| `deleteConfig.ts` | 删除管线：modal（含 dataId 复述）→ `client.deleteConfig` → 丢草稿 + 刷新。 |
| `rollbackConfig.ts` | 回滚 = 读历史版本 + 以当前 dataId 重新发布（Nacos 无回滚端点）；diff+modal 里说清这个语义。 |
| `updateInstanceHealth.ts` | 上下线：modal → **整个 `NacosInstance` 原样回传**只改 `enabled`。 |

### `src/webview/` — 面板（扩展侧）

| 文件 | 职责 |
|---|---|
| `html.ts` | `renderWebviewHtml`：严格 CSP + nonce + `<script type="application/json">` 数据块（`renderJsonScript` 转义 `<`）；`escapeAttr`。 |
| `panelParts.ts` | 面板公共件：`renderPanelHeader`（标题+描述+Refresh 按钮）、`renderPanelSection`、`note`/`errorNote`/`loadingNote`/`notReported`、`messageType`、`settle`。 |
| `openPanels.ts` | 全局面板注册表：`openOrRevealPanel(key, create)`（二次点击 reveal 不重开）、`panelKey`（分段编码）、`disposeOpenPanels`（deactivate 用）。 |
| `ClusterStatusPanel.ts` | 集群状态面板：节点表+指标格，双能力各自 `settle` 失败互不拖累。 |
| `ConfigHistoryPanel.ts` | 配置历史面板：一页 100（服务端钳 500）；`shownVersions()` 安全闸（页面发来的 id 必须在已渲染条目里才会变成发给服务器的 `nid`）；`diff`/`rollback` 消息。 |
| `ConfigListenersPanel.ts` | 配置监听者面板（自己取一次详情拿真 md5，快照只留 md5 不留正文）。 |
| `ServiceSubscribersPanel.ts` | 服务订阅者面板（port 0 = gRPC，是答案不是缺失）。 |
| `NacosInstanceFormPanel.ts` | 实例表单（增/改）：zod 校验页面 payload、`retainContextWhenHidden: true`（表单必开）、测试连接 seam；**1–8 加了 `allowBackgroundAccess` 开关与状态镜像**。 |

### `src/mcp/` + `src/agent/` — MCP 桥（**不 import `vscode`**）

| 文件 | 职责 |
|---|---|
| `mcp/toolCatalog.ts` | `AT_NACOS_PLUGIN_ID = 'at.nacos'` + 13 个只读工具目录（name/title/**description 即契约**/risk/inputSchema）。 |
| `mcp/bridgeSchemas.ts` | 每个工具的 zod schema（全 `.strict()`）+ JSON Schema 孪生（`additionalProperties: false`）+ `describeZodError`。 |
| `mcp/BridgeServer.ts` | 本机 HTTP 桥：随机端口 + token、注册记录发布（FsBridgePublisher）、心跳、`/invoke` 转发给 tool service。 |
| `mcp/BridgeProtocol.ts` | 协议常量转出（`AT_SERIES_PROTOCOL_VERSION` 等）+ 插件显示名。 |
| `mcp/McpConfigInstaller.ts` | 把 AT Series MCP 配置写进当前 IDE（Cursor 等；纯 VS Code 诚实返回 `undefined`）。 |
| `mcp/hubSync.ts` | 打包的 hub bundle 同步到用户目录（版本比对）。 |
| `agent/NacosAgentToolService.ts` | 工具实现：`invoke(name, args)` switch → zod parse → `resolveInstance`（**`allowBackgroundAccess` 闸门**）→ 每次调用新建客户端（非交互 cert verifier）→ 结果脱敏（`redactSensitiveText`，`raw: true` 才裸）。 |

### `src/utils/` + `src/i18n/`

| 文件 | 职责 |
|---|---|
| `utils/logger.ts` | `AtNacosLog`（结构声明，不 import vscode）+ `createRedactedLog` / `asRedactedLog`（唯一允许向 channel 写字的路径）+ `noopLog`。 |
| `utils/errors.ts` | `formatError`（= 脱敏后的用户可读消息）+ `UserVisibleError`。 |
| `utils/redaction.ts` | 配置正文里的密码/token/key 模式脱敏；幂等。 |
| `utils/notifications.ts` | `withLoadingProgress` / 定时通知（import vscode 的薄适配器）。 |
| `utils/nonce.ts` | CSP nonce。 |
| `utils/time.ts` | `formatTimestamp`（本地时区、定宽）。 |
| `utils/url.ts` | `stripUrlCredentials`。 |
| `i18n/t.ts` | `t(englishSource, args?)` → `vscode.l10n.t`；`buildWebviewStrings`（页面拿不到 `vscode.l10n`，副本在扩展侧翻好当数据传）。 |

### `webview/`（`src/` 之外的页面脚本，浏览器环境，**禁止 import `vscode`**）

| 目录 | 职责 |
|---|---|
| `webview/nacos-instance-form/` | 表单页脚本（`index.ts` + **1–8 新增** `state.ts` 状态镜像）+ CSS。`acquireVsCodeApi()` + `postMessage`，一切校验在扩展侧。 |
| `webview/nacos-cluster-status/` | 集群面板页脚本（Refresh + raft 展开）。 |
| `webview/nacos-config-history/` | 历史面板页脚本（事件委托，只传 id）。 |
| `webview/nacos-consumers/` | 监听者与订阅者**共用**的一个 bundle（`esbuild.config.mjs` 注释明说一 bundle 多面板）。 |

esbuild 出口：扩展 → `dist/extension.js`（cjs/node），每个页面 → `dist/webview/<name>.js`（iife/browser/chrome114）。

---

## 2. 运行时数据流（五条主链路）

### 2.1 打开配置（树节点单击）

```
ConfigTreeItem.command = { command: 'atNacos.openConfig', arguments: [instanceId, config] }
        │  (NacosTreeItems.ts:197-201)
        ▼
extension.ts:418-439  openConfigCommand
        │  withLoadingProgress(t('Loading configuration {dataId}...'))
        ▼
openConfigDocument(instanceId, config)          src/document/openConfigDocument.ts
        │  buildConfigUri → nacos:/<inst>/<ns|$public>/<group>/<dataId>
        │  openTextDocument(uri) ──────────────► VS Code 向 provider 要内容
        ▼
NacosConfigDocumentProvider.provideTextDocumentContent   (NacosConfigDocumentProvider.ts:71-95)
        │  parseConfigUri → getInstance(重新按 id 读，不信任节点)
        │  createClient(instance)  = extension.ts 里的 getOrCreateClient → NacosClientPool
        ▼
NacosClient.getConfig(ref) → resolver.run('config-detail', ...)
        │  V2Driver → fetchConfigDetail(http, 'v1', '/v1/cs/configs', ref, {query:{show:'all'}})
        ▼
内容返回编辑器；失败 → describeReadFailure 变成 buffer 里的可读文案（绝不空编辑器）
之后 openConfigDocument 再 setTextDocumentLanguage(configLanguageId(config))
```

### 2.2 发布配置（草稿 → 服务器）

```
入口 A: 配置节点右键 Edit → openDraftDocument（assertWritable → getConfig/空详情 → initDraft）
入口 B: atNacos.createConfig（命名空间/分组节点）→ askForNewConfigRef → openDraftDocument({createNew:true})
        │  用户编辑，Ctrl+S 只写内存草稿（NacosDraftFileSystemProvider.writeFile）
        │  onDidSaveTextDocument → 状态栏提示「Run "Publish"...」 (extension.ts:811-826)
        ▼
atNacos.publishConfig  (extension.ts:760-804；节点触发或 activeTextEditor 的 draft URI 解析)
        ▼
publishConfig(options)                      src/write/publishConfig.ts:33-104
        │  ① assertWritable(instance)          ← 只读第二层
        │  ② draftProvider.getDraft — 没草稿则警告返回
        │  ③ client.getConfig(ref) 重读服务端；resource-not-found → serverContent = ''（首发=插入）
        │  ④ baseContent !== serverContent → 冲突警示文案
        │  ⑤ confirmWrite({ diff: {left: nacos: URI, right: nacos-draft: URI}, modal })
        │  ⑥ client.publishConfig({...ref, content, type, appName, description})  ← 整行
        ▼
V?Driver.publishConfig → publishConfigAt(http, flavor, path, req)   writes.ts:26-48
        │  POST + form（绝不 JSON body）→ assertWriteAccepted（200+false = 拒绝，不降级）
        ▼
markClean → refreshDocument（nacos: 文档重取）→ onPublished = refreshAfterConfigWrite()（只重画配置树，不清池）
```

### 2.3 树展开（服务树，四层）

```
VS Code getChildren(element)
  root ──► NacosTreeBase.getRootChildren → configManager.listInstances → InstanceTreeItem[]
  instance ──► loadNamespaces（in-flight Promise 缓存，失败自淘汰）
      │   getOrCreateClient(instance) ──► NacosClientPool.getClient
      │        池命中且指纹一致 → 直接复用（不再 login/不再 probe）
      │        未命中 → createNacosClient：Http → auth → withAuth → probeServerState
      │                  → resolveConsoleBaseUrl → buildDriverChain → resolver → NacosClient
      ▼   client.listNamespaces() → NamespaceTreeItem[]（majorVersion 决定 public 标签）
  namespace ──► ServiceTreeProvider.loadServices → fetchPage
      │   client.listServices({namespaceId, pageNo, pageSize:100, serviceName:filter})
      │   ── 不传 group！──  groupServices() 由结果推导分组 → GroupTreeItem[] (+LoadMore)
  group ──► 同一页缓存过滤 service.group === element.group → ServiceTreeItem[]
  service ──► loadInstances → client.listInstances(ref) → ServiceInstanceTreeItem[]
每一层失败 → ErrorTreeItem(scope, formatError(e), ownerId)，绝不向上抛
```

### 2.4 MCP 工具调用（Agent → 桥 → Nacos）

```
MCP 客户端（经 AT Series Hub）
        │ POST http://127.0.0.1:<port>/invoke  (token 头，timingSafeEqual)
        ▼
BridgeServer（src/mcp/BridgeServer.ts）：路由 + 目录（AT_NACOS_TOOL_CATALOG）+ schema 预检
        ▼
NacosAgentToolService.invoke(name, args)      (src/agent/NacosAgentToolService.ts:98-141)
        │  ① zod .strict() parse → 失败 VALIDATION_ERROR（describeZodError）
        │  ② resolveInstance(instanceId)      (:169-205)
        │       getInstance → 无 → NOT_FOUND
        │       !allowBackgroundAccess → UNAVAILABLE  ← MCP 侧唯一闸门（无菜单可藏）
        │       非交互 certVerifier（只认已 trusted 的指纹，绝不弹窗）
        │  ③ createClient(instance, certVerifier)  ← 不走 NacosClientPool（extension.ts:263-267
        │       注释：池按 id 键控，混用会把交互 verifier 的客户端交给后台调用）
        │  ④ client.listXxx(...) → 结果脱敏（getConfig/getConfigHistory 默认 redactSensitiveText）
        ▼
{ok:true,result} / {ok:false,code,message} 原样回给 Hub
```

### 2.5 实例表单保存

```
atNacos.addInstance / atNacos.editInstance / manageInstances
        ▼
NacosInstanceFormPanel.open(context, configManager, onSaved, existing?, {testConnection})
        │  先读 SecretStorage（hasStoredPassword/hasStoredHeaders）再建 panel
        │  createWebviewPanel(..., { retainContextWhenHidden: true })   ← 表单必开
        │  renderWebviewHtml(webview, {script: dist/webview/nacos-instance-form.js, style}, body, data)
        ▼
页面（webview/nacos-instance-form/index.ts）：读字段 → vscode.postMessage({type:'submit', payload})
        │  （state.ts 把字段镜像进 setState，防不可避免的重建丢输入）
        ▼
handleInstanceFormMessage（NacosInstanceFormPanel.ts:144+，纯函数可测）
        │  instanceFormPayloadSchema.strict-ish parse → 校验 URL/头名（RFC 9110 token）
        │  createInstance / updateInstance（密码与头写 SecretStorage）
        ▼
onSaved() = extension.ts:228-229 的 () => refreshAfterInstanceChange(existing?.id)
        │  clientPool.evict(该实例) + 两棵树都 refresh()（实例是两棵树的根节点）
        ▼
panel.dispose()；测试连接消息则走 options.testConnection（带 cert verifier + log 的 seam）
```

---

## 3. 如何新增一个 VS Code 命令（精确清单）

以一个假想的 `atNacos.doThing` 为例，六处缺一不可，每处都有测试盯着：

### 3.1 `package.json` `contributes.commands`

```json
{
  "command": "atNacos.doThing",
  "title": "%atNacos.command.doThing.title%",
  "icon": "$(beaker)"
}
```

- title **必须**是 `%atNacos.command.<name>.title%` 占位符（`test/i18n/nls.test.ts:191-199` 禁止把占位符嵌进长串；`:201-208` 禁止留无人引用的 nls 键）。
- icon 只在会出现于 `view/title` 或 `editor/title` 时需要（无 icon 的 view/title 项会折进 `...` 溢出菜单，`Manifest.test.ts:102-114` 有先例断言）。

### 3.2 `package.nls.json` + `package.nls.zh-cn.json`

```json
// package.nls.json
"atNacos.command.doThing.title": "AT Nacos: Do Thing",
// package.nls.zh-cn.json
"atNacos.command.doThing.title": "AT Nacos: 做那件事",
```

两个文件**键集合必须完全一致**（`nls.test.ts:25-30`），键必须以 `atNacos.` 开头（`:38-44`），值不能为空（`:32-36`）。

### 3.3 `menus.commandPalette` — 二选一，没有第三种

- **命令需要树节点参数** → 必须 `"when": "false"` 藏出面板（否则从面板触发时 `item` 是 `undefined`）：

```json
{ "command": "atNacos.doThing", "when": "false" }
```

- **命令无参或自己会问**（类比 `installMcpConfig`、`openClusterStatus`）→ **不写** commandPalette 条目（写了只会藏掉它）。

`Manifest.test.ts:186-191` 断言 commandPalette 里每一条的 `when` 都是字面 `"false"`——**不允许**用 `resourceScheme == nacos-draft` 之类的条件放行（editor/title 才用 resourceScheme，见 `package.json:242-248` 的 `publishConfig` 先例）。1–8 分支现有 16 条 `when:false`：`openConfig`、`loadMoreConfigs`、`loadMoreServices`、`showConfigHistory`、`diffWithPrevious`、`compareAcrossEnvironments`、`showConfigListeners`、`showServiceSubscribers`、`createConfig`、`editConfig`、`publishConfig`、`deleteConfig`、`enableServiceInstance`、`disableServiceInstance`、`editInstance`、`deleteInstance`（`Manifest.test.ts:147-171` 的 `it.each` 与此逐条对应，新增藏面板命令要同步加进这个数组）。

### 3.4 `menus.view/item/context` — **每个命令只贡献一条**

`Manifest.test.ts:204-208` 的 `nodeMenu()` 辅助函数对每个命令断言 `toHaveLength(1)`。一个命令要挂两种节点时，用一条 `when` 里的 `||`，抄 `createConfig` 的现成样板（`package.json:265-269`，1–8 分支）：

```json
{
  "command": "atNacos.createConfig",
  "when": "viewItem == atNacos.namespace || viewItem == atNacos.group",
  "group": "atNacos.modify@0"
}
```

when 写法三选一（都有先例）：

| 意图 | 写法 | 先例 |
|---|---|---|
| 只在**可写**节点出现（写命令） | `viewItem == atNacos.config`（精确等于，`.readonly` 后缀自然不匹配） | `editConfig`/`publishConfig`/`deleteConfig` |
| 可写与只读**都**出现（读命令） | `viewItem =~ /^atNacos\\.config\\b/`（`\b` 让 `.readonly` 也命中） | `showConfigHistory` 等四条 inspect |
| 前缀陷阱防护 | `^atNacos\\.instance\\b` 匹配实例但不匹配 `atNacos.serviceInstance.*`；同理 `^atNacos\\.service\\b` 不匹配 serviceInstance | `editInstance`/`showServiceSubscribers` |

group 命名：检查类 `atNacos.inspect@N`，修改类 `atNacos.modify@N`（`Manifest.test.ts:335-344` 锁着 inspect 组的格式）。

新增后**必须**在 `Manifest.test.ts` 加对应 `nodeMenu()` 用例：用真实 TreeItem 的 `contextValue`（`configNodeValue(readOnly)` 等 :223-260 的构造器）去 `contextValuePattern()`（:198-202，把 when 编译成真正的 RegExp 再 test，防「匹配不到任何东西的正则」也通过文本断言）。

### 3.5 `src/extension.ts` — 注册 + push

抄这个仓库的固定形状（每个命令自己 try/catch、自己 log、自己 showErrorMessage——「菜单点了没反应等于死节点」，extension.ts:556-563 注释）：

```ts
const doThingCommand = vscode.commands.registerCommand(
  'atNacos.doThing',
  async (item: ConfigTreeItem) => {
    try {
      const instance = await configManager.getInstance(item.instance.id); // 按 id 重读，不信任节点快照
      if (!instance) {
        return;
      }
      // ... 干活；写操作先 assertWritable，成功后调对应的 refreshAfterXxx()
    } catch (error) {
      const message = formatError(error);
      log.error(`doThing: ${message}`);
      await vscode.window.showErrorMessage(t('Could not do the thing: {message}', { message }));
    }
  }
);
```

然后**两件事**：
1. 把 `doThingCommand` 加进 `context.subscriptions.push(...)`（extension.ts:999-1040）。
2. `t()` 的英文源串写进 `l10n/bundle.l10n.zh-cn.json`（见 §7）。

### 3.6 测试记账（漏一处 CI 必红）

**`test/extension/ExtensionLifecycle.test.ts:36-64`** —— 完整**排序**命令数组。1–8 分支当前的 27 个（新增命令按字母序插进去）：

```
atNacos.addInstance            atNacos.clearConfigFilter      atNacos.clearServiceFilter
atNacos.compareAcrossEnvironments  atNacos.createConfig       atNacos.deleteConfig
atNacos.deleteInstance         atNacos.diffWithPrevious       atNacos.disableServiceInstance
atNacos.editConfig             atNacos.editInstance           atNacos.enableServiceInstance
atNacos.filterConfigs          atNacos.filterServices         atNacos.installMcpConfig
atNacos.loadMoreConfigs        atNacos.loadMoreServices       atNacos.manageInstances
atNacos.openClusterStatus      atNacos.openConfig             atNacos.publishConfig
atNacos.refreshConfigs         atNacos.refreshServices        atNacos.showConfigHistory
atNacos.showConfigListeners    atNacos.showServiceSubscribers atNacos.uninstallMcpConfig
```

**同文件 :82-94** —— `expect(context.subscriptions).toHaveLength(36)`。1–8 分支的 36 = 1 个 logChannel + 27 个命令 + 2 个 treeView + 4 个 provider/registration（config provider、它的 registration、draft provider、它的 registration）+ 2 个文档监听器（save、close）。加一个命令 → 37，**注释里的英文数字「twenty-seven commands」也要改**（Agent 总入口 §3 第 4 条）。

**`test/extension/Manifest.test.ts`** —— `it.each` 数组：藏面板的加进 :147-163；面板可见的加进 :178 那组（installMcpConfig/uninstallMcpConfig 样板：断言**存在**于 commands 且**不存在**于 commandPalette）；挂节点菜单的按 §3.4 加 `nodeMenu()` 用例。`:56-66` 的「注册集合 === 贡献集合」和 `:81-91` 的「菜单只引用已贡献命令」会自动覆盖新命令，无需改动。

**命令行为本身的测试**放 `test/extension/` 下的对应文件（`WriteCommands.test.ts` / `ConfigCommands.test.ts` / `InstanceCommands.test.ts`……），用 `test-fixtures/vscode.ts` 的 `__getRegisteredCommands().get('atNacos.doThing')?.(item)` 直接调 handler（样板遍地都是）。

---

## 4. 如何新增一个 Driver 方法

### 4.1 改哪些文件（顺序即依赖）

1. **`src/nacos/driver/NacosDriver.ts`** —— 接口加方法（+ 需要的 Query/Request 类型）。TypeScript 立刻把 `V1Driver`/`V2Driver`/`V3AdminDriver`/`V3ConsoleDriver` 四个全标红——**这是设计**（NacosDriver.ts:201-206 注释：「每次加宽都必须把四个实现一起带上」）。
2. **共享实现**放对应主题文件：配置读 → `NacosDriver.ts` 自己（`fetchConfigPage` 旁），naming → `naming.ts`，历史/监听 → `history.ts`，写 → `writes.ts`。**只有路径和方言参数留在各 Driver 文件里**（NacosDriver.ts:267-276 注释：unwrap/校验/归一化必须逐字相同，否则空 `data` 在一个版本抛 TypeError、另一个版本抛 NacosApiError，降级链行为随服务器版本漂移）。
3. **归一化**放 `normalize.ts`（新响应形状 → 新 `normalizeXxx` + 接口类型）。
4. **`src/nacos/NacosCapabilityResolver.ts`** —— `NacosCapability` 联合加一个键（:17-44）。拆分粒度规则写在注释里：**一个服务器可能服务其一而拒绝其二的，就是两个键**（listing 和 detail 从来分开；三个写各一个键）。
5. **`src/nacos/NacosClient.ts`** —— 加一行转发：

```ts
doThing(query: NacosDoThingQuery): Promise<NacosDoThingResult> {
  return this.resolver.run('do-thing', (driver) => driver.doThing(query));
}
```

### 4.2 四个实现的样板

**读（JSON envelope）** —— 抄 `V3ConsoleDriver.listConfigs`（V3ConsoleDriver.ts:116-118）：

```ts
// V3ConsoleDriver 里：每个请求都要 onConsoleOrigin()，忘了 = 请求打到 8848 上
// 不存在的 /v3/console/... 路径，404 被误读成「这个版本没有 console API」
doThing(query: NacosDoThingQuery): Promise<NacosDoThingResult> {
  return fetchDoThing(this.http, this.flavor, DO_THING_PATH, query, this.onConsoleOrigin());
}
```

`onConsoleOrigin()`（V3ConsoleDriver.ts:199-201）返回 `{ baseUrlOverride: this.consoleBaseUrl }`——它存在的理由就是「后加的能力不能成为忘掉 override 的那一个」。

**某方言没有这个端点** —— 不发请求，直接 `missingCapability`（抄 `V3ConsoleDriver.getServerMetrics`，:173-179）：

```ts
doThing(): Promise<NacosDoThingResult> {
  return Promise.reject(
    missingCapability("Nacos 3.x's console API has no such endpoint; only the admin API serves it.")
  );
}
```

`missingCapability`（naming.ts:355-357）造一个 `not-found`，resolver 视同真 404 直接走下一个驱动，省一次注定失败的往返。

**V2Driver 注意**：配置模块的请求走 **v1 路径 + v1 方言**（v2 没有配置列表端点；历史端点存在但要 v1 的 `group` 拼法——半 v1 半 v2 的第三方言被有意放弃，架构 §14.8 ②）。新配置类能力在 V2Driver 里大概率也是 `fetchXxx(this.http, 'v1', V1_PATH, ...)` 的形状，抄 `V2Driver.listConfigs`。

### 4.3 参数方言：永远用映射函数，永远不手写

| 参数 | 函数 | 规则 |
|---|---|---|
| 命名空间 | `namespaceParamName(flavor, module)`（normalize.ts:53-55） | 只有 v1 的 **config** 模块说 `tenant`；v1 naming 与 v2/v3 都说 `namespaceId` |
| 分组 | `groupParamName(flavor, module)`（:66-68） | 与上面同刀切分：只有 v1 config 说 `group`，其余 `groupName`。**两个函数必须成对用**——`tenant`+`groupName` 是半个方言，服务器静默丢掉不认识的那半 |
| 配置标签 | `configTagsParamName(flavor)`（:79-81） | v1 `config_tags`，v2/v3 `configTags` |
| 集群过滤 | `clusterParamName(flavor)`（:93-95） | v1 `clusters`（复数、逗号分隔），v2/v3 `clusterName` |
| 服务身份 | `serviceIdentityParams(flavor, ref)`（naming.ts:264+） | v1 把分组拼进 `serviceName`（`groupedServiceName`），v2/v3 分开传 |

`flavor` 参数读作**端点家族**而不是驱动身份：V2Driver 打 v1 端点时传 `'v1'`。

### 4.4 form vs query（写操作的生死线）

`writes.ts` 开头两段注释就是规则本身：

- **发布 = POST + `form`**（writes.ts:13-25）：所有 Nacos 写端点用 `@RequestParam` 绑参，Spring 只读 query string 和 `x-www-form-urlencoded` body。JSON body **不被拒绝而是被无视**，然后服务器答「parameter missing」——报的是一个请求明明发了的字段。
- **删除 = DELETE + `query`**（writes.ts:50-61）：servlet 容器只为 POST 解析 form body，DELETE 的 form body 到不了任何 `@RequestParam`。
- **实例更新 = PUT + 整行 `form`**（writes.ts:97-127）：布尔和数字全部 `String(...)`（form 只有文本），metadata `JSON.stringify` 且空也发。

### 4.5 写响应判定：`assertWriteAccepted`

任何新写能力的收尾必须是它（writes.ts:189-218），不要自己解析：

- 非 2xx → 按状态分类（403/404/410 可降级）。
- HTTP 200 + 业务 code 非 {0,200} → `api-error`。
- `true` / `'true'` / `'ok'` → 成功。
- **`false` → `api-error` 抛出且不降级**——那是服务器拒绝了这次写（权限/校验），换一个 API 家族重放一次被拒的写是没人想要的那种重试。
- 其它 → `invalid-response`（「写没写成无从判断」，沉默不是同意）。

### 4.6 测试位置与样板

- **驱动测试**：`test/nacos/driver/` 按主题分文件（`configDrivers` / `namingDrivers` / `writeDrivers` / `historyDrivers` / `namespaceDrivers` / `listenedConfigs`），全部用 `test/nacos/testHttpServer.ts` 起真 HTTP 服务器断言**请求的路径/参数/方法/body 形态**与**四方言各自的响应解析**。新能力照抄同主题文件里最近的 describe。
- **归一化测试**：`test/nacos/driver/normalize.test.ts` / `namingNormalize.test.ts` / `historyNormalize.test.ts`——喂研究得来的各版本响应原文。
- **NacosClient 转发**：`test/nacos/NacosClient.test.ts`（能力键、驱动链顺序）。
- 单文件跑法：`npx vitest run test/nacos/driver/writeDrivers.test.ts`。

---

## 5. 如何新增一个 Webview 面板

**模板选择**：只读展示面板抄 `ClusterStatusPanel.ts`（最小）；带行内动作/需要安全闸的抄 `ConfigHistoryPanel.ts`（`shownVersions()` 模式）；表单类抄 `NacosInstanceFormPanel.ts`。

### 5.1 固定骨架（逐条对应现成代码）

```ts
export class DoThingPanel {
  static async open(context: vscode.ExtensionContext, options: DoThingPanelOptions): Promise<void> {
    // ① openPanels.ts:29-43 —— 二次点击 reveal 不重开；key 用 panelKey 分段编码
    const panel = openOrRevealPanel(panelKey('doThing', options.instance.id), () =>
      vscode.window.createWebviewPanel(
        'atNacos.doThing',                       // viewType
        doThingTitle(options.instance.label),    // 标题走 t()
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [context.extensionUri] }
        // ②（仅表单）加 retainContextWhenHidden: true —— 隐藏即重建会把没保存的输入
        //   （含密码）清空；展示类面板不要加，白占内存
      )
    );
    if (!panel) return; // reveal 了已有面板，别重渲，会丢用户滚动位置

    const messageOptions: DoThingMessageOptions = {
      load: () => loadDoThing(options.connect),   // 每次 Refresh 重新 connect（编辑过的实例立即生效）
      renderDocument: (view) =>
        renderWebviewHtml(                        // ③ html.ts:21-46 —— CSP + nonce 都在这，别自己写 <html>
          panel.webview,
          {
            script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'nacos-do-thing.js'),
            style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'nacos-do-thing', 'index.css')
          },
          view.body,
          view.data
        )
    };
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      await handleDoThingMessage(message, panel, messageOptions);  // ④ 导出的纯函数，测试直接调
    });

    // ⑤ 先渲 loading 骨架再渲数据（ClusterStatusPanel.ts:113-121 注释：慢服务器上
    //   按钮点了几秒没反应 = 按钮看起来坏了；双击的第二下也有面板可 reveal）
    panel.webview.html = messageOptions.renderDocument(renderDoThing({ instanceLabel: options.instance.label }));
    panel.webview.html = messageOptions.renderDocument(await doThingView(messageOptions));
  }
}
```

### 5.2 渲染层规则

- body 用 `panelParts.ts` 的件拼：`renderPanelHeader`（自带 Refresh 按钮，不可选退）、`renderPanelSection`、`note`/`errorNote`/`loadingNote`/`notReported`。
- **所有插进 HTML 的动态文本过 `escapeAttr`**（html.ts:92-99）；每个面板测试都有 XSS 用例（如 dataId 含 `<img>` 被转义）。
- 数据加载走 `settle()`（panelParts.ts:78-84）：多能力各自失败互不拖累，错误变文案不 reject（面板是失败唯一的展示面）。
- 页面要用的字符串走 `buildWebviewStrings`（i18n/t.ts:35-41）翻好放进 `data`，`renderWebviewHtml` 会序列化成 `<script type="application/json">` 块（`renderJsonScript` 已处理 `<` 转义，别自己拼）。

### 5.3 页面脚本

- 新建 `webview/nacos-do-thing/index.ts` + `index.css`；**绝不 import `vscode`**（浏览器环境，只有 `acquireVsCodeApi()`）。行为与监听者/订阅者一致的「刷新即全部」面板**直接复用现成的 `dist/webview/nacos-consumers.js`**，不加 esbuild entry（Phase A8 就是这么规划的）。
- 需要新 bundle 时在 `esbuild.config.mjs` 照抄一段 context（`platform:'browser', format:'iife', target:'chrome114'`）。
- 页面只发 `{type:'...', ...最小数据}`；**一切校验与决定在扩展侧**。带 id 的消息必须过 `shownVersions()` 式白名单（ConfigHistoryPanel.ts:56-63：页面发来的 id 会变成发给服务器的参数，所以只受理当前渲染过的）。

### 5.4 关闭与测试

- 不用手动管 dispose：`openOrRevealPanel` 已做注册表登记，`deactivate` 的 `disposeOpenPanels()`（openPanels.ts:52-58）统一收尾。
- 测试放 `test/webview/DoThingPanel.test.ts`，模板 `ClusterStatusPanel.test.ts` / `ConfigListenersPanel.test.ts`：断言渲出的 HTML 字符串（含空态句、错误句、not reported、XSS 转义）、`handleXxxMessage` 对 `refresh` 重渲/对未知消息返回 false、`load` 把参数原样传给 client。

---

## 6. 如何新增一个 MCP 工具

### 6.1 三处代码 + 一处纪律

1. **`src/mcp/bridgeSchemas.ts`**：zod schema（**`.strict()`**）+ JSON Schema 孪生（**`additionalProperties: false`**）+ 类型导出，照抄 `nacosGetConfigSchema` 一组三件。
2. **`src/mcp/toolCatalog.ts`**：目录条目。**description 是契约不是注释**——现有 13 条把「默认值、上限、与相邻工具的区分、版本差异陷阱」全写进去（如 `nacos_list_instances` 明说「这是插件连接不是 Nacos service hosts」，`nacos_list_namespaces` 明说「1.x/2.x 默认命名空间是空串、3.x 是 public、不要互代」）。新工具照此密度写，模板：

```ts
{
  name: 'nacos_do_thing',
  title: 'Do the thing on Nacos',
  description:
    'One sentence of what it returns. ' +
    'Defaults and ceilings spelled out (pageNo 1, pageSize 100, max 500). ' +
    'How it differs from the neighbouring tool an agent will confuse it with. ' +
    'The version trap that silently returns empty.',
  risk: 'read',
  inputSchema: NACOS_DO_THING_INPUT_SCHEMA
}
```

3. **`src/agent/NacosAgentToolService.ts`**：`invoke` 的 switch 加 case + 私有 handler：

```ts
private async doThing(input: NacosDoThingInput): Promise<ToolInvokeResult> {
  const resolved = await this.resolveInstance(input.instanceId);  // 闸门在这，别绕
  if (!resolved.ok) {
    return resolved.failure;
  }
  const result = await resolved.client.doThing({
    namespaceId: input.namespaceId ?? '',      // 缺省 = 实例默认命名空间（1.x/2.x 的 ''）
    group: input.group ?? DEFAULT_SERVICE_GROUP // naming 类才有这条缺省
  });
  return { ok: true, result };
}
```

需要新 client 能力时同步扩 `NacosApiClientLike` 的 Pick 列表（:41-56）。

4. **纪律**：`src/mcp/**` 与 `src/agent/**` **禁止 import `vscode`**——桥在无窗口场景也要能跑，证书验证用非交互 verifier（`resolveInstance` :195-201 现成）。

### 6.2 风险等级红线

- 新工具默认 `risk: 'read'` + 返回内容脱敏（配置正文类默认 `redactSensitiveText`，`raw: true` 才裸，抄 `getConfig` :284-294）。
- **`risk: 'write'` 的工具在 Phase D2 之前一律不加。** D2 的双闸门设计（[Phase D](./2026-08-27-followup-phase-D-high-risk.md) §D2.2）：schema 加 `allowAgentWrites`（默认 false），服务层判 `allowBackgroundAccess && allowAgentWrites && !readOnly` 八种组合只放行一种；且删除类工具明确永不做。目录闸门 + Hub 侧 risk 确认是另外两层，插件侧不再加「模拟确认」（无人值守场景任何交互都会挂死调用）。

### 6.3 测试

- `test/mcp/bridgeSchemas.test.ts`：zod 与 JSON Schema 孪生一致性、`.strict()` 拒未知键。
- `test/mcp/toolCatalog.test.ts`：目录形状/名字/risk。
- `test/agent/NacosAgentToolService.test.ts`：闸门矩阵（无实例 NOT_FOUND / 未开 allowBackgroundAccess UNAVAILABLE）、参数透传、脱敏开关、错误码。
- `test/mcp/BridgeServer.test.ts`：`/invoke` 端到端（token、body 上限、schema 预检）。
- `test/docs/AtNacosMcpSkill.test.ts`：**skill 文档与目录一致性**——加工具要同步 `skills/at-nacos-mcp/SKILL.md`，否则这条测试红。

---

## 7. i18n cookbook

### 7.1 两套体系，别混

| 体系 | 用途 | 键 | 文件 |
|---|---|---|---|
| `package.nls*.json` | manifest 静态串（命令 title、视图名、welcome） | `atNacos.xxx` 占位符 | `package.nls.json` + `package.nls.zh-cn.json`，manifest 里写 `%atNacos.xxx%` |
| `l10n/bundle.l10n.zh-cn.json` | 运行时 `t()` 串 | **英文源串本身** | `t('English source', {args})`；`package.json` 的 `"l10n": "./l10n"` 是它被加载的前提（`nls.test.ts:168-173` 锁着） |

### 7.2 `t()` 的规矩

- 占位符用 `{name}`，两边（英文源与中文译文）**占位符集合必须一致**（`nls.test.ts:48-55`——译文丢了 `{label}` 运行时就静默丢值）。
- **每个** `t('...')` 的英文源串必须出现在 bundle 里——`nls.test.ts:74` 的 `T_CALL` 正则扫全 `src/**/*.ts`（单引号字面量、跨行也抓），`:124-128` 逐条比对。所以：
  - 新 `t()` 调用 = bundle 必加一行中文。
  - **反向不成立**：bundle 里可以有源串旁边看不到 `t(` 的键——`buildWebviewStrings({...})` 的对象值、表单 auth-mode 标签表都是间接到达 `t()` 的（`:130-138` 注释解释了为什么不做反向检查）。**由此得出纪律：不要把 `t()` 的源串只写成对象值就完事**，凡走 `buildWebviewStrings` 或查表的串，加 bundle 键时要人工确认（扫描器帮不了你）。
- webview 页面拿不到 `vscode.l10n`：页面文案在扩展侧 `buildWebviewStrings` 翻好、经 `renderWebviewHtml` 的 data 块传进去，页面留英文 `FALLBACK_STRINGS`（数据块缺失时英文可用胜过白板）。

### 7.3 JSON 重复键（真实事故）

`JSON.parse` 对重复键**静默保留最后一个**。bundle 现存两处 `"Version"`（`bundle.l10n.zh-cn.json:96` 的「版本」被 `:120` 的「版本号」覆盖，集群面板列头因此显示错译）和两处 `"Delete"`。修复与防回归方案在 [Phase A Task A2](./2026-08-27-followup-phase-A-ui.md)：**代码里的英文源串先分叉**（`t('Version')` → `t('Nacos version')` / `t('Config version')`——`t()` 的键就是源串，改 JSON 键名救不了），并加手写 top-level 键扫描测试（不要引 json5）。**改 bundle 前先确认 A2 的重复键测试已在**，没有就先做 A2。

### 7.4 manifest 占位符四条铁律（`nls.test.ts:167-208` 逐条锁着）

整值占位（`"AT Nacos: %atNacos.foo%"` 不会被替换）；两语言键集合相等；每个占位符两边都有解析；nls 里不留无人引用的键。

---

## 8. 客户端池与刷新规则（1–8 之后）

`src/extension.ts:181-209`（1–8 分支）定义了全部规则，三个函数三种粒度：

| 触发 | 调谁 | 池 | 树 |
|---|---|---|---|
| 配置写成功（publish/delete/rollback） | `refreshAfterConfigWrite()` (:190-192) | **不动** | 只配置树 |
| 服务写成功（enable/disable 实例） | `refreshAfterServiceWrite()` (:193-195) | **不动** | 只服务树 |
| 实例增/改/删 | `refreshAfterInstanceChange(instanceId?)` (:203-209) | `evict(该实例)`（新建实例无缓存则不传 id） | **两棵树都刷**（实例是两棵树的根节点） |
| 视图标题 Refresh 按钮 | `atNacos.refreshConfigs` / `refreshServices` (:369-376) | **`clientPool.clear()`** | 对应一棵树 |

**为什么写操作绝不清池**（:181-189 注释原文的推理）：刚成功的写就是缓存客户端仍然健康的证明——服务器一秒前刚接受了它的 JWT、答了它探测过的端点；此时清池等于扔掉写操作刚验证过的状态，换来下一次树读多付一次登录 + 一次 `/state` 往返。只有显式 Refresh 是用户在说「从头再来」（凭据轮换了、服务器原地升级了——扩展背后发生的事）。

**给未来写路径的规则**：新的写命令成功回调**必须**接到三者之一，不要自创 `clientPool.clear()`；`test/extension/WriteCommands.test.ts`（1–8 加了 237 行）锁着「写成功只刷对应树、池不清」的行为。

其它相关机制：
- 池的指纹失效（`NacosClientPool.ts:15-24`）：`updatedAt` 在指纹里，所以任何保存过的实例编辑天然让旧客户端失效——`evict` 是双保险不是唯一依赖。
- 构建失败的 Promise 自淘汰（:48-55），带身份校验（并发时不误删替代者）——树缓存（`NacosTreeBase.ts:165-169`）、resolver（`NacosCapabilityResolver.ts:140-142`）同款手法，新缓存照抄。
- MCP 路径**有意不走池**（extension.ts:263-267）：池按实例 id 键控，共享会把交互 verifier 的客户端交给后台调用（或反之）。

---

## 9. 只读双层（readonly 的两道闸）

**第一层：菜单藏掉。** `contextValueFor(kind, instance)`（NacosTreeItems.ts:47-49）给只读实例下**每一层**节点的 contextValue 加 `.readonly` 后缀（不只实例节点——写命令挂在命名空间/分组/配置上，后缀晚加就要审计所有已发布的菜单）。写命令的 when 用精确 `==` 自然不匹配；读命令用 `=~ /^...\b/` 两态都匹配（§3.4 表格）。实例节点还在 UI 上标注 `description = t('read-only')`（:111-115——被藏的命令读起来像缺功能，除非节点说明为什么）。

**第二层：`assertWritable`。** `confirmWrite.ts:27-35`，每条写路径入口第一行（`publishConfig.ts:36`、`deleteConfig`、`rollbackConfig`、`updateInstanceHealth.ts:28`、`openDraftDocument.ts:41`）。存在理由写在注释里：命令面板、快捷键、其它扩展都能绕过菜单调用命令。

**为什么驱动层不做第三层**（NacosDriver.ts:211-214 注释）：readOnly 是「这个工作区如何配置了一台服务器」的属性，不是服务器的属性；一条安全规则放进两层，就会出现两份拷贝都没跑到的路径。

**MCP 是特例**：没有菜单可藏，所以第一层不存在——当前 13 个工具全只读所以无事；**未来任何 MCP 写工具必须在 agent 服务层自查 readOnly**（Phase D2 的 `allowBackgroundAccess && allowAgentWrites && !readOnly` 三与门），这是 MCP 路径上唯一的闸。

---

## 10. URI schemes：`nacos:` 与 `nacos-draft:`

| | `nacos:`（只读） | `nacos-draft:`（可编辑） |
|---|---|---|
| 定义 | `configUri.ts:8` | `draftUri.ts:4` |
| Provider | `TextDocumentContentProvider`（`NacosConfigDocumentProvider`），内容每次向服务器现取；`refresh(instanceId, ref)` 发变更事件 | `FileSystemProvider`（`NacosDraftFileSystemProvider`），内容在内存 `DraftEntry`；Ctrl+S 只写内存 |
| 注册 | `extension.ts:216-220`，**激活即注册**（:211-215 注释：窗口重载时 VS Code 先恢复 tab 再问内容，晚注册 = 「cannot open」死 tab） | `extension.ts:222-226`，同理 |
| 路径 | `/<instanceId>/<ns 或 $public>/<group>/<dataId>`，四段全 `encodeURIComponent`；历史版本 `?nid=<id>` | 同四段结构，无 query |
| 用在 | 打开配置、diff 的两侧（当前版 vs 草稿 / 当前版 vs 历史版 / 跨环境两个当前版） | 编辑/新建草稿、diff 右侧、publish 的目标定位 |

**设计要点**（都有注释背书，改动前读原文）：
- `$public` 哨兵（configUri.ts:10-31）：1.x/2.x 公共命名空间 id 是空串，空路径段活不过规范化；`$` 不在 `encodeURIComponent` 的输出字母表里所以永不碰撞（`_public_` 反而是合法 id）。
- 实例 **id** 进路径而不是地址（:66-79）：authority 会被 case-fold 且能长得像 `user:pass@host`；id 作路径段和其它三段一条规则编码。
- 历史版本进 **query** 而不是第五段（:36-44）：tab 标题取最后一段，第五段会让 tab 叫「1044」。
- `parseConfigUri` 对不认识的地址返回 `undefined` 而不是抛（:120-134）：provider reject = 无解释的空编辑器，所以失败必须变成 buffer 里的文案。

**保存监听器**（extension.ts:811-826，1–8 分支）：`onDidSaveTextDocument` 只认 `NACOS_DRAFT_SCHEME`，`parseDraftUri` 成功且 `isDirty` 才提示——**状态栏 5 秒**，不是通知（习惯性 Ctrl+S 不该每次花一次点击去关弹窗）。配套的 `onDidCloseTextDocument`（:828-839）：关掉且不脏的草稿即删（脏的留着，重开还在）。**全局禁止**把保存重新接到发布（Agent 总入口 §4）。

---

## 11. 测试文件索引（test/** 各锁什么）

跑法：全量 `npm test`；单文件 `npx vitest run test/extension/Manifest.test.ts`；改动期间 `npm run test:watch`。`vitest.config.ts` 把 `vscode` alias 到 `test-fixtures/vscode.ts`（515 行假宿主：`__getRegisteredCommands` / `__getTreeViews` / `__setInputBoxResults` / `__resetDialogs` / 假 `Uri`（不做百分号编码，见架构 §14.9 ㉞）等）。

| 文件 | 锁什么 |
|---|---|
| `test/extension/ExtensionLifecycle.test.ts` | **27 命令排序清单、36 subscriptions、视图/provider/channel 创建、过滤命令行为、deactivate 幂等与面板收尾**（§3.6） |
| `test/extension/Manifest.test.ts` | **package.json 契约**：注册=贡献、菜单只引用已贡献命令、view/title 作用域、palette when:false 清单、`nodeMenu()` 每命令一条、readonly 正则真匹配、图标文件存在、`main` 指向 bundle |
| `test/extension/WriteCommands.test.ts` | 写命令接线：assertWritable、confirmWrite 流、**写后只刷对应树/池不清**（1–8 扩到 237 行新增） |
| `test/extension/ConfigCommands.test.ts` / `ConfigInspectionCommands.test.ts` / `ServiceCommands.test.ts` / `InstanceCommands.test.ts` / `ClusterStatusCommand.test.ts` / `McpConfigCommands.test.ts` | 各族命令 handler 行为（节点参数、按 id 重读、错误通知、面板打开） |
| `test/extension/createNacosClient.test.ts` | 组装线：对真 HTTP 服务器验证 http→auth→probe→chain 全链 |
| `test/extension/extensionContext.ts` | 假 `ExtensionContext` 工厂（非测试文件） |
| `test/nacos/NacosHttpClient.test.ts` | 传输层：form/query/头/超时/`maxResponseBytes` 截断/TLS verifier/URL 规范化 |
| `test/nacos/NacosClient.test.ts` | 能力键转发与 `buildDriverChain` 顺序/`buildChainAdvice` |
| `test/nacos/NacosCapabilityResolver.test.ts` | 降级步进、缓存、in-flight 去重、失败驱逐身份校验、耗尽文案 |
| `test/nacos/NacosClientPool.test.ts` | 指纹失效、失败自淘汰、evict/clear |
| `test/nacos/NacosApiError.test.ts` | 状态分类与 `shouldFallThrough` |
| `test/nacos/NacosCertTrustStore.test.ts` / `createInteractiveCertVerifier.test.ts` | TOFU 三态与弹窗语义（changed 关闭即拒绝） |
| `test/nacos/testNacosConnection.test.ts` | 连接测试的候选地址/发现/诊断结构 |
| `test/nacos/auth/*.test.ts` | 各策略 + `withAuth` 的 403→refresh→重试一次 |
| `test/nacos/probe/*.test.ts` | `/state` 解析（两代键名）与 console 发现 |
| `test/nacos/driver/configDrivers.test.ts` | 四方言的配置列表/详情：路径、`tenant` vs `namespaceId`、show=all、200+空 body=不存在 |
| `test/nacos/driver/namingDrivers.test.ts` / `namespaceDrivers.test.ts` / `historyDrivers.test.ts` / `writeDrivers.test.ts` / `listenedConfigs.test.ts` | 同上按主题：catalog 参数（`groupNameParam`）、写的 form/query 形态、`assertWriteAccepted` 四种响应、console origin override |
| `test/nacos/driver/normalize.test.ts` / `namingNormalize.test.ts` / `historyNormalize.test.ts` | 归一化对各版本响应原文（含拼错的 `lisentersGroupkeyStatus`、`opType` 填充、三种实例列表形状） |
| `test/nacos/driver/configLanguage.test.ts` | type/后缀映射 + **1–8 新增** `configTypeForDataId` 双向不漂移 |
| `test/nacos/driver/springErrorPage.test.ts` | 两种 404 的辨别 |
| `test/nacos/testHttpServer.ts` | 驱动测试的真 HTTP 夹具（非测试文件） |
| `test/tree/ConfigTreeProvider.test.ts` / `ServiceTreeProvider.test.ts` | 分层/分页/mergePage 去重/错误节点 ownerId/过滤语义（**1–8 服务树过滤 +170 行**：同词不清页、清池不清 instanceCache 等） |
| `test/document/configUri.test.ts` / `draftUri.test.ts` | 地址往返（含 `$public`、恶意段、nid query 拒绝多参） |
| `test/document/NacosConfigDocumentProvider.test.ts` / `NacosDraftFileSystemProvider.test.ts` | 失败变文案不 reject；草稿生命周期/isDirty/markClean |
| `test/document/openConfigDocument.test.ts` / `openDraftDocument.test.ts` / `diffConfig.test.ts` | 语言模式设置、createNew/空详情 upsert（1–8 +71 行）、三个 diff 的 URI 与标题 |
| `test/write/confirmWrite.test.ts` / `publishConfig.test.ts` / `deleteConfig.test.ts` / `rollbackConfig.test.ts` / `updateInstanceHealth.test.ts` | assertWritable、diff+modal 顺序、冲突检测、类型/元数据携带、整行回传 |
| `test/webview/html.test.ts` / `openPanels.test.ts` | CSP/nonce/JSON 块转义/escapeAttr；reveal 语义与 dispose 竞态 |
| `test/webview/ClusterStatusPanel.test.ts` / `ConfigHistoryPanel.test.ts` / `ConfigListenersPanel.test.ts` / `ServiceSubscribersPanel.test.ts` / `NacosInstanceFormPanel.test.ts` | 各面板渲染（空态/错误/XSS/本地化键逐条）、消息处理、`shownVersions` 白名单、表单 payload 校验（1–8 +36 行 allowBackgroundAccess） |
| `test/mcp/toolCatalog.test.ts` / `bridgeSchemas.test.ts` / `BridgeServer.test.ts` / `McpConfigInstaller.test.ts` / `hubSync.test.ts` | 工具目录形状、schema 孪生一致、桥端到端（token/上限）、安装器各 IDE 行为、hub 同步 |
| `test/agent/NacosAgentToolService.test.ts` | 工具闸门/参数透传/脱敏/错误码（1–8 +94 行） |
| `test/config/schema.test.ts` / `NacosInstanceConfigManager.test.ts` | userinfo 剥离、strip 语义、SecretStorage 读写 |
| `test/i18n/nls.test.ts` / `t.test.ts` | §7 的全部规则 |
| `test/utils/*.test.ts` | 脱敏模式/日志 redact/时间格式/URL 凭据剥离/通知 |
| `test/docs/AtNacosMcpSkill.test.ts` | skill 文档与工具目录一致性 |
| `test/live/liveServer.test.ts` | **真机冒烟**（唯一不用夹具的）：`const describeLive = liveUrl ? describe : describe.skip`——设了 `AT_NACOS_LIVE_URL` 才跑。跑法：`AT_NACOS_LIVE_URL=http://host:8848/nacos npx vitest run test/live`（可选 `AT_NACOS_LIVE_USERNAME`/`AT_NACOS_LIVE_PASSWORD`）。它抓的是「我们对 Nacos 实际行为的错误假设」，夹具抓不到这类。 |

---

## 12. 常见地雷（改代码前默诵）

按「踩了会静默出错」排序，出处是架构文档 §14 的真机验证与代码注释：

1. **参数名传错 = 空列表，不是报错。** 真机实测（§14.2 ①'）：`tenant=cl-parent` 返回 12 条，`namespaceId=cl-parent` 返回 `totalCount 0` 且不报错——看起来就是「这个命名空间是空的」。同族陷阱：catalog 的分组过滤叫 `groupNameParam`（2.3.2 就带 Param 后缀，§14.5 ③），传 `groupName` 被静默丢弃、看起来像「过滤器匹配了一切」。**所以：参数名一律走 `namespaceParamName`/`groupParamName`/`configTagsParamName`/`clusterParamName`/`serviceIdentityParams`，且 namespace 与 group 的映射必须成对用**（writes.ts:129-138：写路径上这个静默更狠——发布落进默认命名空间，配置被创建在没人看的地方）。
2. **Nacos 改实例是整行覆盖。** 更新端点从请求重建整个实例，缺的字段取默认值：`weight`→1、`healthy`→true、metadata→清空（writes.ts:76-96，2.3.2 `HttpRequestInstanceBuilder` 与 3.x `InstanceForm` 双向验证）。**任何实例写必须回传 `listInstances` 刚报告的完整行**，只改要改的那个字段（`NacosInstanceHealthUpdate` 的形状就是这个纪律）。发布同理：整行 upsert，漏 `appName`/`description` 就是清掉它们，漏 `type` 就是把 YAML 重置成 `text`（`requiredType` 对空串直接 `validation` 拒绝）。
3. **1.x/2.x 默认命名空间 id 是 `''`，3.x 是 `'public'`，不要互代。** 在 1.x/2.x 上发 `public` 是在点名一个几乎不存在的自定义命名空间——服务器答空结果不报错（normalize.ts:22-36）。判断用 `publicNamespaceId(majorVersion)`；URI 层的空串有 `$public` 哨兵。
4. **树的 `listServices` 不要传 `group`。** 名字类列举把空分组坍缩成 `DEFAULT_GROUP`，真机上就是它把 12 个服务的注册表报告成零、骗过了做调研的人（§14.5 ①）。分组层是从「不带分组的列举结果」反推出来的（`ServiceTreeProvider.fetchPage` :321-346 注释），传了 group 分组层就永远长不出来。MCP 的 `nacos_list_services` 暴露了该参数（那是 agent 的自由），**树不行**——全局禁止项（总入口 §4）。
5. **「配置不存在」与「服务不存在」的判据相反。** 配置：`?show=all` 下是 **HTTP 200 + 空 body**（不是 404！§14.2 ⓪），404+Spring 错误页才是「端点不存在该降级」；服务：HTTP 200 + 空 `hosts`（§14.5 ⑤），空列表是正常答案。把配置判据套到 naming 上会把空服务读成缺失服务。
6. **HTTP 200 + `false` 是拒绝，不是结果。** 写路径必须走 `assertWriteAccepted`（writes.ts:189-218）；读成成功会告诉用户「已发布」而服务器把它扔了；它抛 `api-error` 有意**不降级**——被拒的写不能换个 API 家族重放。
7. **列表接口带全量配置正文。** 12 条配置 38KB，v1 无排除参数（§14.2 ②）；分页必须真分页，`maxResponseBytes` 必须设（`listResponseCap`），`normalizeConfigSummary` 在边界处丢弃 `content`（里面有数据库密码）——**上层任何人都不要想办法把它捡回来**。
8. **blur 搜索下 `type` 是 null，列表 `md5` 恒 null。** 过滤后语法高亮全靠 dataId 后缀回退（`configLanguageId` 是必需路径不是兜底，§14.2 ①）；**别用 summary 的 md5 判断两份副本异同**（§14.9 ②，accurate 模式它也是 null，只有 `?show=all` 详情有真 md5——监听者面板自己取详情就是这个原因）。
9. **`lisentersGroupkeyStatus` 是 Nacos 自己拼错的键名**，真机确认逐字存在（§14.1）；只读正确拼写会在所有现存服务器上找到零监听者。归一化三种拼法都收（normalize.ts:284-309），别「修正」它。
10. **`opType` 带定宽填充**：每个版本都发 `"I "`/`"U "`/`"D "`（数据库 char 列），normalize 已 trim（:265-268）——下游别再 trim，也别拿没 trim 的值比较。
11. **`/v1/ns/**` 用 501 报「没有这个接口」，其它前缀是 404 错误页**（§14.5 ②）。501 归类 `api-error` **不触发驱动降级**——任何「v1 naming 端点缺失→换驱动」的设计会卡死在这。
12. **历史端点是唯一被服务端钳制分页的（500）**；`HISTORY_PAGE_SIZE=100` 别加大（架构 §10）。
13. **l10n bundle 有 JSON 重复键**（两个 `"Version"`、两个 `"Delete"`），`JSON.parse` 静默取后者（§7.3）；改 bundle 先落 A2 的扫描测试。
14. **两个树节点/两个面板 key 拿到同一个 id，VS Code 只画一个。** 所有拼 id/key 的地方分段 `encodeURIComponent`（`treeItemId`、`panelKey`、`joinKey`）——分组名可以含 `:`，服务名可以含 `@@`。分页合并按 key 去重（`mergePage`：两页之间有人注册，行会移位、同名到两次）。
15. **rejected Promise 留在缓存里 = 错误永生。** 所有 in-flight 缓存失败自淘汰且带身份校验（`NacosTreeBase.ts:154-169`、`ServiceTreeProvider.ts:283-291`、`NacosClientPool.ts:48-55`、resolver :137-142）——新缓存照抄这四行，别发明新写法。
16. **V2Driver 的配置/历史/订阅者/监听者走 v1 路径 + v1 方言**（v2 根本没有这些端点或要 v1 拼法，§14.8 ①②）。给 v2 加配置类能力时别想当然打 `/v2/cs/**`。
17. **`GROUP@@service` 在第一个 `@@` 处切**（`splitGroupedServiceName`，normalize.ts:528-549）；Nacos 自己的 `split()[1]` 会把 `g@@b@@c` 切成 `b`——重命名服务比显示怪名字更糟。
18. **provider 层失败不许抛/不许 reject**：树抛 = 整视图变空（`NacosTreeBase` :105-115、:127-140），文档 provider reject = 无解释空编辑器（`NacosConfigDocumentProvider` :65-70），面板 reject = 空面板。全部变成 ErrorTreeItem / buffer 文案 / errorNote。
19. **`src/nacos/**`、`src/mcp/**`、`src/agent/**` 不 import `vscode`**（唯一豁免 `createInteractiveCertVerifier.ts`，注释自declared）；webview 页面脚本更不行（浏览器环境）。UI 关切走既有边界：`i18n/t`、`utils/notifications`、cert verifier 注入。
20. **`nodeMenu()` 假定一命令一条菜单**；多节点共用命令写 `||`（§3.4）。`atNacos.serviceInstance` 以 `atNacos.service` 开头——service 类 when 一律 `\b` 收尾防前缀误伤（`Manifest.test.ts:281-301` 专门锁这个陷阱）。
21. **写操作后不要 `clientPool.clear()`**（§8）；显式 Refresh 命令**保留** clear——两边语义都被测试锁着。

---

*配套阅读顺序：本文（找路） → [Agent 执行总入口](./2026-08-27-followup-agent-guide.md)（纪律与顺序） → 对应 Phase 文档（任务 checkbox） → [架构真源](./2026-08-13-at-nacos-architecture.md)（API 事实，冲突时它最大）。*
