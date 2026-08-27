# Phase B: 设置项与工程债

> **Status:** 实施计划（agent-executable）。覆盖 `docs/plans/2026-08-27-followup-roadmap.md` 里程碑 B 的 B1–B12 全部条目。
>
> **Depends on: Phase 0**（见 `docs/plans/2026-08-27-followup-phase-0-prereq.md`，即把 1–8 优化系列 `cursor/nacos-opt-1-8-6a9b` 合入 main：写路径不清整池、Ctrl+S 保存≠发布、实例表单保活、新建配置、MCP 卸载与诚实提示、连接节点右键、服务名过滤、MCP 并行拉集群 + 非交互证书）。**开工前必须确认 Phase 0 已在当前分支的祖先里**：运行 `git log --oneline | head -30`，若看不到 `perf(agent): fetch cluster nodes and metrics in parallel; honor non-interactive cert verifier on MCP path`（ae986f6）等提交，先停下来合入 Phase 0，否则 B6 / B8 / B9 / B12 的"现状"描述与代码对不上。
>
> **Non-goals（本阶段明确不做）：**
> - AK/SK（MSE）鉴权 —— 仍是 schema 占位 + throw，属 Phase D1。
> - MCP 写工具 —— 官方对齐仍只读，属 Phase D2。
> - 命名空间 CRUD —— 属 Phase C3。
> - `atNacos.publishOnSave` 之类设置 —— 与「保存 ≠ 发布」原则冲突，roadmap 已列入"明确不做"。**任何任务都不得引入它。**
> - 草稿持久化到磁盘 —— B9 只做内存草稿的可发现性；持久化仅作为文末的可选后续记录，不在本阶段实现。

## 全局约定

- **分支**：从合入了 Phase 0 的 main 切出，命名 `cursor/phase-b-<taskId>-<你的后缀>`，全小写。每个任务（或下方标注可合并的任务组）一个分支、一个 PR。
- **提交信息**：沿用仓库惯例 —— `feat(...)` / `fix(...)` / `perf(...)` / `test(...)` / `ci(...)` / `docs(...)`，一个逻辑变更一个 commit。
- **验证命令**（每个任务完成前都要跑）：

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run，当前基线约 1980 例通过 / 33 live 跳过
npm run build       # esbuild 打包，确认 dist 仍能产出
```

- **文案**：所有新增用户可见字符串走 `t()`（`src/i18n/t.ts`），并同步 `l10n/bundle.l10n.zh-cn.json`；manifest 字符串走 `%key%`，同步 `package.nls.json` 与 `package.nls.zh-cn.json` 两份。
- **行号基准**：文中行号已于 **2026-08-27 逐条对照 `origin/cursor/nacos-opt-1-8-6a9b`（Phase 0 合入后的基线）核验**，取文件用 `git show origin/cursor/nacos-opt-1-8-6a9b:<path>`，不要 checkout。原稿以 v0.1.2（c4cc4bf）为准时存在 4 处漂移（B1 的 `ServiceTreeProvider` 两处与 test fixture 一处、B7 的 `listServiceSubscribers` 一处、B10 的 cluster 页面委托一处），均已在正文改为基线行号；各任务头部的 ✅ 行记录核验结果。`src/extension.ts` 行号偏移最大，对该文件仍一律以**符号名**（函数/变量名）定位，勿按行号改。
- **建议实施顺序**：B2 → B1 → B5 → B3（HTTP 层三件套可同分支）→ B8 → B6（MCP 侧两件可同分支）→ B4 → B7 → B9 → B10 → B11 → B12。B7 改动面最大（四驱动 + 域类型），单独分支。B11/B12 与代码无耦合，可穿插。

---

## Task B1 — `contributes.configuration`：请求超时与页大小设置（P0）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`NacosHttpClient` 的 `timeoutMs?` `:15`、`DEFAULT_TIMEOUT_MS :77`（模块私有）、使用点 `:271`；`ConfigTreeProvider` `:34`/`:291`；`ConfigHistoryPanel` `:23`/`:185`；`history.ts` `MAX_HISTORY_PAGE_SIZE :36`；`testNacosConnection` 的 `timeoutMs` 参数 `:52`；`createNacosClient` 现签名在 `extension.ts:91`（第 5 参 `certVerifier`，无 timeoutMs）——全部一致。已修正 3 处行号：`ServiceTreeProvider` 32→34、271→342；fixture `getConfiguration` 475-477→486-488。fixture 确无 `onDidChangeConfiguration`。

### 现状（读代码得出）

- `package.json` 的 `contributes` 只有 `viewsContainers` / `views` / `commands` / `menus` / `viewsWelcome`，**没有任何 `configuration` 节**——用户设置完整度 5 分的原因。
- 超时 seam 已存在：`src/nacos/NacosHttpClient.ts` 第 15 行 `NacosHttpClientOptions.timeoutMs?: number`，第 77 行 `const DEFAULT_TIMEOUT_MS = 15_000;`（模块私有，未导出），第 271 行 `timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS`。当前**没有任何调用方传 timeoutMs**（`createNacosClient` 构造 `NacosHttpClient` 时只给 `baseUrl` / `certVerifier` / `log`；`testNacosConnection` 有 `timeoutMs` 透传参数但 extension.ts 没喂）。
- 页大小三处硬编码：
  - `src/tree/ConfigTreeProvider.ts` 第 34 行 `const CONFIG_PAGE_SIZE = 100;`，第 ~291 行 `pageSize: CONFIG_PAGE_SIZE`；
  - `src/tree/ServiceTreeProvider.ts` 第 34 行 `const SERVICE_PAGE_SIZE = 100;`，第 342 行 `pageSize: SERVICE_PAGE_SIZE`；
  - `src/webview/ConfigHistoryPanel.ts` 第 23 行 `const HISTORY_PAGE_SIZE = 100;`，第 185 行 `pageSize: HISTORY_PAGE_SIZE`（历史端点服务端硬夹 500，见 `src/nacos/driver/history.ts` 的 `MAX_HISTORY_PAGE_SIZE`）。
- 客户端池：`src/nacos/NacosClientPool.ts` 提供 `clear()` / `evict(id)`。Phase 0 后 `activate` 里写刷新已不清池（`refreshAfterConfigWrite`），实例编辑走 `refreshAfterInstanceChange(instanceId)` 按 id evict。**设置变更时必须清池**：timeoutMs 是冻结在 `NacosHttpClient` 构造参数里的，不清池旧超时会一直生效。
- 测试夹具：`test-fixtures/vscode.ts` 的 `workspace.getConfiguration` 目前只会返回 `defaultValue`（第 486–488 行），且没有 `onDidChangeConfiguration`。

### 目标

四个设置项，键名统一 `atNacos.` 前缀（与命令/视图 id 同一 series 前缀）：

| 键 | 类型 | 默认 | 范围 | 作用点 |
|---|---|---|---|---|
| `atNacos.request.timeoutMs` | number | 15000 | 1000–600000 | `NacosHttpClient` 每请求 socket 空闲超时 |
| `atNacos.list.configPageSize` | integer | 100 | 10–500 | 配置树每页条数 |
| `atNacos.list.servicePageSize` | integer | 100 | 10–500 | 服务树每页条数 |
| `atNacos.list.historyPageSize` | integer | 100 | 10–500 | 历史面板一页条数（服务端本来就夹 500） |

变更任一 `atNacos.*` 设置时：清 UI 客户端池（以及 B6 合入后的 agent 池），并刷新两棵树。**不加 `atNacos.publishOnSave`。**

### 涉及文件

- `package.json`（新增 `contributes.configuration`）
- `package.nls.json`、`package.nls.zh-cn.json`（设置项标题/描述）
- 新建 `src/config/settings.ts`（设置读取 + 夹取）
- `src/nacos/NacosHttpClient.ts`（导出 `DEFAULT_TIMEOUT_MS`，供测试与 settings 默认值对齐）
- `src/extension.ts`（透传 timeoutMs、注册 `onDidChangeConfiguration`）
- `src/tree/ConfigTreeProvider.ts`、`src/tree/ServiceTreeProvider.ts`（页大小改为注入的 getter）
- `src/webview/ConfigHistoryPanel.ts`（页大小改为可注入）
- `test-fixtures/vscode.ts`（getConfiguration 可写 + onDidChangeConfiguration）
- `test/extension/Manifest.test.ts`、`test/extension/ExtensionLifecycle.test.ts`、新建 `test/config/settings.test.ts`

### 实施步骤

- [ ] `package.json` 的 `contributes` 增加（放在 `viewsWelcome` 之后）：

```json
"configuration": {
  "title": "%atNacos.config.title%",
  "properties": {
    "atNacos.request.timeoutMs": {
      "type": "number",
      "default": 15000,
      "minimum": 1000,
      "maximum": 600000,
      "description": "%atNacos.config.request.timeoutMs%"
    },
    "atNacos.list.configPageSize": {
      "type": "integer",
      "default": 100,
      "minimum": 10,
      "maximum": 500,
      "description": "%atNacos.config.list.configPageSize%"
    },
    "atNacos.list.servicePageSize": {
      "type": "integer",
      "default": 100,
      "minimum": 10,
      "maximum": 500,
      "description": "%atNacos.config.list.servicePageSize%"
    },
    "atNacos.list.historyPageSize": {
      "type": "integer",
      "default": 100,
      "minimum": 10,
      "maximum": 500,
      "description": "%atNacos.config.list.historyPageSize%"
    }
  }
}
```

- [ ] `package.nls.json` 增加 5 个键（`atNacos.config.title` = "AT Nacos" 及四条英文描述；描述里写明"变更后立即生效，已缓存的连接会被重建"；historyPageSize 的描述写明"Nacos 服务端对历史列表硬性上限 500"）。`package.nls.zh-cn.json` 同步中文。
- [ ] `src/nacos/NacosHttpClient.ts`：把 `const DEFAULT_TIMEOUT_MS = 15_000;` 改为 `export const DEFAULT_TIMEOUT_MS = 15_000;`（其余不动）。
- [ ] 新建 `src/config/settings.ts`：

```ts
import * as vscode from 'vscode';
import { DEFAULT_TIMEOUT_MS } from '../nacos/NacosHttpClient';

const SECTION = 'atNacos';

/** 与 package.json 中 minimum/maximum 保持一致；夹取兜底手改 settings.json 越界值。 */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function requestTimeoutMs(): number {
  const raw = vscode.workspace.getConfiguration(SECTION).get<number>('request.timeoutMs', DEFAULT_TIMEOUT_MS);
  return clamp(raw, 1000, 600000, DEFAULT_TIMEOUT_MS);
}

export function configPageSize(): number {
  const raw = vscode.workspace.getConfiguration(SECTION).get<number>('list.configPageSize', 100);
  return clamp(raw, 10, 500, 100);
}

export function servicePageSize(): number {
  const raw = vscode.workspace.getConfiguration(SECTION).get<number>('list.servicePageSize', 100);
  return clamp(raw, 10, 500, 100);
}

export function historyPageSize(): number {
  const raw = vscode.workspace.getConfiguration(SECTION).get<number>('list.historyPageSize', 100);
  return clamp(raw, 10, 500, 100);
}
```

  注意：`settings.ts` import 了 vscode，所以**不能被 driver/nacos 层 import**——只允许 extension.ts、tree、webview 这些本来就 import vscode 的 UI 模块使用（遵守组合根注释里"只有 UI 模块 import vscode"的架构约束）。
- [ ] `src/extension.ts` 的 `createNacosClient`：签名追加尾参 `timeoutMs?: number`（Phase 0 后已有第 5 参 `certVerifier`，timeoutMs 作第 6 参；两者都 optional，live 测试的现有调用不受影响），`new NacosHttpClient({...})` 增加 `timeoutMs`。
- [ ] `src/extension.ts` 的 `activate`：
  - `getOrCreateClient` 的 factory、agent 侧 `createClient` factory（Phase 0 版）、`openClusterStatusCommand` 里的 `connect`，全部改为传 `requestTimeoutMs()`（**在 factory 内每次调用时读**，不要在 activate 时读一次冻结）；
  - `openInstanceForm` 的 `testConnection` seam 也补 `timeoutMs: requestTimeoutMs()`（`testNacosConnection` 已有该参数，见 `src/nacos/testNacosConnection.ts` 第 52 行）；
  - 注册监听并 push 进 `context.subscriptions`：

```ts
const configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
  if (!event.affectsConfiguration('atNacos')) {
    return;
  }
  clientPool.clear();
  // B6 合入后这里同时 agentClientPool.clear()
  configTreeProvider.refresh();
  serviceTreeProvider.refresh();
});
```

- [ ] `src/tree/ConfigTreeProvider.ts`：构造函数追加可选参 `private readonly pageSize: () => number = () => CONFIG_PAGE_SIZE`，`fetchPage` 里 `pageSize: this.pageSize()`。`CONFIG_PAGE_SIZE` 保留为默认值常量（注释不动）。`ServiceTreeProvider` 同样处理。extension.ts 构造两棵树时传 `configPageSize` / `servicePageSize`。
- [ ] `src/webview/ConfigHistoryPanel.ts`：`loadConfigHistory(connect, ref)` 追加可选第三参 `pageSize: number = HISTORY_PAGE_SIZE`；`ConfigHistoryPanel.open` 的 `load` 闭包里调用 `settings.historyPageSize()`。注意该文件顶部注释（"One page, deliberately"）要顺带补一句"页大小可由 atNacos.list.historyPageSize 调整，上限仍是服务端的 500"。
- [ ] `test-fixtures/vscode.ts`：把 `getConfiguration` 改成从一个模块级 map 读值，暴露 `__setConfiguration(section: string, values: Record<string, unknown>)` 与 `__clearConfiguration()`；增加 `onDidChangeConfiguration` emitter 与 `__fireDidChangeConfiguration(affects: (section: string) => boolean)`（返回的 event 形如 `{ affectsConfiguration: affects }`）。

### 测试

- [ ] 新建 `test/config/settings.test.ts`：默认值（未设置时 15000/100/100/100）；越界夹取（`request.timeoutMs: 50` → 1000；`list.historyPageSize: 9999` → 500；非数字 → fallback）；正常值透传。
- [ ] `test/extension/Manifest.test.ts` 增加：
  - `contributes.configuration.properties` 的每个键都以 `atNacos.` 开头；
  - `atNacos.request.timeoutMs` 的 default 与 `DEFAULT_TIMEOUT_MS`（从 `src/nacos/NacosHttpClient` import）一致；
  - 每个设置项的 description 都是 `%...%` 引用且键存在于 `package.nls.json` 与 `package.nls.zh-cn.json`；
  - **断言不存在 `atNacos.publishOnSave`**（防回归，roadmap 明确不做）。
- [ ] `test/extension/ExtensionLifecycle.test.ts` 增加：activate 后 `__fireDidChangeConfiguration(s => s === 'atNacos')`，断言两个树 provider 的 onDidChangeTreeData 各 fire 一次、后续 `getOrCreateClient` 会重建客户端（可通过计数 factory 调用验证清池生效）；`affectsConfiguration` 返回 false 时什么都不发生。
- [ ] `test/nacos/NacosHttpClient.test.ts` 增加一例：构造时传 `timeoutMs: 50` 对一个只 accept 不响应的服务器请求，断言拒绝为 `kind === 'network'` 且信息含 "timed out"（现有 testHttpServer 可加一个 hang 路由）。

### 陷阱

- **不要在 activate 时读一次设置存变量**——设置变更后 factory 必须拿到新值；清池只解决了"旧 client 里冻结的 timeoutMs"，新 client 要用新值就必须每次现读。
- `NacosInstanceFormPanel` 的 Test Connection 有自己的 `testConnection` seam，别漏。
- `historyPageSize` 即使用户设 500，v1 driver 出口仍会 `Math.min(pageSize, 500)`，行为一致，不需要动 driver。
- l10n 两份 nls 文件都要加，漏中文会导致中文界面回落英文；A2（l10n 重复键）不在本任务范围，但新增键名不要与现有键冲突。
- 树 provider 的 `pageSize` 参数取的是**函数**不是数：中途改设置后"Load more"的下一页应用新页大小，`mergePage` 按 `pagesLoaded+1` 计页码，页大小突变会导致重叠/跳行——可以接受（下次 Refresh 归位），但要在 provider 参数注释里写明。

### Done when

- [ ] 设置界面出现 "AT Nacos" 分组四个设置项，中英文描述齐全；
- [ ] 改 `atNacos.request.timeoutMs` 后（不重载窗口）下一次树刷新的请求用新超时（手测：设 1000ms 对一个慢服务器，观察输出面板 network 错误）；
- [ ] 改任一 `atNacos.*` 设置触发两树刷新且客户端重建；
- [ ] 无 `publishOnSave`；`npm run typecheck && npm test` 全绿，Manifest 新断言通过。

---

## Task B2 — Bridge 请求体按 `Buffer.concat` 聚合，禁止逐 chunk `toString`（P0）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`bytesReceived`/`exceeded` 在 `BridgeServer.ts:401-402`、逐 chunk `body += buffer.toString('utf8')` 在 `:411`、413 分支与 `PAYLOAD_TOO_LARGE` 在 `:414`/`:419`；对照的正确写法 `NacosHttpClient` `Buffer.concat(chunks).toString('utf8')` 在 `:305`。`test/mcp/BridgeServer.test.ts` 现有 6 个端到端用例、**无 413 专项用例**——按文中「没有则补一个」执行。

### 现状

`src/mcp/BridgeServer.ts` 第 400–412 行（`handleNodeRequest`）：

```ts
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
```

`buffer.toString('utf8')` 按 chunk 解码：一个中文字符（UTF-8 三字节）若恰好被 TCP 分包切开，两半各自解码成 U+FFFD 替换符，MCP 工具参数里的中文 dataId/serviceName 就会损坏，且只在大 payload / 慢链路下偶发。对照：`NacosHttpClient.performRequest`（第 275–305 行）已经是先攒 `Buffer[]` 最后 `Buffer.concat(chunks).toString('utf8')` 的正确写法。

### 涉及文件

- `src/mcp/BridgeServer.ts`
- `test/mcp/BridgeServer.test.ts`

### 实施步骤

- [ ] 把请求体读取抽成**导出的**独立函数（放在 `handleNodeRequest` 上方），便于用内存流单测：

```ts
export interface BridgeBodyResult {
  body: string;
  exceeded: boolean;
}

/**
 * 聚合完再一次性 UTF-8 解码。逐 chunk toString 会把跨包切开的多字节字符
 * 解成 U+FFFD——中文 dataId 在大请求体里会随机损坏。
 */
export async function readBridgeRequestBody(
  request: AsyncIterable<Buffer | string>,
  maxBodyBytes: number
): Promise<BridgeBodyResult> {
  const chunks: Buffer[] = [];
  let bytesReceived = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesReceived += buffer.length;
    if (bytesReceived > maxBodyBytes) {
      return { body: '', exceeded: true };
    }
    chunks.push(buffer);
  }
  return { body: Buffer.concat(chunks).toString('utf8'), exceeded: false };
}
```

- [ ] `handleNodeRequest` 改为调用它：

```ts
const { body, exceeded } = await readBridgeRequestBody(request, BRIDGE_MAX_BODY_BYTES);
```

  其后的 413 分支与 `body: body.length > 0 ? body : undefined` 不变。

### 测试

- [ ] `test/mcp/BridgeServer.test.ts` 新增 describe `readBridgeRequestBody`：
  - **跨包切开的 CJK**：`const raw = Buffer.from(JSON.stringify({ name: 'nacos_get_config', arguments: { dataId: '应用配置.yaml', group: '默认分组' } }), 'utf8');` 找到多字节字符中间的切点（如 `raw.subarray(0, k)` / `raw.subarray(k)`，k 取某个中文字符首字节 +1 的位置；可以直接遍历 1..raw.length-1 所有切点做全量断言），用 `Readable.from([part1, part2])`（`node:stream`）喂入，断言 `JSON.parse(body).arguments.dataId === '应用配置.yaml'`。旧实现对该输入必产出含 `\uFFFD` 的字符串，可先写测试红后改实现绿；
  - 超限：两个 chunk 合计超过 maxBodyBytes → `exceeded: true`；
  - 空体：`Readable.from([])` → `body === ''`。
- [ ] 保留并跑通现有 6 个端到端用例（fetch 一次性发体，行为不变）；413 用例若已有则不动，没有则补一个（`makeRequest` 发超过 `BRIDGE_MAX_BODY_BYTES` 的体，断言 413 + `PAYLOAD_TOO_LARGE`）。

### 陷阱

- 超限分支返回 `body: ''` 即可，**不要**把已收的半截体解码返回——413 路径根本不读 body。
- 别用 `request.setEncoding('utf8')`"修"这个问题：那是同一个 bug 的另一种写法（Node 会在流层做增量解码，虽然 `setEncoding` 的 StringDecoder 其实能处理跨包，但依赖隐式行为不如显式 concat，且与 NacosHttpClient 的既有模式不一致）。
- `for await` 在 http 请求流上遇到 aborted 会 throw，外层 `handleNodeRequest` 的 try/catch 已兜住（500 分支），保持现状即可。

### Done when

- [ ] 任意切点的中文 JSON 体都能完整解析（切点全遍历断言通过）；
- [ ] 413 行为不变；现有 BridgeServer 测试全绿；`npm run typecheck && npm test` 通过。

---

## Task B3 — GET 在 keep-alive 复用 socket 遇 `ECONNRESET`/`EPIPE` 时重试一次（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：模块级 keep-alive agent 在 `NacosHttpClient.ts:25-37`（`keepAliveMsecs: 30_000` 在 :27/:34）、`request.on('error', ...)` 在 `:317-319`、timeout 选项 `:271`——全部一致。

### 现状

- `src/nacos/NacosHttpClient.ts` 用模块级 keep-alive agent（第 25–37 行，`keepAliveMsecs: 30_000`）。服务器/中间层空闲超时若短于 30s，会出现经典竞态：agent 把一个"服务器刚决定要关"的 socket 交给下一个请求，请求写出后得到 `ECONNRESET`（或写时 `EPIPE`）。
- 错误路径在 `performRequest` 内：`request.on('error', ...)`（第 317–319 行）把原始错误经 `toNetworkOrTlsError` 包成 `NacosApiError('network', message)`——**`error.code` 在这一步丢失**，外层无法再判断可重试性；且 promise 一旦 settle 就没有重试机会。
- Node 官方文档对此的建议正是：`request.reusedSocket && err.code === 'ECONNRESET'` 时重试。

### 目标

仅当同时满足以下条件时，整个请求**重发一次**（重新 dial，不复用坏 socket）：

1. `method === 'GET'`（幂等读；本项目所有写全是 POST/PUT/DELETE，登录也是 POST）；
2. 失败发生在**收到任何响应字节之前**；
3. 底层错误 code 为 `ECONNRESET` 或 `EPIPE`；
4. `request.reusedSocket === true`（新拨的 socket 上出这俩错说明服务器真有问题，重试只是白费一轮）；
5. 是第一次尝试（最多共 2 次）。

**永不重试写操作**，哪怕它幂等（publish 是 upsert 但语义上属写，规格里明确排除）。

### 涉及文件

- `src/nacos/NacosHttpClient.ts`
- `test/nacos/NacosHttpClient.test.ts`

### 实施步骤

- [ ] 在 `NacosHttpClient.ts` 增加模块私有标记错误与谓词（谓词导出，便于单测 EPIPE 分支）：

```ts
/** 可因"复用了对端已在关闭的 keep-alive socket"而值得重发一次的 code。 */
export function isStaleSocketErrorCode(code: string | undefined): boolean {
  return code === 'ECONNRESET' || code === 'EPIPE';
}

/** 内部信号：第一次尝试在复用 socket 上、响应开始前失败。携带原始错误以便二次失败时如实上报。 */
class StaleReusedSocketError extends Error {
  constructor(readonly original: NodeJS.ErrnoException) {
    super(original.message);
  }
}
```

- [ ] 把现有 `performRequest` 的方法体改名为私有 `attemptRequest(target, method, payload, options, defaultAccept, signalStaleSocket: boolean)`，内部改两处：
  - response 回调开头置位 `let responseStarted = false;` → 回调第一行 `responseStarted = true;`（变量声明在 promise executor 顶部）；
  - `request.on('error', ...)` 改为：

```ts
request.on('error', (error) => {
  if (error instanceof NacosApiError) {
    settleReject(error);
    return;
  }
  const errno = error as NodeJS.ErrnoException;
  if (signalStaleSocket && !responseStarted && request.reusedSocket && isStaleSocketErrorCode(errno.code)) {
    settleReject(new StaleReusedSocketError(errno));
    return;
  }
  settleReject(toNetworkOrTlsError(errno));
});
```

- [ ] 新的 `performRequest` 做重试包装：

```ts
private async performRequest(
  target: URL,
  method: string,
  payload: RequestPayload | undefined,
  options: NacosRequestOptions,
  defaultAccept: string
): Promise<NacosRawResponse> {
  try {
    return await this.attemptRequest(target, method, payload, options, defaultAccept, method === 'GET');
  } catch (error) {
    if (!(error instanceof StaleReusedSocketError)) {
      throw error;
    }
    this.log.debug(
      `nacos-api: GET ${target.pathname} failed with ${error.original.code} on a reused keep-alive socket; retrying once`
    );
    // 第二次不再发信号：再失败就按原样分类上报。
    return await this.attemptRequest(target, method, payload, options, defaultAccept, false);
  }
}
```

- [ ] `timeout` 分支产出的是 `NacosApiError`，天然不触发重试（保持现状）。certVerifier 路径在重试时会重新校验指纹：非交互 verifier 查 trust store 即回；交互 verifier 第一次尝试已把指纹写进 store（或本就信任），不会二次弹窗——在 `attemptRequest` 的 doc 注释里写明这一点。

### 测试

（都放 `test/nacos/NacosHttpClient.test.ts`，模式沿用现有 `startTestHttpServer` 或直接 `node:http.createServer`；**必须给 client 传独立的 `agent: new http.Agent({ keepAlive: true })`**，否则模块级共享 agent 会被其他用例的连接污染。）

- [ ] **GET 重试成功**：服务器按 socket 记请求数——同一 socket 上的第 2 个请求不响应直接 `request.socket.destroy()`；新连接第 1 个请求正常 200。客户端顺序发两次 `requestJson('GET', ...)`：第一次建连成功；第二次骑复用 socket 被 RST → 重试新连接成功。断言两次调用都 resolve、服务器共收到 3 个请求、共 2 条连接。
- [ ] **POST 不重试**：同一服务器逻辑，第二次改发 `requestJson('POST', ...)` → 断言 reject 且 `kind === 'network'`，服务器只收到 2 个请求。
- [ ] **新 socket 上的 ECONNRESET 不重试**：服务器 accept 后立刻 destroy（第 1 个请求即 RST，`reusedSocket === false`）→ GET 直接 reject `network`，服务器只见 1 条连接。
- [ ] **谓词单测**：`isStaleSocketErrorCode('ECONNRESET') === true`、`'EPIPE' === true`、`'ETIMEDOUT' === false`、`undefined === false`。
- [ ] **重试也失败时如实上报**：服务器对每条连接的第 2 个请求都 destroy——不可行（重试走新连接的第 1 个请求）；改为服务器只在收到首个请求后 200，之后无条件 destroy 一切 socket 并拒绝新连接（`server.close` 后触发）→ 第二次 GET 重试遇 ECONNREFUSED → 断言最终 reject `network` 且 message 不含 "StaleReusedSocketError"。

### 陷阱

- `StaleReusedSocketError` **绝不能逃出** `performRequest`——它没有 `kind`，上层 `logClassifiedFailure` 会当作 unclassified。重试包装的 catch 是唯一消费者。
- `settled` 守卫已存在，重试信号也要走 `settleReject`，否则和 size-cap abort 竞态。
- 不要把重试做在 `requestJson`/`requestRaw` 层：那里已经丢失 `reusedSocket` 与原始 code。
- 日志走 `this.log.debug` 且只写 pathname（该文件既有规矩：query 可能带凭据）。
- 有 payload 的 GET 理论上存在（本项目没有）；规格按 method 判断即可，不必检查 payload。

### Done when

- [ ] 上述 5 组测试全绿，现有 NacosHttpClient 测试无回归；
- [ ] 代码里唯一的重试点在 `performRequest`，写路径任何情况下 attempt 数为 1；
- [ ] `npm run typecheck && npm test` 通过。

---

## Task B4 — 文档 provider 30s TTL 缓存（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`provideTextDocumentContent` `NacosConfigDocumentProvider.ts:71-95`（无缓存，三个失败文案分支在 :74/:82/:93）、`refresh` `:57-59`、`compareAcrossEnvironments` `diffConfig.ts:109-148`、`hasConfig :164-174`（doc 注释确有 "The content it fetches is thrown away"）——全部一致。

### 现状

- `src/document/NacosConfigDocumentProvider.ts` 的 `provideTextDocumentContent`（第 71–95 行）每次被 VS Code 询问都完整走一遍 `getInstance → createClient → getConfig/getConfigHistory`，**无任何缓存**。`refresh(instanceId, ref)`（第 57–59 行）只 fire `onDidChangeEmitter`，是现成的失效钩子。
- 跨环境比对 `compareConfigAcrossEnvironments`（`src/document/diffConfig.ts` 第 109–148 行）：`hasConfig`（第 164–174 行）先 `getConfig(targetRef)` **把 content 扔掉**（doc 注释自己承认 "The content it fetches is thrown away; the diff refetches both sides"），随后 `vscode.diff` 让 provider 把目标侧**再读一次**、源侧读一次——目标配置一次比对读 2 遍，合计 3 个 `getConfig`。
- Phase 0 后 client 池已把 login/probe 摊平，但 `getConfig` 的往返仍然每次都发。

### 目标

- provider 内部按 `uri.toString()` 加 30 秒 TTL 缓存，只缓存**成功读到的 content**；
- `refresh()` 先删缓存再 fire 事件（VS Code 收到 onDidChange 后会重新调 provideTextDocumentContent，此时必须读到新值）；
- 提供 `prime(uri, content)` 给 compare 流程灌缓存，把"3 读"降到"2 读"（源 1 + 目标 1）。

### 涉及文件

- `src/document/NacosConfigDocumentProvider.ts`
- `src/document/diffConfig.ts`
- `src/extension.ts`（compare 命令处把 provider 的 prime 传进去）
- `test/document/NacosConfigDocumentProvider.test.ts`、`test/document/diffConfig.test.ts`

### 实施步骤

- [ ] `NacosConfigDocumentProvider` 增加：

```ts
/** 30 秒：长到覆盖一次 diff 的两侧读取与用户来回切 tab，短到发布后忘了 refresh 也不会看很久的旧值。 */
const CONTENT_CACHE_TTL_MS = 30_000;

interface CachedContent {
  content: string;
  expiresAt: number;
}
```

  - 字段 `private readonly contentCache = new Map<string, CachedContent>();`
  - 构造函数追加可选 `private readonly now: () => number = Date.now`（测试注入假时钟）；
  - `provideTextDocumentContent` 在 `parseConfigUri` 成功后、`getInstance` 之前查缓存：

```ts
const cacheKey = uri.toString();
const cached = this.contentCache.get(cacheKey);
if (cached && cached.expiresAt > this.now()) {
  return cached.content;
}
```

  - 成功路径 `return detail.content;` 之前写入缓存；**catch 分支与两个"instance 不存在/uri 不合法"文案分支一律不缓存**（缓存错误文案 30 秒会让用户的下一次点击继续看旧错）。
  - `refresh(instanceId, ref)` 改为：

```ts
refresh(instanceId: string, ref: NacosConfigRef): void {
  const uri = buildConfigUri(instanceId, ref);
  this.contentCache.delete(uri.toString());
  this.onDidChangeEmitter.fire(uri);
}
```

  历史版本 uri（带 nid）内容不可变，TTL 自然过期即可，refresh 不需要清它们。
  - 新增 `prime(uri: vscode.Uri, content: string): void`（写入缓存，expiresAt 同上）；
  - `dispose()` 里 `this.contentCache.clear();`。
- [ ] `diffConfig.ts`：`CompareAcrossEnvironmentsOptions` 增加可选 `primeTarget?: (uri: vscode.Uri, content: string) => void;`。`hasConfig` 改为返回 `{ exists: boolean; content?: string }`（或新函数 `readConfigIfExists`），compare 流程在存在时调用 `options.primeTarget?.(buildConfigUri(target.id, targetRef), content)` 再执行 `vscode.diff`。
- [ ] `src/extension.ts` 的 `compareAcrossEnvironmentsCommand`：传 `primeTarget: (uri, content) => configDocumentProvider.prime(uri, content)`。

### 测试

- [ ] `NacosConfigDocumentProvider.test.ts`：
  - 同一 uri 30s 内两次 `provideTextDocumentContent` 只调 1 次 `getConfig`（factory/client 用 vi.fn 计数）；
  - 假时钟推进 30_001ms 后再次读取会重新拉取；
  - `refresh` 后立即读取会重新拉取（TTL 未到也失效）；
  - 读取失败返回文案且**不缓存**：第一次 reject、第二次 resolve，两次都真实调用了 client，第二次拿到正文；
  - `prime` 后读取不发请求；
  - 历史 uri（nid）与当前 uri 各自独立缓存。
- [ ] `diffConfig.test.ts`：compare 成功路径断言 `primeTarget` 恰被调用一次、参数 uri 与 `vscode.diff` 的右侧 uri 相同；`resource-not-found` 路径不调用 `primeTarget`。

### 陷阱

- **必须先删缓存再 fire**：`publishConfig` / `rollbackConfig` / `deleteConfig`（extension.ts 里的 `refreshDocument` 回调）都靠 refresh 让打开的 tab 显示新内容，顺序反了就是发布后 30 秒内看旧值——这正是此任务最容易犯的错。
- 并发去重（两次并发读同一 uri 只发一次请求）**不做**：缓存存的是 content 不是 promise，保持实现简单；30s TTL 已覆盖主要浪费。若要做，缓存 `Promise<string>` 且失败时自清，参考 `NacosClientPool` 第 48–55 行的模式——记为可选优化，不列入 Done 标准。
- `prime` 的 key 必须与 provider 读取时的 key 完全一致（都经 `buildConfigUri` + `toString()`），不要手拼字符串。
- 别缓存"instance 已删除"的文案：实例可能马上被重新添加。

### Done when

- [ ] 上述测试全绿；跨环境比对对目标配置的 `getConfig` 调用从 2 次降到 1 次（diffConfig 测试可断言 client.getConfig 调用数）；
- [ ] 发布/回滚后打开的文档 tab 内容立即更新（现有 WriteCommands 测试无回归）；
- [ ] `npm run typecheck && npm test` 通过。

---

## Task B5 — `NacosHttpClient` 默认响应体上限 4MB（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`maxResponseBytes` 读取 `NacosHttpClient.ts:231`、超限 destroy `:283-297`；两处现有调用方 `NacosDriver.ts:348`（`listResponseCap` 定义在 `:318`）与 `resolveBaseUrl.ts:100`；`FALL_THROUGH_KINDS` `NacosApiError.ts:38-42` 确不含 `response-too-large`——全部一致。

### 现状

- `maxResponseBytes` 机制已存在且被验证（`src/nacos/NacosHttpClient.ts` 第 231、283–297 行：超限即 destroy 流并抛 `response-too-large`）。
- 但**只有两处**在用：
  - `src/nacos/driver/NacosDriver.ts` 的 `fetchConfigPage`（第 348 行，`listResponseCap(pageSize)` = min(pageSize×128KB, 4MB)）；
  - `src/nacos/probe/resolveBaseUrl.ts` 的 console hint 探测（第 100 行）。
- 其余端点——namespaces、服务列表、实例列表、订阅者、监听者、历史列表、集群节点、metrics、config 详情、登录——都**无上限**，一个异常膨胀的响应会在扩展宿主里物化成任意大的字符串。

### 目标

`performRequest` 层加默认 cap：`options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES`（4MB）。调用方仍可覆盖为更小（config 列表已在做）或更大的值。

### 涉及文件

- `src/nacos/NacosHttpClient.ts`
- `test/nacos/NacosHttpClient.test.ts`

### 实施步骤

- [ ] `NacosHttpClient.ts` 增加导出常量并接线：

```ts
/**
 * 任何一次响应默认最多缓冲 4MB。与 NacosDriver.MAX_LIST_RESPONSE_BYTES 同值：
 * 这是"绝不该发生"的护栏，不是功能上限——本项目最大的一类合法响应
 * （满页 100 条 × 128KB 的 v1 config 列表）被 fetchConfigPage 自己的
 * 更精确 cap 先拦住。调用方传 maxResponseBytes 覆盖，传
 * Number.POSITIVE_INFINITY 表示明确放行无上限。
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
```

  `performRequest` 第 231 行改为：

```ts
const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
```

  下方判断 `if (maxResponseBytes !== undefined && size > maxResponseBytes)` 可简化为 `if (size > maxResponseBytes)`（`POSITIVE_INFINITY` 时恒 false，语义保持）。
- [ ] `NacosRequestOptions.maxResponseBytes` 的 doc 注释更新：写明默认 4MB 与 `POSITIVE_INFINITY` 逃生门。
- [ ] 确认 `response-too-large` 不在 `FALL_THROUGH_KINDS`（`src/nacos/NacosApiError.ts` 第 38–42 行，目前只有 not-found/api-deprecated/forbidden）——超大响应不会让 resolver 徒劳地走遍驱动链。已满足，不需改，但在任务 PR 描述里说明核对过。

### 测试

- [ ] `test/nacos/NacosHttpClient.test.ts`：
  - 无选项请求一个响应 > `DEFAULT_MAX_RESPONSE_BYTES` 的路由（testHttpServer 流式写 4MB+1 字节，如循环 write 1MB 块）→ reject `kind === 'response-too-large'`，消息含默认字节数；
  - 传 `maxResponseBytes: 6 * 1024 * 1024` 同一路由 → resolve；
  - 传 `maxResponseBytes: Number.POSITIVE_INFINITY` → resolve；
  - 现有小上限用例（若有）不回归。
- [ ] 跑全量 `npm test` 确认没有 fixture 响应意外超 4MB（不会有，最大 fixture 远小于此）。

### 陷阱

- **别删 `fetchConfigPage` 的 `listResponseCap`**——它比默认值更严（小页时几百 KB），是主要防线；默认 cap 是兜底。
- 大响应测试要**流式生成**，不要先在测试进程里 `'x'.repeat(5MB)` 拼 JSON 再整体发——会把测试自己 OOM 风险和耗时抬上去；发纯文本配普通 `requestRaw` 即可（`requestRaw` 不解析 JSON）。
- 消息里的字节数用的是生效值：默认路径显示 4194304，便于用户在 issue 里辨认是默认 cap 还是调用方 cap。

### Done when

- [ ] 全部端点默认受 4MB 保护，覆盖与逃生门可用，测试全绿；
- [ ] `npm run typecheck && npm test` 通过。

---

## Task B6 — MCP 独立客户端池（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：基线 `extension.ts:267` 附近的 agent `createClient` 确为 `createNacosClient(...)` 直建，旁注即 "Deliberately not getOrCreateClient"；`resolveInstance` 的非交互 verifier 构造在 `NacosAgentToolService.ts:196-201`；`NacosClientPool` 指纹字段 `:15`、失败自淘汰 `:48-55`、`clear()`/`evict(id)` `:65`/`:69`；`refreshAfterInstanceChange` 在 `extension.ts:203` 按 id evict——全部一致（即「Phase 0 后」小节描述的就是当前基线，读到这里可直接照做）。

### 现状（分 checkout 说清楚）

- **本 checkout（main/v0.1.2）**：`src/extension.ts` 中 `createClient: (instance) => getOrCreateClient(instance)` —— agent 工具**共用 UI 池**，并**忽略** `NacosAgentToolService.resolveInstance` 传来的非交互 `certVerifier` 参数（`src/agent/NacosAgentToolService.ts` 第 196–203 行构造了它），后台工具调用可能弹出交互式证书确认框。
- **Phase 0 后（必须以此为基线）**：opt-1-8 的 `extension.ts` 改为

```ts
createClient: (instance, certVerifier) =>
  createNacosClient(configManager, instance, certTrustStore, log, certVerifier),
```

  注释明说 "Deliberately not getOrCreateClient... A fresh client per tool call costs an extra login"。即：verifier 正确了，但**每次工具调用都新建 client**——一次 login（服务端 BCrypt）+ 一次 `/state` 探测 +（3.x）console 发现。Agent 一轮对话十几次工具调用就是十几次登录。
- `src/nacos/NacosClientPool.ts`：池按 `instance.id` 为 key，`instanceFingerprint`（serverUrl/consoleUrl/authMode/username/readOnly/updatedAt）不匹配即自动重建；失败的 pending promise 自清（第 48–55 行）。**同一个池不能混用两种 verifier**——这正是 Phase 0 注释拒绝共享池的原因，所以解法是"第二个池"，不是"共享池"。

### 目标

新增 `agentClientPool = new NacosClientPool()`，仅供 MCP 路径使用（非交互 verifier 的 client），与 UI 池同步驱逐。

### 涉及文件

- `src/extension.ts`
- `test/agent/NacosAgentToolService.test.ts`、`test/extension/ExtensionLifecycle.test.ts`（或 InstanceCommands.test.ts，看 Phase 0 后驱逐逻辑的测试落点）

### 实施步骤

- [ ] `activate` 中紧挨 `const clientPool = new NacosClientPool();` 增加：

```ts
// MCP 后台路径专用池：与 UI 池隔离，因为两边的 certVerifier 不同——
// UI 池的 client 带交互式 TOFU 弹窗，agent 池的只查 trust store。
// 池按 instance.id 为 key，混用会把带弹窗的 client 交给后台调用（或反之）。
const agentClientPool = new NacosClientPool();
```

- [ ] `nacosAgentToolService` 的 factory 改为过池：

```ts
createClient: (instance, certVerifier) =>
  agentClientPool.getClient(instance, (inst) =>
    createNacosClient(configManager, inst, certTrustStore, log, certVerifier)
  ),
```

  并把 Phase 0 留下的 "Deliberately not getOrCreateClient..." 注释改写为解释"独立池"而非"不缓存"。
- [ ] 驱逐点逐一同步（在 Phase 0 的 extension.ts 里搜以下符号）：
  - `refreshAfterInstanceChange(instanceId?)`：`clientPool.evict(id)` 后加 `agentClientPool.evict(id)`；
  - 实例删除路径（`manageInstances` → `deleteInstanceWithConfirmation` 的 `onChanged` 回调最终走到的刷新函数）：同上；
  - `refreshConfigsCommand` / `refreshServicesCommand` 里的 `clientPool.clear()`：加 `agentClientPool.clear()`（用户点 Refresh 的语义是"重连"，后台池一起重建，成本是 agent 下次调用多一次登录，可接受）；
  - B1 的 `onDidChangeConfiguration` 监听里加 `agentClientPool.clear()`。
- [ ] 指纹里的 `updatedAt` 已保证"实例编辑后自动失效"，`allowBackgroundAccess` 开关在 `resolveInstance` 里每次调用前检查（池外），关闭后残留的池条目不可达且会在下次实例保存时因 updatedAt 变化而过期——在 factory 旁写一行注释说明这一链路。
- [ ] verifier 闭包差异说明：`resolveInstance` 每次调用都 new 一个 verifier 对象，但语义恒等（查同一 trust store）。池命中时用的是**第一次调用**的 verifier——行为一致，安全。在 factory 注释里写明，防后人误改成把 verifier 放进指纹。

### 测试

- [ ] `test/agent/NacosAgentToolService.test.ts`（Phase 0 后该文件已有 factory mock）不需要动——池在 extension.ts 层。新增/修改 `test/extension/ExtensionLifecycle.test.ts`（activate 级）：
  - 用 fixture 触发 bridge toolService 的 `invoke`（或直接从 activate 后拿到 toolService 引用）连续调两次同 instanceId 的工具 → 底层 `createNacosClient` 等价物只被调 1 次。若 activate 级不好插桩，改为单测 `NacosClientPool` 组合行为 + 一个"驱逐点全覆盖"的静态断言测试：对 extension.ts 源码文本断言 `agentClientPool.evict` / `agentClientPool.clear` 出现在与 `clientPool.evict` / `clientPool.clear` 相同数量的位置（简单粗暴但能防漏点）。两种取其一，优先前者。
  - 实例编辑（`refreshAfterInstanceChange('id')`）后再次调用工具 → factory 再次执行。
- [ ] `test/nacos/NacosClientPool.test.ts` 已覆盖池本身语义，确认无需扩展（fingerprint / 失败自清 / evict / clear 均有）。

### 陷阱

- **不要把两个池合成一个加"verifier 维度 key"**——`NacosClientPool` 的 key 语义是 instance.id，改 key 结构会波及 UI 池所有驱逐点；两个池各 7 行代码，风险低得多。
- 驱逐点漏一处的症状是"编辑实例地址后 agent 还连旧地址直到 updatedAt 指纹兜底生效"——updatedAt 恰好每次保存都变，所以漏 evict 其实被指纹兜住；**真正兜不住的是 `clear()` 类**（B1 设置变更：timeoutMs 冻结在 client 里，不 clear agent 池则 agent 请求永远用旧超时）。测试至少覆盖设置变更清 agent 池这一条。
- deactivate 不需要清池（进程终结），不要给 cleanup 加多余步骤。

### Done when

- [ ] 同一 instance 连续 MCP 工具调用只登录/探测一次（测试断言 factory 调用数）；
- [ ] UI 池所有 evict/clear 点 agent 池同步；B1 的设置监听两池都清；
- [ ] 后台调用绝不弹交互证书框（verifier 仍是 resolveInstance 构造的非交互版，Phase 0 行为保持）；
- [ ] `npm run typecheck && npm test` 通过。

---

## Task B7 — 3.x 实例/订阅者列表 >100 不再静默截断（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`V3ConsoleDriver` `:96`/`:102`/`:148-153`/`:155-160`、`V3AdminDriver` `:91`/`:151-153`/`:155-157`、`naming.ts` `fetchCatalogInstances :199-219`、v1 订阅者「服务端默认 pageSize 1000」注释 `:288-292`、`aggregation` 分支 `:306-309`、接口 `NacosDriver.ts:237`/`:239`、`V1Driver :170`/`:177`、`V2Driver :184`/`:191`、`NacosClient :181-186`、`normalizeInstanceList` `normalize.ts:647+`、`ServiceSubscribersPanel :122`、`listServiceInstances :341-353`——全部一致。已修正 2 处行号：`ServiceTreeProvider.fetchInstances` 248-251→316-319、`listServiceSubscribers` 443-455→448-460。

### 现状

- `src/nacos/driver/V3ConsoleDriver.ts`：第 96 行 `const FIRST_INSTANCE_PAGE = { pageNo: '1', pageSize: '100' };`、第 102 行 `const FIRST_SUBSCRIBER_PAGE = { pageNo: '1', pageSize: '100' };`，分别在 `listInstances`（第 148–153 行）与 `listSubscribers`（第 155–160 行）作为 `options.query` 传入。注释自己承认："a service with more instances than that would be truncated here"。
- `src/nacos/driver/V3AdminDriver.ts`：第 91 行 `const FIRST_SUBSCRIBER_PAGE = { query: { pageNo: '1', pageSize: '100' } };`，用于 `listSubscribers`（第 155–157 行）。**3.x admin 的 `listInstances` 不分页**（第 151–153 行无 paging），无此问题。
- `src/nacos/driver/naming.ts` 的 `fetchCatalogInstances`（第 199–219 行）：1.x/2.x catalog 实例列表固定 `pageNo: '1', pageSize: '500'` —— >500 实例同样静默截断。
- v1 订阅者端点不发分页参数，服务端默认 pageSize 1000（naming.ts 第 288–292 行注释）——>1000 截断，但客户端无法控制，只能如实标注。
- 域类型：`NacosDriver.listInstances(): Promise<NacosInstance[]>`、`listSubscribers(): Promise<NacosSubscriber[]>`（`src/nacos/driver/NacosDriver.ts` 第 237、239 行），接口注释写着 "unpaged... it is the driver's business to ask for a page large enough that the difference does not reach here"——这个承诺在 3.x 上是假的，本任务把它改真。
- 消费方（全部枚举，TypeScript 会逼你改齐）：
  - `src/nacos/NacosClient.ts` 第 181–186 行（两方法透传）；
  - 四个 driver：`V1Driver.ts` 170/177、`V2Driver.ts` 184/191、`V3AdminDriver.ts` 151/155、`V3ConsoleDriver.ts` 148/155；
  - `src/tree/ServiceTreeProvider.ts` 第 316–319 行 `fetchInstances`；
  - `src/webview/ServiceSubscribersPanel.ts` 第 122 行；
  - `src/agent/NacosAgentToolService.ts` `listServiceInstances`（第 341–353 行）、`listServiceSubscribers`（第 448–460 行）；
  - `test/live/liveServer.test.ts` 与相关单测。

### 目标（设计已定，不要再摇摆）

**翻页循环 + `truncated` 标志，两者都做**：分页端点在 driver 内循环拉到上限（实例/订阅者各 10 页 × 100 = 1000 行；catalog 2 页 × 500 = 1000 行），仍拉不完则 `truncated: true`。域类型改为携带标志的列表结果，让每个消费面（树、面板、MCP）**必须**决定如何呈现截断——这就是"不静默"。

### 实施步骤

- [ ] `src/nacos/driver/normalize.ts` 新增导出类型：

```ts
/**
 * 一份"本应完整"的列表与它是否真的完整。3.x 的实例/订阅者端点强制分页，
 * driver 循环翻页到 MAX_UNPAGED_ROWS 为止；再多就 truncated=true，
 * 由 UI/MCP 面向用户说明，而不是在这里静默丢行。
 */
export interface CappedList<T> {
  items: T[];
  truncated: boolean;
}
```

- [ ] `src/nacos/driver/NacosDriver.ts`：两方法签名改为 `Promise<CappedList<NacosInstance>>` / `Promise<CappedList<NacosSubscriber>>`，并把接口 doc 从 "unpaged" 改写为如实描述（翻页聚合 + 上限 + 标志）。
- [ ] `src/nacos/driver/naming.ts`：
  - 新增常量 `const MAX_AGGREGATED_ROWS = 1000;`（一个服务 1000 个实例/订阅者已远超 IDE 呈现能力，翻 10 页是往返成本上限）；
  - `fetchInstances` 改为返回 `CappedList<NacosInstance>`：无 `options.query` 分页时单次请求 `{ items, truncated: false }`；调用方要分页聚合时改用新函数：

```ts
export async function fetchPagedInstances(
  http: Pick<NacosHttpClient, 'requestJson'>,
  endpointFlavor: NacosApiFlavor,
  path: string,
  query: NacosInstanceQuery,
  pageSize: number,
  options?: NacosRequestOptions
): Promise<CappedList<NacosInstance>> {
  const items: NacosInstance[] = [];
  const maxPages = Math.ceil(MAX_AGGREGATED_ROWS / pageSize);
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const payload = await http.requestJson<unknown>('GET', path, {
      ...options,
      query: {
        ...options?.query,
        ...instanceParams(endpointFlavor, query),
        pageNo: String(pageNo),
        pageSize: String(pageSize)
      }
    });
    const page = normalizeInstanceList(payload, path);
    items.push(...page);
    // 短页 = 最后一页。整页且已到轮次上限 = 可能还有；宁可误报 truncated
    // （总数恰为 pageSize 整倍数时）也不静默丢——doc 注释写明这个取舍。
    if (page.length < pageSize) {
      return { items, truncated: false };
    }
  }
  return { items, truncated: true };
}
```

  - `fetchSubscribers` 同构改造出 `fetchPagedSubscribers`（注意订阅者的 query 拼装含 `aggregation` 分支，保留）；不分页版本（v1/v2）返回 `{ items, truncated: false }` 并在 doc 里写明 v1 服务端默认 pageSize 1000 的固有上限；
  - `fetchCatalogInstances` 改用 `fetchPagedInstances` 风格循环（pageSize 500，同一 `MAX_AGGREGATED_ROWS`）；`listInstancesPreferringCatalog` 泛型签名跟着改 `Promise<CappedList<NacosInstance>>`。
- [ ] 四 driver 对齐：
  - `V3ConsoleDriver.listInstances` → `fetchPagedInstances(..., 100, this.onConsoleOrigin())`，删 `FIRST_INSTANCE_PAGE`；`listSubscribers` → `fetchPagedSubscribers(..., 100, this.onConsoleOrigin())`，删 `FIRST_SUBSCRIBER_PAGE`；
  - `V3AdminDriver.listSubscribers` → `fetchPagedSubscribers(..., 100)`，删它的 `FIRST_SUBSCRIBER_PAGE`；`listInstances` 保持单次请求，包成 `{ items, truncated: false }`；
  - `V1Driver` / `V2Driver`：包装返回值（catalog 路径来自改造后的函数已带标志）。
- [ ] `src/nacos/NacosClient.ts`：签名透传 `CappedList<...>`。
- [ ] 消费面：
  - `ServiceTreeProvider.fetchInstances`：取 `.items` 绘制；`truncated === true` 时在实例列表末尾追加一个不可点的说明节点（复用现有信息节点样式，文案 `t('Only the first {count} instances are shown; the service has more.', {...})`）——若现有树没有信息节点基建，退而求其次：`log.warn` + 实例节点 tooltip 追加说明，并在 PR 里写明取舍；
  - `ServiceSubscribersPanel`：`ServiceSubscribersSnapshot` 增加 `truncated?: boolean`，render 时 `note(t('Only the first {count} subscribers are shown.', ...))`；
  - `NacosAgentToolService.listServiceInstances` 返回 `{ instances: r.items, truncated: r.truncated }`；`listServiceSubscribers` 返回 `{ subscribers: r.items, truncated: r.truncated }`。
- [ ] MCP 描述（`src/mcp/toolCatalog.ts`）**必须**同步：
  - `nacos_list_service_instances` 描述追加：`'Aggregates server-side pages up to 1000 hosts; the result carries truncated: true when the service has more.'`；
  - `nacos_list_service_subscribers` 描述追加同句式（1000 subscribers）。
  - `test/mcp/toolCatalog.test.ts` 若断言了描述文本，更新。

### 测试

- [ ] `test/nacos/driver/`（naming 相关测试文件）：
  - fixture 服务器按 `pageNo` 返回三页（100/100/30）→ `items.length === 230`、`truncated === false`、恰发 3 次请求；
  - 十页全满 → `items.length === 1000`、`truncated === true`、恰发 10 次请求（不发第 11 次）；
  - 总数恰 200（两整页后第三页空）→ 发 3 次、`truncated === false`（空页长度 0 < pageSize 走短页分支）；
  - v1 不分页路径 → 单请求、`truncated === false`；
  - catalog 路径 pageSize 500 翻页与截断。
- [ ] `test/agent/NacosAgentToolService.test.ts`：两工具结果含 `truncated` 字段；mock client 返回 truncated true 时如实透出。
- [ ] `test/webview/ServiceSubscribersPanel.test.ts`：truncated 快照渲染出提示 note。
- [ ] `test/tree/ServiceTreeProvider.test.ts`：truncated 时的树呈现（按最终选型断言）。
- [ ] live 测试 `test/live/liveServer.test.ts`：编译层面跟着改 `.items`（live 环境跑不跑得到不作要求）。

### 陷阱

- **normalizeInstanceList 认多种数组容器**（hosts/list/pageItems/instances/items/serviceInfo.hosts，normalize.ts 第 647–682 行）——翻页循环的"短页判断"用**归一化后的长度**没问题，但注意 v1 不分页端点若被误走翻页函数，会把同一批 hosts 重复拉 10 遍：翻页函数只允许 3.x console 实例、3.x console/admin 订阅者、catalog 实例四个调用点使用，别图省事全改。
- `aggregation` 参数只在 v3-admin/v3-console 发（naming.ts 第 306–309 行），翻页改造时保持原判断。
- 误报 truncated（总数恰为 pageSize 整倍数且恰好在轮次上限）已在设计里接受并写注释；**不要**为消掉它加"再探一页"的请求。
- `updateInstanceHealth` 不直接调 `listInstances`（它拿树节点上的 instance 整行回写），不受影响——但树的实例行来自 `.items`，确认 ServiceInstanceTreeItem 构造处改干净。
- 这是全计划改动面最大的任务：**单独分支**，typecheck 会把漏改点全暴露出来，逐个清零后再跑测试。

### Done when

- [ ] 四 driver 签名统一为 `CappedList`，编译零错误；
- [ ] >100 实例/订阅者的 3.x 服务能拉到 1000 内全量，超出有显式标志且树/面板/MCP 三个面都有呈现；
- [ ] 两条 MCP 工具描述如实写明聚合上限与 truncated 字段；
- [ ] 上述测试全绿，`npm run typecheck && npm test` 通过。

---

## Task B8 — `nacos_get_cluster_nodes` 不吞错误（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`getClusterNodes` 的 `catch(() => [])` / `catch(() => undefined)` 在 `NacosAgentToolService.ts:355-363`（现状引文与基线逐字一致）；`ClusterStatusSnapshot` 的 `nodesError`/`metricsError` 在 `ClusterStatusPanel.ts:30-36`、`loadClusterStatus :150-172`、`settle` `panelParts.ts:78`；`formatError` 已在文件 import——全部一致。

### 现状

Phase 0 后 `src/agent/NacosAgentToolService.ts` 的 `getClusterNodes`：

```ts
const [nodes, metrics] = await Promise.all([
  resolved.client.listClusterNodes().catch(() => []),
  resolved.client.getServerMetrics().catch(() => undefined)
]);
return { ok: true, result: { nodes, metrics } };
```

`catch(() => [])` 把"集群节点端点 403/网络断"渲染成"这个集群没有节点"——对 Agent 是最坏的谎言。对照物：`ClusterStatusPanel` 的 `ClusterStatusSnapshot`（`src/webview/ClusterStatusPanel.ts` 第 30–36 行）早就分离了 `nodesError` / `metricsError` 两个已脱敏字符串字段，且 `loadClusterStatus`（第 150–172 行）用 `settle`（`src/webview/panelParts.ts` 第 78 行）实现"各自失败各自说"。

### 目标

MCP 结果对齐面板快照形状：`{ nodes, metrics?, nodesError?, metricsError? }`，错误经 `formatError`（已走 redaction）。工具描述同步。

### 涉及文件

- `src/agent/NacosAgentToolService.ts`
- `src/mcp/toolCatalog.ts`
- `test/agent/NacosAgentToolService.test.ts`、`test/mcp/toolCatalog.test.ts`（如有描述断言）

### 实施步骤

- [ ] `getClusterNodes` 改为（不 import webview 的 `settle`——agent 层不该依赖 webview 模块，`panelParts` 顶部有 vscode 间接依赖链；就地内联同构小函数）：

```ts
private async getClusterNodes(input: NacosGetClusterNodesInput): Promise<ToolInvokeResult> {
  const resolved = await this.resolveInstance(input.instanceId);
  if (!resolved.ok) {
    return resolved.failure;
  }
  // 与 ClusterStatusPanel 的快照同形：两个能力各自失败各自报告，
  // 空数组必须只表示"服务器真的答了空"，绝不代替错误。
  const [nodes, metrics] = await Promise.all([
    resolved.client.listClusterNodes().then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error: formatError(error) })
    ),
    resolved.client.getServerMetrics().then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error: formatError(error) })
    )
  ]);
  return {
    ok: true,
    result: {
      nodes: nodes.value ?? [],
      metrics: metrics.value,
      nodesError: nodes.error,
      metricsError: metrics.error
    }
  };
}
```

  注意：`formatError` 已在文件里 import。3.x console 链的 metrics 是 `missingCapability`（`not-found`），会变成一条可读的 `metricsError`——这与工具描述"metrics may be omitted"升级为"metricsError 会解释为什么没有"，比静默 undefined 更诚实。
- [ ] `toolCatalog.ts` 的 `nacos_get_cluster_nodes` 描述改为：

```
'Get Nacos server cluster node topology, server status, raft roles, and operational metrics. ' +
'Each half fails independently: nodesError / metricsError carry the reason when nodes or metrics could not be read (3.x console has no metrics endpoint, so metricsError is expected there). ' +
'An empty nodes array with no nodesError means the server really answered with none. Requires only instanceId.'
```

### 测试

`test/agent/NacosAgentToolService.test.ts`（已有 getClusterNodes 用例，Phase 0 扩过）：

- [ ] nodes reject（如 `NacosApiError('forbidden', ...)`）+ metrics resolve → `nodes: []`、`nodesError` 为非空字符串、`metricsError === undefined`、`metrics` 有值；
- [ ] metrics reject + nodes resolve → 对称断言；
- [ ] 双双 reject → 两个 error 字段都有、`ok: true`（部分失败不是工具失败）；
- [ ] 双双 resolve → 两个 error 字段 `undefined`（JSON 序列化后不出现）；
- [ ] 错误消息经过 redaction：mock reject 一个 message 含 `password=hunter2` 的错误，断言结果字符串不含 `hunter2`（`formatError → toUserMessage` 的既有能力，测它防回归）。

### 陷阱

- `ok: true` 是对的：`resolveInstance` 失败（实例不存在/未授权）仍走 failure；能力级失败属于"结果的一部分"。不要把双失败升级成 `ok: false`——那会让 Agent 拿不到"哪半失败"的结构化信息。
- 不要复用 webview 的 `settle`：跨层 import 会把 webview 模块拽进 agent 依赖图。
- 结果字段名必须与面板快照一致（`nodesError`/`metricsError`），文档与实现互查时少一套词汇。

### Done when

- [ ] 五个测试场景全绿；描述如实；`npm run typecheck && npm test` 通过。

---

## Task B9 — 脏草稿可发现：列出 / 丢弃命令（P2）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`drafts` Map `NacosDraftFileSystemProvider.ts:34`、`DraftEntry :14-20`（instanceId/ref/content/baseContent/mtime 齐全）、`deleteDraft :77`、`isDirty :93`；`closeDocumentListener`（`extension.ts:828+`）确为「只删干净草稿」；`openDraftDocument` 里 `assertWritable` 在 `openDraftDocument.ts:41`（坑 3 属实）；`buildDraftUri`/`NACOS_DRAFT_SCHEME` 在 `draftUri.ts`（scheme 常量 `:4`）、`formatTimestamp` 在 `time.ts:13` 均已导出——全部一致。

### 现状

- `src/document/NacosDraftFileSystemProvider.ts`：草稿存内存 `private readonly drafts = new Map<string, DraftEntry>()`（第 34 行）。
- Phase 0 后 `extension.ts` 的 `closeDocumentListener`：关 tab 时**只删干净草稿**（`if (!draftFileSystemProvider.isDirty(target)) deleteDraft(target)`）。脏草稿（改过没发布）保留在 Map 里——这是对的（防丢编辑），但**没有任何入口**能再看到它：树上无标记、无命令列出，用户唯一的路径是碰巧再点同一条配置的 Edit（`openDraftDocument` 会复用 existing.content）。
- `DraftEntry` 已含 `instanceId`、`ref`、`content`、`baseContent`、`mtime` —— 列表所需字段齐全。
- **本任务不做磁盘持久化**（窗口重载丢草稿的问题留作可选后续，见文末）。

### 目标

新命令 `atNacos.manageDrafts`（命令面板常驻可见）：列出所有**脏**草稿 → 选中后二选一：打开（回到编辑器）或丢弃（确认后删除）。

### 涉及文件

- `src/document/NacosDraftFileSystemProvider.ts`（加 `listDrafts()`）
- `src/extension.ts`（命令实现与注册）
- `package.json`、`package.nls.json`、`package.nls.zh-cn.json`（命令贡献）
- `l10n/bundle.l10n.zh-cn.json`（运行时文案）
- `test/document/NacosDraftFileSystemProvider.test.ts`、`test/extension/WriteCommands.test.ts`（或新建 `DraftCommands.test.ts`）、`test/extension/Manifest.test.ts`

### 实施步骤

- [ ] provider 增加：

```ts
/** 当前内存中的全部草稿，供"管理草稿"命令列出。调用方自行按 isDirty 过滤。 */
listDrafts(): DraftEntry[] {
  return [...this.drafts.values()];
}
```

- [ ] `package.json` `contributes.commands` 增加：

```json
{ "command": "atNacos.manageDrafts", "title": "%atNacos.command.manageDrafts.title%" }
```

  不加 `commandPalette.when: false`（这个命令就是给面板用的）。nls：英文 `"AT Nacos: Manage Unpublished Drafts"`，中文 `"AT Nacos: 管理未发布草稿"`。
- [ ] `extension.ts` 注册命令（放在 publish/delete 命令附近，push 进 subscriptions）：

```ts
const manageDraftsCommand = vscode.commands.registerCommand('atNacos.manageDrafts', async () => {
  try {
    const dirty = draftFileSystemProvider
      .listDrafts()
      .filter((draft) => draft.content !== draft.baseContent)
      .sort((a, b) => b.mtime - a.mtime);
    if (dirty.length === 0) {
      await vscode.window.showInformationMessage(t('There are no unpublished configuration drafts.'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      dirty.map((draft) => ({
        label: draft.ref.dataId,
        description: `${draft.ref.group} @ ${draft.ref.namespaceId === '' ? 'public' : draft.ref.namespaceId}`,
        detail: t('Modified {time}', { time: formatTimestamp(draft.mtime) }),
        draft
      })),
      { placeHolder: t('Select an unpublished draft') }
    );
    if (!picked) {
      return;
    }
    const openAction = t('Open');
    const discardAction = t('Discard');
    const action = await vscode.window.showQuickPick([openAction, discardAction], {
      placeHolder: picked.draft.ref.dataId
    });
    if (action === openAction) {
      const uri = buildDraftUri(picked.draft.instanceId, picked.draft.ref);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
      return;
    }
    if (action === discardAction) {
      const confirm = await vscode.window.showWarningMessage(
        t('Discard the unpublished draft of {dataId}? Your local edits will be lost.', {
          dataId: picked.draft.ref.dataId
        }),
        { modal: true },
        discardAction
      );
      if (confirm === discardAction) {
        draftFileSystemProvider.deleteDraft({ instanceId: picked.draft.instanceId, ref: picked.draft.ref });
      }
    }
  } catch (error) {
    const message = formatError(error);
    log.error(`manageDrafts: ${message}`);
    await vscode.window.showErrorMessage(t('Could not manage drafts: {message}', { message }));
  }
});
```

  需要 import `buildDraftUri`（`src/document/draftUri.ts`）与 `formatTimestamp`（`src/utils/time.ts`）。
- [ ] 丢弃确认必须 `{ modal: true }`：丢的是用户敲进去的内容，与删实例同级别（参考 `deleteInstanceWithConfirmation` 的先例与注释）。
- [ ] `deleteDraft` 已 fire `FileChangeType.Deleted`——若该草稿 tab 还开着，VS Code 会把它标为已删除，行为可接受，不需额外关 tab 逻辑。
- [ ] **可选（不计入 Done）**：树侧标记——`ConfigTreeItem` 构造时问一下 provider `isDirty`，脏则 `description` 追加 `●` 并 tooltip 说明。做的话 `ConfigTreeProvider` 需要注入 `Pick<NacosDraftFileSystemProvider, 'isDirty'>`；发布/丢弃后靠既有 `refreshTreeViews` 走到重绘。工作量不大但接线多，时间紧就跳过，本命令已满足"可发现"。

### 测试

- [ ] `NacosDraftFileSystemProvider.test.ts`：`listDrafts` 返回全部条目；init 两条改一条后按 dirty 过滤得 1 条。
- [ ] 命令测试（`test/extension/` 下，沿用 `extensionContext.ts` + vscode fixture 的 quick pick 桩）：
  - 无脏草稿 → info 消息，无 quick pick；
  - 有脏草稿 → 列表项 label/description 正确（default 命名空间显示 `public`）；
  - 选 Discard + modal 确认 → `getDraft` 返回 undefined；
  - 选 Discard + 取消 → 草稿仍在；
  - 选 Open → `openTextDocument` 收到正确 draft uri。
- [ ] `Manifest.test.ts`：命令贡献存在、nls 键两份齐全（既有"registers a handler for exactly the commands it contributes"会自动要求 activate 注册，别漏 push subscriptions）。

### 陷阱

- 过滤脏草稿直接比 `content !== baseContent`（与 `isDirty` 同式），别调 `isDirty(target)` 再反查一次 Map——`listDrafts` 已经把 entry 给你了。
- `namespaceId === ''` 显示 `public` 的惯例来自 `diffConfig.ts` 的 `namespaceAddress`，保持一致；不要翻译 `public`（那是 3.x 的字面 id）。
- 打开草稿**不要**走 `openDraftDocument`（它会 `assertWritable` + 可能连服务器 initDraft）；草稿已在内存里，直接 `openTextDocument(uri)` 即可，实例只读与否在发布时再拦。
- 运行时文案记得同步 `l10n/bundle.l10n.zh-cn.json`，否则中文环境露英文。

### Done when

- [ ] 关掉脏草稿 tab 后，命令面板 → "管理未发布草稿" 能找回、能打开、能带确认地丢弃；
- [ ] 全部新测试与 Manifest 断言通过；`npm run typecheck && npm test` 通过。

---

## Task B10 — 面板刷新改 `postMessage`，不再整页重写 `webview.html`（P2）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：四面板整页赋值行号 `ClusterStatusPanel :118/:121/:141`、`ConfigListenersPanel :102/:105/:117`、`ServiceSubscribersPanel :97/:100/:112`、`ConfigHistoryPanel :133/:136/:151` 全部精确一致；共享 bundle 加载点 `:91`/`:86`；`renderClusterStatus` 的 `<main` 在 `:189`；`detailId` 用下标在 `:255`；`escapeAttr` `html.ts:92-99`、CSP `:37`——一致。已修正 1 处：cluster 页面的文档级 click 委托在 `webview/nacos-cluster-status/index.ts:57`（原写 55；元素级刷新按钮监听在 `:44`）。

### 现状

四个面板刷新时都整页赋值 `webview.html`，导致滚动位置、raft 展开态、按钮态全丢：

- `src/webview/ClusterStatusPanel.ts`：`open` 第 118/121 行两次赋值（骨架 → 数据）；`handleClusterStatusMessage` 第 141 行刷新赋值。页面脚本 `webview/nacos-cluster-status/index.ts` 注释自己说 "the extension host answers a refresh by serving the whole document again"。
- `ConfigListenersPanel.ts` 102/105/117、`ServiceSubscribersPanel.ts` 97/100/112、`ConfigHistoryPanel.ts` 133/136/151 同构。
- 安全模型：所有 HTML 在扩展宿主生成，值经 `escapeAttr`（`src/webview/html.ts` 第 92–99 行）转义；页面 CSP `default-src 'none'; script-src cspSource + nonce`（第 37 行）。**本任务保持"宿主生成、页面只贴"**——把已转义的 HTML postMessage 过去（任务规格明确 Prefer 此方案），不搞客户端模板渲染。

### 目标

- 首次打开仍用 `webview.html`（骨架 + 首屏数据两次赋值可保留，或首屏也走 update 消息——保留现状最稳）；
- **刷新**改为 `panel.webview.postMessage({ type: 'update', body })`，页面把 `<main>` 换成新 body，滚动（body 级）不丢，raft 展开态显式保存/恢复；
- 四个面板同一机制；以 ClusterStatusPanel 为样板落全套，其余三个照抄。

### 涉及文件

- `src/webview/ClusterStatusPanel.ts`、`ConfigListenersPanel.ts`、`ServiceSubscribersPanel.ts`、`ConfigHistoryPanel.ts`
- `webview/nacos-cluster-status/index.ts`、`webview/nacos-consumers/index.ts`（listeners 与 subscribers 两个面板**共用**这一个 bundle：`ConfigListenersPanel.ts` 第 91 行与 `ServiceSubscribersPanel.ts` 第 86 行都加载 `dist/webview/nacos-consumers.js`，改一处两面板同时生效）、`webview/nacos-config-history/index.ts`
- `test/webview/*.test.ts`

### 实施步骤（以 ClusterStatusPanel 为样板）

- [ ] 扩展侧：`handleClusterStatusMessage` 改为

```ts
export async function handleClusterStatusMessage(
  message: unknown,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>,
  options: ClusterStatusMessageOptions
): Promise<boolean> {
  if (messageType(message) !== 'refresh') {
    return false;
  }
  // 只送 <main> 的替换体，不再整页重写：整页赋值会把滚动位置、
  // raft 展开态和刷新按钮一起扔掉。body 仍在扩展宿主渲染并已转义，
  // 页面唯一的工作是贴上去——转义责任不迁移。
  const view = await clusterStatusView(options);
  await panel.webview.postMessage({ type: 'update', body: view.body });
  return true;
}
```

  `view.data`（翻译串）首屏已注入且刷新不变，update 消息不带。`ClusterStatusMessageOptions.renderDocument` 保留给首屏。
- [ ] 页面侧 `webview/nacos-cluster-status/index.ts`：
  - 刷新按钮监听改为**文档级事件委托**（`document.addEventListener('click', ...)` 判 `target.closest('#refreshButton')`）——替换 main 后按钮是新元素，绑定在旧元素上的监听会失效（raft 展开的委托已是文档级，第 57 行起，照抄它；现有元素级刷新按钮监听在第 44 行，要改掉）；
  - 增加消息处理：

```ts
window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; body?: string };
  if (message?.type !== 'update' || typeof message.body !== 'string') {
    return;
  }
  const expanded = [...document.querySelectorAll('.node-toggle[aria-expanded="true"]')]
    .map((el) => el.getAttribute('aria-controls'))
    .filter((id): id is string => Boolean(id));
  const main = document.querySelector('main');
  if (!main) {
    return;
  }
  main.outerHTML = message.body; // body 来自扩展宿主，已 escapeAttr 转义
  for (const id of expanded) {
    const detail = document.getElementById(id);
    const toggle = document.querySelector(`.node-toggle[aria-controls="${id}"]`);
    if (detail && toggle) {
      detail.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
    }
  }
  // 恢复刷新按钮文案/可用态（按钮随 body 更新为新元素，天然复位，无需处理）
});
```

  - 按钮"Refreshing..."禁用态：点击时置灰逻辑保留；update 到达即被新按钮替换，自动复位——原注释 "Nothing resets this" 要改写。
- [ ] raft 展开恢复的 id 稳定性：`renderNode` 的 `detailId = node-raft-${index}`（第 255 行）是**下标**不是节点地址——刷新后节点顺序变了会恢复错行。顺手把 detailId 改成基于地址的稳定 id：`node-raft-${escapeAttr(node.address)}` 不行（属性值转义 ≠ 合法 id），用 `encodeURIComponent(node.address)` 或简单哈希；改动集中在 `renderNode`/`renderNodeAddress`/`renderRaftRow` 的传参。
- [ ] 其余三个面板依样画瓢：`handleConfigListenersMessage` / `handleServiceSubscribersMessage` / `handleConfigHistoryMessage` 改 postMessage；对应页面脚本加 message 监听 + 事件委托检查（history 页面的 Diff/Rollback 行按钮若是元素级绑定，一并改委托）。这三个页面没有展开态，只需滚动保持（免费获得）与按钮委托。
- [ ] `ConfigHistoryPanel` 特有：`shown` 数组由 `load()` 更新的机制不变（postMessage 不影响 `messageOptions.load` 闭包）。

### 测试

- [ ] `test/webview/ClusterStatusPanel.test.ts`：fake panel（记录 `webview.html` 赋值次数与 `postMessage` 调用）：
  - `handleClusterStatusMessage({type:'refresh'}, ...)` → `postMessage` 被调 1 次、payload `type === 'update'`、`body` 含 `<main` 与节点表格；`webview.html` **未被再次赋值**；
  - 非 refresh 消息 → 返回 false、无 postMessage。
  - fake panel 需要 `webview.postMessage` 桩：确认 `test-fixtures/vscode.ts` 的 webview 对象有没有，没有则补（async 返回 true 并记录参数）。
- [ ] 其余三个面板测试同构改写（现有"html 被重新赋值"类断言反向改为"postMessage"）。
- [ ] 页面脚本无单测基建（esbuild IIFE，无 DOM 测试环境）——**不为它引入 jsdom**；以扩展侧断言 + 手测覆盖，PR 描述附手测记录（见 Done）。

### 陷阱

- `main.outerHTML = body` 要求 body 恰是一个 `<main>...</main>` 根元素——`renderClusterStatus` 的 body 正是（第 189 行）；其他面板确认各自 body 根元素后再选 outerHTML/innerHTML 方案。
- **转义责任不迁移**：body 必须继续由扩展侧 render 函数产出，页面绝不能拼 HTML。update 消息里不要传原始数据字段，防止后人顺手在页面里 `${}` 拼接。
- CSP 不需要放宽：innerHTML 注入的 `<script>` 不会执行（HTML5 规范）+ nonce CSP 双保险，但仍不要在 body 里出现 script 标签。
- 首屏两次 `webview.html` 赋值（骨架→数据）保留：panel 可见前的赋值没有状态可丢。
- `postMessage` 在 panel 已 dispose 时返回 false/抛错——handle 函数在 await load 期间用户可能关面板；用 `try { await panel.webview.postMessage(...) } catch { /* panel 已关 */ }` 或忽略返回值即可，不要让它冒泡成错误通知。

### Done when

- [ ] 四面板点 Refresh：滚动位置保持、（cluster）已展开的 raft 行保持展开、无整页闪白；
- [ ] 扩展侧测试断言 refresh 不再赋值 `webview.html`；
- [ ] 手测记录：一个 ≥3 节点或长列表实例上滚动到底 → Refresh → 位置不变；
- [ ] `npm run typecheck && npm test && npm run build` 通过（页面脚本改动要过 esbuild）。

---

## Task B11 — GitHub Actions：typecheck + vitest；可选每周 live 容器（P2）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：仓库确无 `.github/` 目录；`describeLive` 门控在 `liveServer.test.ts:51`、`LIVE_BROWSE_TIMEOUT_MS = 60_000` 在 `:58`；`package-lock.json` 存在；scripts 见 `package.json:395-402`（`build` 确实先跑 `scripts/copy-hub.mjs`）——全部一致。

### 现状

- 仓库**没有 `.github/` 目录**（`ls -a` 验证过），零 CI。
- 测试基线：`npm run typecheck`（tsc --noEmit）、`npm test`（vitest run，约 1980 例）；live 组 `test/live/liveServer.test.ts` 用 `const describeLive = liveUrl ? describe : describe.skip`（第 51 行）门控，未设 `AT_NACOS_LIVE_URL` 时整组 skip（roadmap 口径 33 例），可选 `AT_NACOS_LIVE_USERNAME` / `AT_NACOS_LIVE_PASSWORD`。**不需要任何 secrets**：live 用的 nacos 容器在 CI 内起、默认无鉴权。
- `package-lock.json` 存在 → 用 `npm ci`；本地 Node 22 可跑，工作流用 Node 20（LTS，`@types/node` ^20 对齐）。

### 涉及文件

- 新建 `.github/workflows/ci.yml`
- 新建 `.github/workflows/live.yml`（可选项，做）

### 实施步骤

- [ ] `.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

  `npm run build` 放最后：它跑 `scripts/copy-hub.mjs` + esbuild，能拦住"只过 tsc 但打包挂"的一类回归（如 B10 改页面脚本）。
- [ ] `.github/workflows/live.yml`：

```yaml
name: Live Nacos smoke

on:
  schedule:
    - cron: '17 3 * * 1'   # 每周一 03:17 UTC，避开整点高峰
  workflow_dispatch:

jobs:
  live:
    runs-on: ubuntu-latest
    services:
      nacos:
        image: nacos/nacos-server:v2.3.2
        env:
          MODE: standalone
        ports:
          - 8848:8848
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Wait for Nacos readiness
        run: |
          for i in $(seq 1 60); do
            if curl -fsS http://localhost:8848/nacos/v1/console/health/readiness > /dev/null; then
              echo "nacos ready after ${i}s"; exit 0
            fi
            sleep 1
          done
          echo "nacos did not become ready in 60s"; exit 1
      - name: Run live suite
        env:
          AT_NACOS_LIVE_URL: http://localhost:8848/nacos
        run: npx vitest run test/live
```

  镜像钉 `v2.3.2`：这是代码注释里反复出现的"verified on a real 2.3.2"的版本，让 CI 验证的正是研究基线。**不配置任何 secrets**（standalone 默认 `nacos.core.auth.enabled=false`，匿名可读写）。
- [ ] live 工作流**不设为分支保护必需检查**（它验证的是外部假设，不是本仓库的每次变更），在 PR 描述里写明这一意图，让维护者在 repo 设置里只把 `CI / test` 设为 required。

### 测试 / 验证

- [ ] 本地先干跑等价命令确认全绿：`npm ci && npm run typecheck && npm test && npm run build`；
- [ ] 本地容器彩排 live 流程（有 docker 时）：`docker run -d --rm -p 8848:8848 -e MODE=standalone nacos/nacos-server:v2.3.2`，readiness 探测通过后 `AT_NACOS_LIVE_URL=http://localhost:8848/nacos npx vitest run test/live`，记录通过/失败数进 PR；没有 docker 环境就注明未彩排、依赖首次 workflow_dispatch 验证；
- [ ] 推分支后用 `gh run list` / `gh run view --log` 确认 ci.yml 首跑绿（live.yml 用 workflow_dispatch 手动触发一次验证）。

### 陷阱

- readiness 探测必须打 `/nacos/v1/console/health/readiness`（带 context path）；探 `/` 会在 Nacos 起 Tomcat 但未完成初始化时误判就绪，live 首个用例超时。
- vitest 默认单文件 5s 超时，live 文件自带 `LIVE_BROWSE_TIMEOUT_MS = 60_000` 的 per-test 超时（第 58 行），不需要全局改；但 job 层给 `timeout-minutes: 15` 防挂死（可加在 live job 上）。
- schedule 触发的 workflow 在 fork 上不会跑、在长期无 commit 的仓库会被 GitHub 自动停用——正常现象，写进 workflow 顶部注释。
- 不要在 ci.yml 里加 l10n 重复键检查——那是 roadmap A2 的验收物，别越界。

### Done when

- [ ] PR 分支上 `CI / test` 绿；`workflow_dispatch` 触发的 live 跑通（或明确记录失败原因是环境而非工作流本身）；
- [ ] 两个 yml 均不引用任何 `secrets.*`。

---

## Task B12 — VS Code 原生 MCP 安装：上游缺口如实处理（P2）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`resolveMcpInstallerTarget` `McpConfigInstaller.ts:24-38`（`vscode` 确落 `return undefined`）；`McpInstallerTarget` 无 `'vscode'`（`node_modules/@at-series/mcp-hub/dist/installer/index.d.ts:7`）；`HostApp` 含 `'vscode'`（`dist/protocol/index.d.ts:54`）；`jsonConfigFile.d.ts` 的 `withMcpConfigLock`/`readJsonConfigDocument`/`writeJsonConfigDocument`（`:34`/`:35`/`:42`）齐全——全部一致。

### 现状（读代码 + 依赖包得出）

- `src/mcp/McpConfigInstaller.ts` 的 `resolveMcpInstallerTarget`（第 24–38 行）：只映射 `kiro` / `continue`（需 workspaceFolder）/ `cursor`，**`hostApp === 'vscode'` 落到 `return undefined`** → `ensureAtSeriesConfigForCurrentIde` 返回 `undefined`，即"此 IDE 不支持"。
- 上游 `@at-series/mcp-hub@^0.3.2`（本仓库 dependencies）：`dist/installer/index.d.ts` 第 7 行 `export type McpInstallerTarget = 'cursor' | 'kiro' | 'continue';` —— **类型层面就没有 vscode**，插件侧无法"传个 'vscode' 试试"。`HostApp` 联合类型倒是含 `'vscode'`（`dist/protocol/index.d.ts` 第 54 行），检测没问题，缺的是写入器。
- Cursor 写入器（`dist/installer/cursor.d.ts`）写 `~/.cursor/mcp.json`，文档形状是 **`mcpServers`** map。而 VS Code 1.102+ 的原生 MCP 用户配置文件是**用户目录下的 `mcp.json`**（Linux `~/.config/Code/User/mcp.json`，macOS `~/Library/Application Support/Code/User/mcp.json`，Windows `%APPDATA%\Code\User\mcp.json`；Insiders 目录名 `Code - Insiders`），顶层键是 **`servers`**（可带 `inputs`），条目形如 `{ "type": "stdio", "command": "node", "args": [...] }`——**与 Cursor 的 `mcpServers` 形状不同，不能复用 `ensureJsonIdeMcpConfig` 直写**。
- Phase 0（提交 593e68d）已把 install/uninstall 的用户反馈改成诚实三态（installed / already up to date / **not supported on this IDE**）。**本任务的底线：在上游发布 vscode target 之前，VS Code 宿主上继续走"不支持"分支，绝不谎报成功。**

### 目标

1. 写清并向上游提交 `@at-series/mcp-hub` 的 `'vscode'` target 规格（本仓库交付物是一份 issue 级规格文档 + 本地对接改动的准备）；
2. 插件侧准备好"一行接入"：上游发版后只需改 `resolveMcpInstallerTarget` 一行 + bump 依赖；
3. 在上游就绪前，确保 VS Code 宿主上的 `atNacos.installMcpConfig` / `uninstallMcpConfig` 明确提示"当前 IDE 暂不支持自动安装"，并给出手动配置指引。

### 涉及文件

- 新建 `docs/plans/2026-08-27-mcp-hub-vscode-target-spec.md`（上游规格，见步骤 1）
- `src/mcp/McpConfigInstaller.ts`（注释 + TODO 标记；上游就绪后的一行改动）
- `src/extension.ts`（"不支持"分支的提示文案补手动指引——仅当 Phase 0 现状文案没有指引时）
- `test/mcp/McpConfigInstaller.test.ts`

### 实施步骤

- [ ] **步骤 1：上游规格文档**。新建 `docs/plans/2026-08-27-mcp-hub-vscode-target-spec.md`，内容必须包含：
  - `McpInstallerTarget` 增加 `'vscode'`；
  - 新写入器 `ensureVsCodeMcpConfig` / `uninstallVsCodeMcpConfig`：路径解析按平台 + 变体（Code / Code - Insiders / VSCodium 的 `~/.config/VSCodium/User/mcp.json`）——第一版可只支持 stable Code 并显式返回 not-supported 给其它变体；
  - 文档形状差异：顶层 `servers`（不是 `mcpServers`）、条目 `{ "type": "stdio", "command": ..., "args": [...] }`；AT Series 条目名沿用现有 `AT Series`；
  - 复用 `jsonConfigFile.ts` 的 `withMcpConfigLock` / `readJsonConfigDocument` / `writeJsonConfigDocument`（备份、锁、格式保持全都现成，只有根键名与条目形状不同）；
  - 卸载语义与 cursor 版对齐：只删 `AT Series` 条目，不碰第三方 server 与 hub.js。
  - 规格文档结尾注明：提交方式取决于 mcp-hub 仓库归属（同组织内部包），由维护者转 issue/PR。
- [ ] **步骤 2：插件侧一行准备**。`resolveMcpInstallerTarget` 里加带 TODO 的显式分支（行为不变，意图入码）：

```ts
if (hostApp === 'vscode') {
  // VS Code 1.102+ 有用户级 mcp.json（顶层键 `servers`，与 Cursor 的
  // `mcpServers` 形状不同），但 @at-series/mcp-hub@0.3.x 的
  // McpInstallerTarget 尚无 'vscode' 写入器。上游规格见
  // docs/plans/2026-08-27-mcp-hub-vscode-target-spec.md。
  // 上游发版后这里改为 `return 'vscode';` 并 bump 依赖。
  return undefined;
}
```

- [ ] **步骤 3：检查上游是否已发版**。`npm view @at-series/mcp-hub versions` 查最新版本，翻其 CHANGELOG 是否已含 vscode target：
  - **已发版**：bump `package.json` 依赖、`npm install`、把步骤 2 的分支改成 `return 'vscode';`、跑通步骤 4 的全部测试——这才是完整交付；
  - **未发版**（预期情形）：交付止于步骤 1+2+4 的"不支持"侧测试。**禁止**在插件侧自己实现一个绕开 hub 的 VS Code 写入器（三个 AT 插件共享同一份 config 的锁与迁移逻辑全在 hub 里，旁路写入会破坏 `withMcpConfigLock` 的互斥假设）。
- [ ] **步骤 4：诚实提示核对**。在 vscode 宿主（`detectHostApp` 返回 'vscode'）下手测/单测 `atNacos.installMcpConfig`：Phase 0 的三态消息里"不支持"分支要说清"当前 IDE 暂不支持自动安装 MCP 配置"，若文案只是笼统失败，补一条含指引的 info 消息（指引写：VS Code 可手动在用户 `mcp.json` 的 `servers` 里添加 stdio 条目指向 `~/.at-series/hub/hub.js`——文案进 l10n 两份）。
- [ ] **备选路线记录（不实现）**：在规格文档"Alternatives"一节记录 `vscode.lm.registerMcpServerDefinitionProvider`（VS Code 1.101+ 稳定 API，配 `contributes.mcpServerDefinitionProviders`）可以完全绕开 mcp.json 文件写入；不选它的原因：本扩展 engines 为 ^1.85、AT Series 三插件统一走 Hub 单条目架构、且 provider 方式无法覆盖用户在别的 IDE 里也要用的场景。留给上游权衡。

### 测试

- [ ] `test/mcp/McpConfigInstaller.test.ts`：
  - `resolveMcpInstallerTarget('vscode', undefined)` 与 `('vscode', '/ws')` 均返回 `undefined`（上游未就绪时锁死现状；上游就绪后此断言改为 `'vscode'`）；
  - `ensureAtSeriesConfigForCurrentIde({ appName: 'Visual Studio Code', ... })` 返回 `undefined` 且**不写任何文件**（用临时 home 断言无 `mcp.json` 产生）；
  - 既有 cursor/kiro/continue 用例不回归。
- [ ] 命令层：vscode 宿主下 `installMcpConfig` 弹的是"不支持/指引"信息，**绝不是** "installed successfully"（在 `test/extension/McpConfigCommands.test.ts`——Phase 0 新增的文件——补一例）。

### 陷阱

- **不要 fake success**：最坏的实现是"检测到 vscode 就自己往 `~/.config/Code/User/mcp.json` 塞 `mcpServers`"——键名就是错的（VS Code 读 `servers`），文件还绕开了 hub 的锁与备份。规格里已两处禁止，评审时重点盯。
- `detectHostApp` 对 VS Code 衍生发行版（VSCodium 等）可能返回非 'vscode' 的 slug——本任务只处理 `'vscode'` 字面值，衍生版留给上游路径解析章节。
- 上游 bump 时注意 `hubSync.ts` 打包的 hub.js 版本要同步（`scripts/copy-hub.mjs` 从 node_modules 拷贝），`npm run build` 必跑。

### Done when

- [ ] 上游规格文档落盘且内容覆盖步骤 1 全部要点；
- [ ] `resolveMcpInstallerTarget` 的 vscode 分支显式化、注释指向规格文档；
- [ ] vscode 宿主上 install/uninstall 全链路"诚实不支持"，测试锁定；
- [ ] （若上游已发版）一行接入 + 依赖 bump + 写入路径端到端测试通过；
- [ ] `npm run typecheck && npm test` 通过。

---

## 可选后续（记录，不属于 Phase B 交付）

- **B4 扩展**：provider 缓存 promise 化以去重并发读取（参照 `NacosClientPool` 失败自清模式）。
- **B9 扩展**：草稿持久化到 `context.globalState` 或 workspace storage（窗口重载不丢）；树节点脏标记（`●`）。
- **B10 扩展**：`webview.setState`/`getState` 支持面板被藏后恢复（retainContextWhenHidden 的替代）。
- **B11 扩展**：live 矩阵加 nacos-server v1.4.x 与 3.x 镜像（3.x 需另开 console 端口 8080 与鉴权环境变量，工作量另计）。

## 任务间依赖速查

| 任务 | 依赖 | 被依赖 |
|---|---|---|
| B1 | Phase 0（extension.ts 结构） | B6（设置监听清 agent 池） |
| B2 | 无 | 无 |
| B3 | 无 | 无 |
| B4 | Phase 0（池摊平 login） | 无 |
| B5 | 无 | 无 |
| B6 | Phase 0（certVerifier 透传，ae986f6） | 无（与 B1 有一行交集，后合者补） |
| B7 | 无（但改动面大，建议最后独立合） | 无 |
| B8 | Phase 0（Promise.all 版 getClusterNodes） | 无 |
| B9 | Phase 0（保存≠发布 + closeDocumentListener 现行为） | 无 |
| B10 | 无 | 无 |
| B11 | 无（但建议在 B2/B3/B5 后合入以覆盖新测试） | 无 |
| B12 | Phase 0（诚实三态提示，593e68d） | 无 |
