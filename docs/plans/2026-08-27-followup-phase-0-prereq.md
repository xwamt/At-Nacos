# AT Nacos 后续 —— Phase 0：1–8 优化批次（前置）

> **For agentic workers:** 按任务顺序 TDD。每步 checkbox。完成一项勾一项。不要跳步。不要在 main 上改。

**Goal:** 在进入后续 A/B/C/D 里程碑之前，先落地 8 项体验/性能优化：写路径不再清空整个客户端池、Ctrl+S 与发布解耦、实例表单在隐藏后保留输入、新建配置入口、README 诚实化 + MCP 卸载命令、实例节点右键菜单、服务树按名过滤、MCP 集群查询并行化 + 非交互证书校验。
**Depends on:** none（当前 origin/main 可能尚未包含这些改动）
**Skip if:** 下列命令已存在则整份 Phase 0 可跳过：`atNacos.createConfig`、`atNacos.filterServices`、`atNacos.uninstallMcpConfig`、`atNacos.editInstance`（查 package.json）。若部分存在，只做缺失项。
**Non-goals:** 不要做后续 A/B/C/D。

---

## 快捷路径：优先合入已有分支

**先检查再动手：** `git ls-remote origin cursor/nacos-opt-1-8-6a9b`。若该分支存在于 origin，它已经包含本文全部 8 项的完成实现（提交 `f46fea4`、`27bc67f`、`6cbe99c`、`a5701da`、`eccc002`、`593e68d`、`2bb58ff`、`3f70dea`、`ae986f6`，合并后约 1980 单测通过）。**优先 merge 或 cherry-pick 该分支，而不是照本文重写**——合入后跑 `npm test && npm run typecheck` 全绿即可直接跳到 Phase A。仅当该分支不存在、无法合入或只缺部分项时，才按下文逐项实现（每项也可以从对应的单项分支 `cursor/opt-*-6a9b` cherry-pick）。

## 执行须知（全部任务通用）

- 工作分支：从当前基线切出 `cursor/<descriptive-name>` 特性分支；**绝不在 main 上改**。
- TDD：每个任务先写（或先改）测试并确认失败，再写实现，再确认通过。
- 每完成一个任务：`npm test` + `npm run typecheck` 必须全绿，然后 commit。
- 8 个任务相互独立，可按任意顺序做；本文顺序（1→8）是推荐顺序。**任务 1 与任务 2 都改 `src/extension.ts` 的 `saveDocumentListener` 周边，任务 1、5、6 都改 `deleteInstanceWithConfirmation`/命令注册区**，先后做时留意合并点（各任务的 Pitfalls 里有具体说明）。
- 本文所有行号引用针对当前 origin/main（与本 checkout 一致）。

### ExtensionLifecycle 订阅数与命令数的记账规则（新增命令时必须同步改）

`test/extension/ExtensionLifecycle.test.ts` 有两处会因新增命令而失败，每个新增命令的任务都要按此更新：

1. **第 36–58 行**：`registers the instance, refresh, ...` 用**完整排序数组**断言全部已注册命令 id。新增命令必须按字母序插入该数组。
2. **第 76–88 行**：`hands every disposable it created to context.subscriptions` 断言 `context.subscriptions` 长度。main 上当前是 **30**（注释写着 "the twenty-one commands"：1 个 logChannel + 21 个命令 + 2 个 view + 2 个 provider + 2 个 registration + 2 个 document listener）。**每注册并 push 一个新命令，长度 +1，且要同步改注释里的英文数字**。

| 任务 | 新增命令 | 命令数累计 | subscriptions 累计 |
|---|---|---|---|
| （main 基线） | — | 21 | 30 |
| 任务 4 | `atNacos.createConfig` | 22 | 31 |
| 任务 5 | `atNacos.uninstallMcpConfig` | 23 | 32 |
| 任务 6 | `atNacos.editInstance`、`atNacos.deleteInstance` | 25 | 34 |
| 任务 7 | `atNacos.filterServices`、`atNacos.clearServiceFilter` | 27 | 36 |

若单独做某一任务，就在当时的基数上 +N；8 项全做完的终态为 **27 个命令 / 36 个 subscriptions**（与 `origin/cursor/nacos-opt-1-8-6a9b` 一致，注释为 "the twenty-seven commands"）。

另外 `test/extension/Manifest.test.ts` 第 133–154 行维护着 **commandPalette `when: "false"` 的 it.each 清单**；凡是"只能由树节点带参调用"的新命令都必须同时加进 package.json 的 `menus.commandPalette`（`"when": "false"`）和这份清单，否则 `writes no commandPalette entry that leaves a command visible`（第 157–161 行）与 `registers a handler for exactly the commands it contributes`（第 54–64 行）会失败。

---

## Task 1 写路径不再 `clientPool.clear()`

### Why

`src/extension.ts` 第 178–182 行的 `refreshTreeViews()` 在**每次写操作成功后**执行 `clientPool.clear()` 并重绘两棵树。可写操作刚刚成功本身就证明缓存客户端可用（服务端刚接受了它的 JWT、刚答复了探测过的端点），清池等于把写操作刚验证过的状态扔掉，让下一次树读取重新付一次 login + `/state` 探测；同时发布/删除配置根本改不了服务树，却也把它的缓存整个丢掉。`NacosClientPool.evict(instanceId)` 已存在（`src/nacos/NacosClientPool.ts` 第 65–67 行），实例级失效无需新 API。

### Files

- `src/extension.ts`
- `test/extension/WriteCommands.test.ts`

### Current code behavior（已读源码）

- `src/extension.ts:178-182`：`refreshTreeViews()` = `clientPool.clear()` + `configTreeProvider.refresh()` + `serviceTreeProvider.refresh()`。
- 调用点（全部走同一个函数）：表单保存回调（第 202 行，经 `NacosInstanceFormPanel.open` 的 `onSaved`）、`manageInstances`（第 275 行，删除实例后）、`onRollback`（第 491 行）、`onPublished`（命令路径第 645 行、保存监听器路径第 689 行——注意任务 2 会移除后者）、`onDeleted`（第 732 行）、`onUpdated`（第 758、785 行）。
- 显式刷新命令 `atNacos.refreshConfigs` / `atNacos.refreshServices`（第 294–301 行）各自已经 `clientPool.clear()` + 只刷新自己的树——这两处**保持不变**。
- `src/nacos/NacosClientPool.ts`：池以 `instance.id` 为 key，`instanceFingerprint`（第 15–24 行）含 `updatedAt`，因此实例被**编辑**后旧缓存本会因指纹不同而失效；但**删除**的实例不再有下一次 `getClient` 调用，不 evict 就会留着一个活 token。
- `deleteInstanceWithConfirmation`（第 968–983 行）目前收 `onChanged: () => void`，不带 id。

### Implementation steps

- [ ] 在 `test/extension/WriteCommands.test.ts` 末尾新增 `describe('client pool survival across writes', ...)`（写在最外层 describe 内），先让它失败：
  - import `NacosClientPool`（`../../src/nacos/NacosClientPool`）、`rollbackModule`（`../../src/write/rollbackConfig`）、`ConfigHistoryPanel`（`../../src/webview/ConfigHistoryPanel`）。
  - 辅助函数 `observeTreeChanges()`：对 `fixtureWindow.__getTreeViews()` 的两个 provider 各挂一个 `vi.fn()` 到 `onDidChangeTreeData`，按视图顺序返回 `{ configChanged, serviceChanged }`（index 0 = configs，1 = services）。
- [ ] 在 `src/extension.ts` 中删除 `refreshTreeViews`，替换为三个函数（放在两个 provider 构造之后、原位置）：
  ```ts
  const refreshAfterConfigWrite = (): void => { configTreeProvider.refresh(); };
  const refreshAfterServiceWrite = (): void => { serviceTreeProvider.refresh(); };
  const refreshAfterInstanceChange = (instanceId?: string): void => {
    if (instanceId !== undefined) { clientPool.evict(instanceId); }
    configTreeProvider.refresh();
    serviceTreeProvider.refresh();
  };
  ```
  （新实例还没有缓存客户端，因此新增实例时不传 id。）
- [ ] 逐个改调用点：
  - `openInstanceForm`（第 201 行）：`NacosInstanceFormPanel.open(context, configManager, () => refreshAfterInstanceChange(existing?.id), existing, {...})`。
  - `manageInstances` 调用（第 275 行）改传 `refreshAfterInstanceChange`；`manageInstances` 的第三参签名改为 `onDeleted: (instanceId: string) => void`；`deleteInstanceWithConfirmation` 第三参改为 `onDeleted: (instanceId: string) => void`，确认后调用 `onDeleted(instance.id)`。
  - `onRollback: () => refreshAfterConfigWrite()`（第 491 行）。
  - `onPublished: () => refreshAfterConfigWrite()`（第 645 行；第 689 行的保存监听器若任务 2 尚未做，也同样改——任务 2 会整体删掉那段）。
  - `onDeleted: () => refreshAfterConfigWrite()`（第 732 行）。
  - `onUpdated: () => refreshAfterServiceWrite()`（第 758、785 行）。
- [ ] 确认 `atNacos.refreshConfigs` / `atNacos.refreshServices`（第 294–301 行）原样保留 `clientPool.clear()`。
- [ ] 跑测试至全绿。

### Tests

`test/extension/WriteCommands.test.ts` 新 describe 内（做法：spy 对应 write 模块并在 mockImplementation 里调用回调，spy `NacosClientPool.prototype.clear`）：

- `keeps the pool and redraws only the config tree when a publish lands`：mock `publishConfig` 调 `options.onPublished?.()`；断言 `clearSpy` 未被调、`configChanged` 1 次、`serviceChanged` 0 次。
- `keeps the pool and redraws only the config tree when a delete lands`：同上，`deleteConfig`/`onDeleted`。
- `keeps the pool and redraws only the config tree when a rollback lands`：mock `ConfigHistoryPanel.open`，从 `open.mock.calls[0]?.[1]?.rollback?.({ id: '1044', opType: 'U' } as never)` 触发；mock `rollbackConfig` 调 `options.onRollback?.()`。
- `it.each(['atNacos.enableServiceInstance','atNacos.disableServiceInstance'])`：mock `toggleServiceInstanceEnabled` 调 `options.onUpdated?.()`；断言只有 `serviceChanged` 1 次、pool 未清。
- `it.each(['atNacos.refreshConfigs','atNacos.refreshServices'])`：显式刷新命令仍 `clearSpy` 恰好 1 次。

### i18n

无新增用户可见文案；不改 `l10n/bundle.l10n.zh-cn.json`、`package.nls*.json`。

### Pitfalls

- **池 key 是 `instance.id`**，指纹含 `updatedAt`：编辑实例即便不 evict 也会因指纹变更而重建客户端，但删除实例必须 evict，否则已删实例的登录 token 留在内存里。
- `test/extension/InstanceCommands.test.ts` 第 173–188 行 `redraws both trees after a delete` 依赖"删除实例 → 两棵树各 fire 1 次"，`refreshAfterInstanceChange` 保持了该行为，别改成单树。
- 与任务 2 的合并点：main 上 `saveDocumentListener`（第 660–703 行）也调 `refreshTreeViews`。若任务 1 先做，把它临时改成 `refreshAfterConfigWrite()`；任务 2 会删除整段发布逻辑。
- 与任务 6 的合并点：任务 6 的 `deleteInstanceCommand` 若后做，回调应传 `refreshAfterInstanceChange`（不是已删除的 `refreshTreeViews`）。
- 不新增命令：subscriptions 数量保持 30，`ExtensionLifecycle.test.ts` 不动。

### Done when

- [ ] 任何 `onPublished`/`onDeleted`/`onRollback`/`onUpdated` 回调都不触发 `clientPool.clear()`。
- [ ] 配置写只重绘配置树；实例上下线只重绘服务树；实例增/改/删 evict 对应 id 并重绘两棵树。
- [ ] 两个显式 Refresh 命令仍然 `clear()`。
- [ ] 新增 6 个测试 + 既有测试全部通过；`npm run typecheck` 通过。

---

## Task 2 Ctrl+S 只保存草稿，不再触发发布

### Why

main 上 `onDidSaveTextDocument` 监听器对脏草稿直接走 `publishConfig`（弹 diff + 模态确认）。这违背了 `NacosDraftFileSystemProvider` 自己写下的契约（`src/document/NacosDraftFileSystemProvider.ts` 第 29–31 行："Save does not equal publish"）：习惯性 Ctrl+S 的用户每次都被弹窗打断，且草稿在事件触发前已经通过内存 `writeFile` 持久化，监听器里没有任何还需要做的事。改为状态栏提示（不弹通知，免得每次保存都要点掉一个气泡），发布仍然只走显式 `atNacos.publishConfig`（编辑器标题按钮、树右键、命令面板三个入口都不变）。

### Files

- `src/extension.ts`
- `test-fixtures/vscode.ts`
- `test/extension/WriteCommands.test.ts`
- `l10n/bundle.l10n.zh-cn.json`

### Current code behavior（已读源码）

- `src/extension.ts:658-703`：`inFlightPublish` Set + async `saveDocumentListener`——scheme 判断、`parseDraftUri`、`isDirty` 三重守卫之后，读回实例并调用 `publishConfig({... onPublished: () => refreshTreeViews()})`，出错走 `showErrorMessage`。
- `src/extension.ts:705-716`：`closeDocumentListener` 关闭干净草稿时 `deleteDraft`——**保留不动**。
- `test/extension/WriteCommands.test.ts:163-201`：`triggers publishConfig when a dirty draft document is saved` 断言保存会发布（要反转）；第 203–225 行断言干净保存不发布（保留并加一条断言）。
- `test-fixtures/vscode.ts` 的 `window` 有 `createStatusBarItem` 但**没有 `setStatusBarMessage`**，需要补 fixture。

### Implementation steps

- [ ] 先改测试（见下），确认失败。
- [ ] `test-fixtures/vscode.ts`：在 `window` 对象里新增：
  ```ts
  setStatusBarMessage: (text: string, _hideAfterTimeout?: number) => { statusBarMessages.push(text); return { dispose: () => undefined }; },
  __getStatusBarMessages: (): string[] => statusBarMessages,
  __clearStatusBarMessages: (): void => { statusBarMessages.length = 0; },
  ```
  以及模块级 `const statusBarMessages: string[] = [];`。
- [ ] `src/extension.ts`：删除 `inFlightPublish` Set；`saveDocumentListener` 改为**同步**回调，保留三重守卫（scheme ≠ `NACOS_DRAFT_SCHEME` 返回、`parseDraftUri` 失败返回、`!isDirty` 返回），守卫之后只做：
  ```ts
  vscode.window.setStatusBarMessage(
    t('Draft saved locally. Run "Publish" to send {dataId} to Nacos.', { dataId: target.ref.dataId }),
    5000
  );
  ```
- [ ] `saveDocumentListener` 仍然 push 进 `context.subscriptions`（第 878 行），`closeDocumentListener` 一字不改。
- [ ] 跑测试至全绿。

### Tests

`test/extension/WriteCommands.test.ts`：

- `beforeEach` 增加 `fixtureWindow.__clearStatusBarMessages();`。
- 把 `triggers publishConfig when a dirty draft document is saved` 改名为 `does not trigger publishConfig when a dirty draft document is saved`，删掉 `getInstance` 的 mock，末尾断言 `expect(publishSpy).not.toHaveBeenCalled()`。
- 新增 `shows a status bar hint instead of publishing when a dirty draft is saved`：initDraft → writeFile 弄脏 → `__fireDidSaveTextDocument` → 等一个 tick → 断言 `publishSpy` 未调、`__getStatusBarMessages()` 长度 1 且 `[0]` 包含 `'app.yaml'`。
- `does not trigger publishConfig when a clean draft document is saved` 追加断言 `expect(fixtureWindow.__getStatusBarMessages()).toHaveLength(0)`（干净保存连提示都不给）。
- `cleans up draft entry when a clean draft document is closed` 保持原样并必须继续通过（closeDocumentListener 未动的回归证明）。

### i18n

- `t()` 新 key（英文源串，注意内嵌双引号）：`Draft saved locally. Run "Publish" to send {dataId} to Nacos.`
- `l10n/bundle.l10n.zh-cn.json` 新条目：
  ```json
  "Draft saved locally. Run \"Publish\" to send {dataId} to Nacos.": "草稿已保存在本地。执行「发布」后 {dataId} 才会推送到 Nacos。"
  ```
- 无新命令，`package.nls*.json` 不动。

### Pitfalls

- `test/i18n/nls.test.ts` 会扫描 `src/**` 里所有 `t('...')` 字面量并要求 zh-cn bundle 有对应 key——源串里的双引号在单引号字面量里不转义，bundle 的 JSON key 里要写 `\"`，占位符 `{dataId}` 两边都必须保留（`keeps every placeholder ... ` 测试）。
- **不要**把 `saveDocumentListener` 从 `context.subscriptions` 里拿掉：监听器还在（只是变轻了），subscriptions 数保持 30；删掉会让 `hands every disposable...` 从 30 变 29 而失败，且监听器泄漏到下一次激活。
- 与任务 1 的合并点：本任务删除的代码块里有一处 `refreshTreeViews()` 调用；两个任务都做时以"整块删除"为准。
- 状态栏提示用 `setStatusBarMessage`（自带超时销毁），不要用 `createStatusBarItem`（需要手动管理生命周期与 dispose）。

### Done when

- [ ] 保存脏草稿：0 次网络请求、0 次 `publishConfig`、1 条含 dataId 的状态栏提示。
- [ ] 保存干净草稿：无发布、无提示。
- [ ] 发布仍可经 `atNacos.publishConfig`（树节点参数与活动编辑器 `nacos-draft:` URI 两条路径，`WriteCommands.test.ts` 既有用例回归通过）。
- [ ] `npm test` + `npm run typecheck` 全绿。

---

## Task 3 实例表单：`retainContextWhenHidden` + webview `setState`

### Why

实例表单 webview 未设 `retainContextWhenHidden`，用户填了一半（含密码）切去别的标签页再回来，页面被 VS Code 销毁重建，所有未保存输入清空。修法分两层：`retainContextWhenHidden: true` 让隐藏标签页不销毁；页面同时把每次编辑镜像进 webview 自己的 `setState`（覆盖该标志防不住的重建场景，例如插件宿主重启）。状态只存于 webview（随 panel 销毁而消失），密码绝不进插件的 `globalState`。

### Files

- `src/webview/NacosInstanceFormPanel.ts`
- `webview/nacos-instance-form/index.ts`
- `webview/nacos-instance-form/state.ts`（新建）
- `test/webview/NacosInstanceFormPanel.test.ts`

### Current code behavior（已读源码）

- `src/webview/NacosInstanceFormPanel.ts:105-110`：`createWebviewPanel(..., { enableScripts: true, localResourceRoots: [context.extensionUri] })`——无 `retainContextWhenHidden`。
- `webview/nacos-instance-form/index.ts`：`acquireVsCodeApi()` 的类型只声明了 `postMessage`（第 8 行）；`payloadFromForm()`（第 74–86 行）已经产出全字段对象（7 个 string + 2 个 boolean）；`fillConsoleUrl`（第 126–131 行）由脚本写入字段、不会触发 input 事件；文件尾 `export {}`。
- 该页面脚本一加载就摸 `document`，Node 测试进程 import 不了——所以状态校验逻辑必须拆进独立的 DOM-free 模块。

### Implementation steps

- [ ] 新建 `webview/nacos-instance-form/state.ts`：
  - `export interface SavedInstanceFormState { label; serverUrl; consoleUrl; authMode; username; password; customHeaders: string; readOnly; allowBackgroundAccess: boolean }`（前 7 个 string，后 2 个 boolean）。
  - `export function readSavedInstanceFormState(value: unknown): SavedInstanceFormState | undefined`：非对象/null → undefined；用 `STRING_FIELDS`/`BOOLEAN_FIELDS` 两个 as const 数组逐字段 typeof 校验，**全有才收，缺一即弃**（半个表单不还原；`undefined` 是首次打开的正常答案）。
- [ ] `webview/nacos-instance-form/index.ts`：
  - `VsCodeApi` 类型加 `getState(): unknown; setState(state: unknown): void;`；顶部 `import { readSavedInstanceFormState } from './state';`。
  - 新增 `writeValue(name, value)`（对称于 `readValue`）与 `setChecked(name, checked)`（对称于 `isChecked`）。
  - `function persistFormState(): void { vscode.setState(payloadFromForm()); }`。
  - `function restoreFormState(): void`：`readSavedInstanceFormState(vscode.getState())`，undefined 直接 return（HTML 已渲染默认值与 `existing` 值）；否则逐字段 `writeValue`/`setChecked` 写回 9 个字段，最后 `applyAuthMode(saved.authMode)`（恢复的模式决定显示哪组凭据字段，等价于 select 的 change 事件）。
  - 挂监听：`form?.addEventListener('input', persistFormState); form?.addEventListener('change', persistFormState);`（两事件都冒泡到 form，一对监听器覆盖所有字段；input 抓打字，change 抓 select 与 checkbox；重复写同一状态无害）。
  - `fillConsoleUrl` 在写入字段后追加 `persistFormState()`（脚本赋值不触发 input 事件，需手动镜像）。
  - 模块加载流程末尾（`window.addEventListener('message', ...)` 之后）调用 `restoreFormState();`，保留 `export {}`。
- [ ] `src/webview/NacosInstanceFormPanel.ts:105-110`：panel options 加 `retainContextWhenHidden: true`。
- [ ] 跑测试至全绿。

### Tests

`test/webview/NacosInstanceFormPanel.test.ts`（该文件已有 `openWith()` 与 `formPayload()` 辅助函数，直接复用）：

- `NacosInstanceFormPanel.open` describe 内新增：`keeps the page alive while its tab is hidden, so unsaved fields survive a tab switch` —— `const panel = await openWith(); expect(panel.options).toMatchObject({ enableScripts: true, retainContextWhenHidden: true });`（fixture 的 `createWebviewPanel` 会记录 options）。
- 新 `describe('readSavedInstanceFormState')`（import 自 `../../webview/nacos-instance-form/state`）：
  - `accepts the payload shape the page writes`：`readSavedInstanceFormState(formPayload({ password: 'hunter2', readOnly: true }))` 等于入参。
  - `answers undefined on a first open, when no state was ever written`：入参 `undefined`。
  - `it.each` 拒绝：缺一个字段的对象、`readOnly: 'yes'`（类型错）、`null`、字符串——全部返回 `undefined`。

### i18n

无新增用户可见文案；不改任何 i18n 文件。

### Pitfalls

- **`state.ts` 必须零 DOM 依赖**（不 import index.ts、不摸 `document`/`window`），否则 vitest 在 Node 下 import 即炸。
- `index.ts` 之前因"无 import"靠 `export {}` 保持模块语义；加了 `import ./state` 后 `export {}` 仍要保留（防止 import 将来被移除时全局命名冲突回归）。
- 状态只进 `vscode.setState`——**绝不**把 payload（含密码）postMessage 给插件宿主存储。
- esbuild 会跟随 `index.ts` 的相对 import 打进 `dist/webview/nacos-instance-form.js`，无需改 `esbuild.config.mjs`；改完跑一次 `npm run build` 验证 bundle 仍生成。
- `restoreFormState` 必须在事件监听挂好之后、模块底部执行；恢复后要调 `applyAuthMode`，否则恢复了 `customHeader` 模式却仍显示密码栏。

### Done when

- [ ] panel options 含 `retainContextWhenHidden: true`（测试断言）。
- [ ] 页面每次编辑（打字/select/checkbox/probe 回填 consoleUrl）都会 `setState(payloadFromForm())`；重建页面时完整还原 9 个字段并套用 authMode 显隐。
- [ ] `readSavedInstanceFormState` 的 6 个用例通过；全量测试与 typecheck 通过。

---

## Task 4 `atNacos.createConfig`：命名空间/分组节点上的"新建配置"

### Why

服务端不存在的配置在 UI 上没有任何创建入口：`openDraftDocument` 总是先 `getConfig`，dataId 不存在直接抛错——尽管 `publishConfig`（`src/write/publishConfig.ts` 第 48–58 行）早已把 `resource-not-found` 当作 upsert 处理（服务端内容视为空串、走同一条 diff + 模态确认流水线）。补一个 `atNacos.createConfig` 命令挂在**可写的**命名空间/分组节点上，从输入框收 dataId（与分组，若从命名空间发起），开空草稿，复用现有发布管线；顺带让"编辑刚被别人删掉的配置"也能落到空草稿而不是死菜单。

### Files

- `src/document/openDraftDocument.ts`
- `src/nacos/driver/configLanguage.ts`
- `src/extension.ts`
- `package.json`、`package.nls.json`、`package.nls.zh-cn.json`、`l10n/bundle.l10n.zh-cn.json`
- 测试：`test/document/openDraftDocument.test.ts`、`test/nacos/driver/configLanguage.test.ts`、`test/extension/WriteCommands.test.ts`、`test/extension/Manifest.test.ts`、`test/extension/ExtensionLifecycle.test.ts`

### Current code behavior（已读源码）

- `src/document/openDraftDocument.ts:30-36`：无缓存草稿时无条件 `connect()` + `client.getConfig(ref)`，任何失败上抛。
- `src/nacos/driver/configLanguage.ts`：只有 `configLanguageId`（type/后缀 → VS Code 语言 id）；**没有反向**"dataId 后缀 → Nacos type"。`LANGUAGE_BY_SUFFIX` 与 `PLAIN_TEXT` 是模块内私有常量，可直接复用。
- `src/nacos/driver/NacosDriver.ts:455-461` + `478-484`：`getConfig` 对"配置不存在"抛 `NacosApiError`，`kind === 'resource-not-found'`——这是空草稿回退要 catch 的准确判据。
- 树节点：`NamespaceTreeItem`（有 `instance`、`namespace.namespaceId`）与 `GroupTreeItem`（有 `instance`、`namespaceId`、`group`），contextValue 分别为 `atNacos.namespace[.readonly]` / `atNacos.group[.readonly]`（`src/tree/NacosTreeItems.ts:47-49`）。二者当前在 `src/extension.ts` 是 type-only import（第 41–50 行），命令里要 `instanceof` 判别，需改成值 import。

### Implementation steps

- [ ] **TDD 第一步**：按下方 Tests 小节先写 `openDraftDocument` 与 `configTypeForDataId` 的测试，确认失败。
- [ ] `src/nacos/driver/configLanguage.ts` 新增导出：
  ```ts
  export function configTypeForDataId(dataId: string): string {
    const language = LANGUAGE_BY_SUFFIX.get(suffixOf(dataId)) ?? PLAIN_TEXT;
    return language === PLAIN_TEXT ? 'text' : language;
  }
  ```
  （复用同一张后缀表，两个方向不许漂移；"无格式"两侧拼写不同——VS Code 叫 `plaintext`、Nacos 叫 `text`，未知后缀也落 `text`。）
- [ ] `src/document/openDraftDocument.ts`：
  - `OpenDraftDocumentOptions` 加 `createNew?: boolean`（含 doc 注释：dataId 来自输入框而非树节点，fetch 只可能答 resource-not-found，因此跳过；发布仍会重读服务端，真的已存在会在确认 diff 里现形而不是被盲覆盖）。
  - 私有 `emptyDetail(ref): NacosConfigDetail` = `{ ...ref, content: '', type: configTypeForDataId(ref.dataId) }`（空 `content` 同时作为 `baseContent`，与 `publishConfig` 对 resource-not-found 读出的空串一致，首次发布不会被误报冲突）。
  - 私有 `fetchDetailOrEmpty(connect, ref)`：try `getConfig`；catch 里 `error instanceof NacosApiError && error.kind === 'resource-not-found'` → `emptyDetail(ref)`，**其他错误照抛**（服务器打不通≠空配置，空草稿盖真配置等于邀请用户发布空白）。
  - 主流程第 31–36 行改为 `const detail = createNew ? emptyDetail(ref) : await fetchDetailOrEmpty(connect, ref);`。
- [ ] `src/extension.ts`：
  - import 改为值引入 `GroupTreeItem`、`NamespaceTreeItem`；类型引入 `NacosConfigRef`。
  - 模块底部加 `const DEFAULT_GROUP = 'DEFAULT_GROUP';` 与：
    ```ts
    async function askForNewConfigRef(item: NamespaceTreeItem | GroupTreeItem): Promise<NacosConfigRef | undefined>
    ```
    ——先 `showInputBox({ prompt: t('Data ID of the new configuration'), placeHolder: t('e.g. application-uat.yaml'), validateInput: (value) => (value.trim() === '' ? t('A data ID is required.') : undefined) })`；`typedDataId?.trim()` 为空（Escape 会绕过 validateInput）→ undefined。`GroupTreeItem` 直接返回 `{ namespaceId: item.namespaceId, group: item.group, dataId }`；`NamespaceTreeItem` 再问一框 `showInputBox({ prompt: t('Group of the new configuration'), value: DEFAULT_GROUP })`，`undefined`（Escape）→ 放弃，空串 → `DEFAULT_GROUP`（Nacos 本来就把空分组读作默认组）。
  - 在 `editConfigCommand` 之前注册 `createConfigCommand = vscode.commands.registerCommand('atNacos.createConfig', async (item: NamespaceTreeItem | GroupTreeItem) => {...})`：读回实例（`configManager.getInstance(item.instance.id)`，无则 return）→ `askForNewConfigRef`（undefined 则 return）→ `withLoadingProgress(t('Opening draft for {dataId}...', ...), () => openDraftDocument({ instance, ref, draftProvider: draftFileSystemProvider, connect: () => connectToInstance(item.instance.id, item.instance.label), createNew: true }))`；catch 走 `log.error('createConfig: ...')` + `showErrorMessage(t('Could not create the configuration: {message}', { message }))`。（`assertWritable` 在 openDraftDocument 里跑，写路径的第二道防线不用重复。）
  - 把 `createConfigCommand` push 进 `context.subscriptions`（放在 `showServiceSubscribersCommand` 与 `editConfigCommand` 之间）。
- [ ] `package.json`：
  - `contributes.commands` 加 `{ "command": "atNacos.createConfig", "title": "%atNacos.command.createConfig.title%", "icon": "$(new-file)" }`。
  - `menus.commandPalette` 加 `{ "command": "atNacos.createConfig", "when": "false" }`。
  - `menus."view/item/context"` **最前**加 `{ "command": "atNacos.createConfig", "when": "viewItem == atNacos.namespace || viewItem == atNacos.group", "group": "atNacos.modify@0" }`（`==` 精确匹配即天然排除 `.readonly` 后缀节点——只读实例不给新建入口）。
- [ ] 更新 `ExtensionLifecycle.test.ts`（命令数组插入 `'atNacos.createConfig'`，subscriptions +1，改注释英文数字）。
- [ ] 跑测试至全绿。

### Tests

- `test/document/openDraftDocument.test.ts` 新增 4 条：
  - `starts an empty draft without asking the server when createNew is set`：`connect` 不被调；草稿 `content === ''`、`baseContent === ''`、`type === 'yaml'`（ref dataId `brand-new.yaml`）；`setTextDocumentLanguage` 收到 `'yaml'`。
  - `falls back to an empty draft when the server says the config does not exist`：`getConfig` reject `new NacosApiError('resource-not-found', 'no such config', 404)`；`connect` 被调过；空草稿 `type === 'json'`（dataId `just-deleted.json`）。
  - `still throws every other fetch failure rather than opening a blank draft over a real config`：`new NacosApiError('network', 'connection refused')` → rejects `/connection refused/`，且无草稿残留。
  - `throws for a read-only instance even when creating new, without opening anything`：readOnly + createNew → rejects `/read-only/`，`connect` 不被调。
- `test/nacos/driver/configLanguage.test.ts` 新 describe `configTypeForDataId`：`app.yaml`→`yaml`、`app.yml`→`yaml`、`app.properties`→`properties`、`app.conf`→`properties`、`app.json`→`json`、`app.xml`→`xml`、`app.html`→`html`、`app.txt`→`text`、无后缀 `application`→`text`、未知后缀 `app.zip`→`text`（关键断言：**返回 `text` 而非 `plaintext`**）。
- `test/extension/WriteCommands.test.ts` 新增 3 条：
  - `invokes openDraftDocument with createNew from a group node once the input box answers a dataId`：`fixtureWindow.__setInputBoxResults(['new-app.yaml'])`，构造 `GroupTreeItem('config', instance, 'dev', 'DEFAULT_GROUP', 1)`，断言 `openDraftDocument` 收到 `{ createNew: true, ref: { namespaceId: 'dev', group: 'DEFAULT_GROUP', dataId: 'new-app.yaml' } }`。
  - `asks a namespace node for the group too and reads a cleared box as DEFAULT_GROUP`：输入序列 `['new-app.yaml', '']`，`NamespaceTreeItem` 起点，断言 group 落为 `DEFAULT_GROUP`。
  - `abandons creation when the dataId box is dismissed, without opening a draft`：输入序列 `[undefined]`，`openDraftDocument` 不被调。
- `test/extension/Manifest.test.ts`：
  - 第 133–154 行 `when:false` 清单加 `['atNacos.createConfig']`。
  - 新增 helper `namespaceNodeValue(readOnly)`（`new NamespaceTreeItem('config', instance(readOnly), { namespaceId: 'uat', displayName: 'uat', type: 2 }, 2).contextValue`）与 `groupNodeValue(readOnly)`；新增用例断言 `nodeMenu('atNacos.createConfig').when === 'viewItem == atNacos.namespace || viewItem == atNacos.group'`，且可写命名空间/分组 contextValue 恰为 `atNacos.namespace`/`atNacos.group`、只读为 `.readonly` 后缀（`==` 匹配不到）。
- `test/extension/ExtensionLifecycle.test.ts`：见记账规则。

### i18n

- `t()` 新 key + `l10n/bundle.l10n.zh-cn.json`：
  ```json
  "Data ID of the new configuration": "新建配置的 Data ID",
  "e.g. application-uat.yaml": "例如 application-uat.yaml",
  "A data ID is required.": "Data ID 不能为空。",
  "Group of the new configuration": "新建配置的分组",
  "Could not create the configuration: {message}": "无法新建配置：{message}"
  ```
- `package.nls.json`：`"atNacos.command.createConfig.title": "AT Nacos: New Configuration"`；`package.nls.zh-cn.json`：`"atNacos.command.createConfig.title": "AT Nacos: 新建配置"`（两文件 key 集合必须一致，`nls.test.ts` 会比对）。

### Pitfalls

- Manifest 的两条守卫都会咬人：命令注册集合必须与 `contributes.commands` 完全一致；palette 里可见的命令不允许存在带参命令 → `when:false` 清单与 it.each 清单同步加。
- `readonly` 后缀靠 `==` 排除，别把 when 写成正则（会把 `.readonly` 也放进来）。
- `withLoadingProgress` 的加载文案复用既有 key `'Opening draft for {dataId}...'`（bundle 已有），不要新造。
- `validateInput` 只拦交互输入；Escape 返回 undefined 绕过它，所以 trim 后判空必须在代码里再做一次。
- `NacosApiError` 的 import 路径：`src/document/` 下用 `../nacos/NacosApiError`。

### Done when

- [ ] 可写命名空间/分组节点右键出现"新建配置"，只读节点不出现。
- [ ] 走完输入框后打开空草稿、语言模式按后缀正确、首次发布注册的 Nacos type 不是 `text`（除非确实无后缀）。
- [ ] 编辑"刚被删除"的配置落空草稿；网络错误照抛。
- [ ] 全部新旧测试通过；命令数 +1、subscriptions +1 记账完成。

---

## Task 5 README 诚实化 + `atNacos.uninstallMcpConfig` + 安装三态提示

### Why

README 第 15 行声称支持"阿里云/官方 AK/SK 签名鉴权"，但 `createAuthStrategy` 对 `akSk` 直接 throw（表单也不提供该选项，见 `src/webview/NacosInstanceFormPanel.ts` 第 18–29 行注释），这是对用户的虚假承诺；第 99 行引用的命令名 "Install/Repair AT Series MCP Config" 与真实命令标题不符。同时 `uninstallAtSeriesConfigForCurrentIde` 在 `src/mcp/McpConfigInstaller.ts` 已实现、在 `src/extension.ts` 第 8 行已 import 却无任何调用——装了 MCP 配置没有卸载入口。最后 `atNacos.installMcpConfig` 只有两态提示：installer 对不支持的宿主（如原生 VS Code）返回 `undefined`，当前代码把它报成 "already up to date"，谎称装过。

### Files

- `README.md`
- `src/extension.ts`
- `package.json`、`package.nls.json`、`package.nls.zh-cn.json`、`l10n/bundle.l10n.zh-cn.json`
- 测试：新建 `test/extension/McpConfigCommands.test.ts`；改 `test/extension/ExtensionLifecycle.test.ts`、`test/extension/Manifest.test.ts`

### Current code behavior（已读源码）

- `src/extension.ts:798-815`：`installMcpConfigCommand`——`res?.updated` 为真报安装成功，否则一律 "already up to date"（`res === undefined` 被吞进后者）。
- `src/mcp/McpConfigInstaller.ts:24-38`：`resolveMcpInstallerTarget` 只认 kiro/continue/cursor，其余返回 `undefined`；`ensureAtSeriesConfigForCurrentIde` / `uninstallAtSeriesConfigForCurrentIde` 相应返回 `undefined` / `{ updated }` / `{ removed }`。
- `README.md:15`（AK/SK 虚假声明）、`README.md:99`（命令名失实）。

### Implementation steps

- [ ] 新建 `test/extension/McpConfigCommands.test.ts` 先写测试（见下），确认失败。
- [ ] `src/extension.ts` 改 `installMcpConfigCommand` 为三态：
  - `res === undefined` → `showInformationMessage(t('This IDE does not support automatic AT Series MCP configuration install.'))`
  - `res.updated` → `t('AT Series MCP configuration installed. Reconnect your MCP client to pick up the change.')`（替换原 `'AT Series MCP configuration installed successfully.'`）
  - 否则 → 原样 `t('AT Series MCP configuration is already up to date.')`
- [ ] 紧随其后注册 `uninstallMcpConfigCommand = vscode.commands.registerCommand('atNacos.uninstallMcpConfig', async () => {...})`：调 `uninstallAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() })`；三态：`undefined` → `t('This IDE does not support automatic AT Series MCP configuration removal.')`；`res.removed` → `t('AT Series MCP configuration removed.')`；否则 → `t('No AT Series MCP configuration was found to remove.')`；catch → `log.error('uninstallMcpConfig: ...')` + `showErrorMessage(t('Could not uninstall MCP configuration: {message}', { message }))`。push 进 `context.subscriptions`（`installMcpConfigCommand` 之后）。
- [ ] `package.json` `contributes.commands` 加 `{ "command": "atNacos.uninstallMcpConfig", "title": "%atNacos.command.uninstallMcpConfig.title%" }`。**不加** commandPalette 条目——该命令无参数，本就应该能从命令面板执行（与 installMcpConfig 一致）。
- [ ] `README.md`：
  - 第 15 行改为：`- **多种鉴权策略**：支持无鉴权、账号密码（User/Password）与自定义请求头（可用于携带静态 Token 等凭据）。AK/SK 签名鉴权**尚未实现**（规划中）。`
  - 第 99 行改为：`5. （可选）运行 **AT Nacos: 安装 MCP 配置 (Install MCP Configuration)**，然后重连 MCP 客户端；如需移除，运行 **AT Nacos: 卸载 MCP 配置 (Uninstall MCP Configuration)**。`
- [ ] 更新 `ExtensionLifecycle.test.ts`（数组插入 `'atNacos.uninstallMcpConfig'`，subscriptions +1，注释数字）。
- [ ] 跑测试至全绿。

### Tests

`test/extension/McpConfigCommands.test.ts`（新文件；mock `../../src/mcp/hubSync` 的 `syncPackagedHub` 与 `../../src/mcp/McpConfigInstaller` 的 ensure/uninstall——用 `vi.spyOn` 或 `vi.mock`，beforeEach 清 fixture，与其他 extension 测试同套路）：

- `tells the user the IDE is unsupported when the installer answers undefined`
- `reports an install and asks for an MCP client reconnect when the config was written`（`{ updated: true }`）
- `reports up to date only when the installer really found the config current`（`{ updated: false }`）
- `shows an error rather than a success message when the install throws`
- `tells the user the IDE is unsupported when the uninstaller answers undefined`
- `reports a removal when the uninstaller removed the config`（`{ removed: true }`）
- `says there was nothing to remove when the config was already gone`（`{ removed: false }`）
- `shows an error rather than a success message when the uninstall throws`
- `hands the uninstaller the same host environment and workspace folder the installer gets`（断言两者收到同样的 `appName/appRoot/uriScheme/extensionPath/workspaceFolder`）

`test/extension/Manifest.test.ts`：无需加 `when:false`（命令面板可见是有意的）；`registers a handler for exactly the commands it contributes` 会因 package.json + 注册双侧同步而自动通过——不同步则失败，这正是守卫。

### i18n

- `l10n/bundle.l10n.zh-cn.json`：
  ```json
  "AT Series MCP configuration installed. Reconnect your MCP client to pick up the change.": "AT Series MCP 配置已安装。请重新连接 MCP 客户端以使配置生效。",
  "This IDE does not support automatic AT Series MCP configuration install.": "当前 IDE 不支持自动安装 AT Series MCP 配置。",
  "This IDE does not support automatic AT Series MCP configuration removal.": "当前 IDE 不支持自动卸载 AT Series MCP 配置。",
  "AT Series MCP configuration removed.": "AT Series MCP 配置已卸载。",
  "No AT Series MCP configuration was found to remove.": "未找到需要卸载的 AT Series MCP 配置。",
  "Could not uninstall MCP configuration: {message}": "无法卸载 MCP 配置：{message}"
  ```
  同时**删除**被替换的旧条目 `"AT Series MCP configuration installed successfully."`（源里不再有该 t() 调用；bundle 不查悬空 key，但别留死翻译）。
- `package.nls.json`：`"atNacos.command.uninstallMcpConfig.title": "AT Nacos: Uninstall MCP Configuration"`；`package.nls.zh-cn.json`：`"atNacos.command.uninstallMcpConfig.title": "AT Nacos: 卸载 MCP 配置"`。

### Pitfalls

- `nls.test.ts` 的 `leaves no nls key unused`：nls key 必须真的被 package.json 的 `%...%` 引用，先加 manifest 条目再加 nls 条目。
- 三态判断要区分 `res === undefined` 与 `res.updated === false`——`res?.updated` 的旧写法正是 bug 本体，别复刻。
- README 是中文文档，措辞保持诚实但不贬损：AK/SK 写"尚未实现（规划中）"，`akSk` 在 config schema 里仍是合法存储值（为后续 D1 留位），不要顺手删 schema。
- subscriptions +1、命令数组 +1（记账规则见文首）。

### Done when

- [ ] README 不再声称 AK/SK 已支持；安装/卸载命令名与实际标题一致。
- [ ] `atNacos.uninstallMcpConfig` 可从命令面板执行，三态提示 + 错误提示齐全；install 同样三态。
- [ ] 新测试文件 9 条用例全过；命令/订阅记账完成；`npm test` 全绿。

---

## Task 6 实例节点右键：编辑 / 删除 / 集群状态

### Why

编辑或删除一个实例目前只能走 `atNacos.manageInstances` 的两层 quick pick——用户明明右键点在实例节点上，却还要在弹出列表里再选一次同一个实例。实例节点（`InstanceTreeItem`，contextValue `atNacos.instance[.readonly]`）当前没有任何 `view/item/context` 菜单。补 `atNacos.editInstance`、`atNacos.deleteInstance` 两个节点命令，并让既有 `atNacos.openClusterStatus` 接受可选的 `InstanceTreeItem` 参数：从节点进来不再弹选择框，从视图标题进来行为不变。

### Files

- `src/extension.ts`
- `package.json`、`package.nls.json`、`package.nls.zh-cn.json`、`l10n/bundle.l10n.zh-cn.json`
- 测试：`test/extension/InstanceCommands.test.ts`、`test/extension/ClusterStatusCommand.test.ts`、`test/extension/Manifest.test.ts`、`test/extension/ExtensionLifecycle.test.ts`

### Current code behavior（已读源码）

- `src/extension.ts:393-414`：`openClusterStatusCommand` 处理函数**不收参数**，一律走 `pickInstanceForClusterStatus`（单实例免选、多实例 quick pick）。
- `src/extension.ts:921-962`：`manageInstances` 是编辑/删除的唯一入口；`deleteInstanceWithConfirmation`（第 968–983 行）已有模态确认，可直接复用。
- `src/tree/NacosTreeItems.ts:101-117`：`InstanceTreeItem` 携带完整 `instance`，当前在 extension.ts 未 import。
- `package.json` `view/item/context` 无任何 `atNacos.instance` 相关条目。

### Implementation steps

- [ ] 先在 `InstanceCommands.test.ts` / `ClusterStatusCommand.test.ts` 写失败测试（见下）。
- [ ] `src/extension.ts`：
  - import 值引入 `InstanceTreeItem`。
  - 在 `manageInstancesCommand` 之后注册两个命令（两者都**按 id 重读记录**——树画出来之后实例可能已被编辑，节点上的副本是旧的；`getInstance` 返回 undefined 则静默 return）：
    - `atNacos.editInstance`：`async (item: InstanceTreeItem)` → `openInstanceForm(instance)`；catch → `log.error('editInstance: ...')` + 复用既有文案 `t('Could not open the Nacos instance form: {message}')`。
    - `atNacos.deleteInstance`：→ `deleteInstanceWithConfirmation(configManager, instance, <刷新回调>)`；catch → `t('Could not delete the Nacos instance: {message}')`（新 key）。刷新回调：任务 1 已做则传 `refreshAfterInstanceChange`，否则传 `refreshTreeViews`。
  - `openClusterStatusCommand` 签名改 `async (item?: InstanceTreeItem)`：
    ```ts
    const instance = item instanceof InstanceTreeItem
      ? await configManager.getInstance(item.instance.id)
      : await pickInstanceForClusterStatus(configManager, openInstanceForm);
    ```
    其余（`ClusterStatusPanel.open`、错误处理）不变。`instanceof` 判别而非鸭子类型：命令面板路径会传 `undefined`，其他菜单误传的对象不能被当成节点。
  - 两个新命令 push 进 `context.subscriptions`（`manageInstancesCommand` 之后）。
- [ ] `package.json`：
  - `contributes.commands` 加：`atNacos.editInstance`（title 占位符 + `"icon": "$(edit)"`）、`atNacos.deleteInstance`（`"icon": "$(trash)"`）。
  - `menus.commandPalette` 加两条 `"when": "false"`（editInstance / deleteInstance 都必须带节点参数）。**openClusterStatus 不加**——它无参也能问出目标，palette 保留。
  - `menus."view/item/context"` 加三条（when 一律 `viewItem =~ /^atNacos\\.instance\\b/`——`\b` 让 `.readonly` 后缀也命中，`^` 锚定使 `atNacos.serviceInstance.*` 永不命中）：
    - `atNacos.openClusterStatus` → `"group": "atNacos.inspect@1"`
    - `atNacos.editInstance` → `"group": "atNacos.modify@1"`
    - `atNacos.deleteInstance` → `"group": "atNacos.modify@2"`
- [ ] 更新 `ExtensionLifecycle.test.ts`（数组插入两条，subscriptions +2，注释数字）。
- [ ] 跑测试至全绿。

### Tests

- `test/extension/InstanceCommands.test.ts` 新增（构造 `new InstanceTreeItem('config', storedInstance() as never)` 作为参数）：
  - `opens the form for the node atNacos.editInstance was invoked on, without any pick`：`showQuickPick` 不被调，`createWebviewPanel` 标题为 `Edit Nacos Instance: prod`。
  - `edits the stored record rather than the copy a stale node still holds`：globalState 里存改过 label 的记录，节点仍持旧副本，断言表单收到存储版。
  - `deletes the instance of the node atNacos.deleteInstance was invoked on once the modal is confirmed`：mock `showWarningMessage` 返回 Delete，断言 globalState 清空。
  - `keeps the instance when the node delete modal is dismissed`。
  - `redraws both trees after a node delete`（两 listener 各 1 次）。
  - `does nothing for a node whose instance is no longer configured`（`getInstance` 无记录 → 无弹窗无报错）。
- `test/extension/ClusterStatusCommand.test.ts` 新增：
  - `opens the panel for the node it was invoked on, without asking which`：两实例入库，handler 直接传节点，`showQuickPick` 不被调、`ClusterStatusPanel.open` 收到节点实例。
  - `opens the panel on the stored record rather than the copy a stale node still holds`。
  - `opens nothing for a node whose instance is no longer configured`。
- `test/extension/Manifest.test.ts`：
  - `when:false` it.each 清单加 `['atNacos.editInstance']`、`['atNacos.deleteInstance']`（**不加** openClusterStatus，注释说明它能自己问）。
  - 新 helper `instanceNodeValue(readOnly)`；新增 `it.each([editInstance, deleteInstance, openClusterStatus])('offers %s on a writable and on a read-only instance node, and on nothing under it')`：用 `contextValuePattern(nodeMenu(command).when)` 断言可写/只读实例节点均命中（编辑是关掉只读的唯一途径、只读服务器也能删、看集群是读操作），config 节点与 `ServiceInstanceTreeItem` 的 contextValue 均不命中。
  - 注意 `nodeMenu('atNacos.openClusterStatus')` 要求该命令在 `view/item/context` 恰有 1 条。

### i18n

- `l10n/bundle.l10n.zh-cn.json` 新条目：
  ```json
  "Could not delete the Nacos instance: {message}": "无法删除 Nacos 实例：{message}"
  ```
  （编辑失败复用既有 key `Could not open the Nacos instance form: {message}`，已有翻译。）
- `package.nls.json`：`"atNacos.command.editInstance.title": "AT Nacos: Edit Instance"`、`"atNacos.command.deleteInstance.title": "AT Nacos: Delete Instance"`；`package.nls.zh-cn.json`：`"AT Nacos: 编辑实例"`、`"AT Nacos: 删除实例"`。

### Pitfalls

- **when 正则是本任务最大的坑**：`atNacos.serviceInstance.enabled/.disabled` 也含 "Instance" 字样；必须 `^atNacos\.instance\b`（JSON 里写 `viewItem =~ /^atNacos\\.instance\\b/`），Manifest 测试用真实 contextValue 编译正则来验，写错立刻红。
- 三个菜单条目对只读实例**故意可见**（`\b` 让 `.readonly` 命中）——与 config 写命令的 `==` 精确匹配策略相反，别照抄后者。
- `deleteInstanceWithConfirmation` 回调签名取决于任务 1 是否已做（`(instanceId) => void` vs `() => void`），两个任务都做时统一为任务 1 的版本。
- subscriptions +2；`ClusterStatusCommand.test.ts` 既有 6 条用例必须原样通过（视图标题路径行为不变）。

### Done when

- [ ] 实例节点右键出现"集群状态 / 编辑实例 / 删除实例"，只读实例同样出现，实例下层节点与注册服务实例节点不出现。
- [ ] 节点路径不弹 quick pick；删除有模态确认并重绘两棵树；三个命令都按 id 重读记录。
- [ ] 视图标题的 openClusterStatus 行为回归通过；命令 +2、subscriptions +2 记账完成。

---

## Task 7 服务树按服务名过滤（镜像 ConfigTreeProvider）

### Why

配置树有 `atNacos.filterConfigs` / `atNacos.clearConfigFilter`，服务树什么都没有——上千服务的命名空间只能靠翻页肉眼找。驱动层其实已经准备好了：`NacosServiceListQuery.serviceName`（`src/nacos/driver/NacosDriver.ts` 第 93–98 行）在 catalog 与 3.x 列表里被转发为 `serviceNameParam`（`src/nacos/driver/naming.ts` 第 63 行，服务端做子串匹配），只是没有任何 UI 调用它。把 `ConfigTreeProvider` 的过滤器结构原样镜像到 `ServiceTreeProvider`，加两个视图标题命令。

### Files

- `src/tree/ServiceTreeProvider.ts`
- `src/extension.ts`
- `package.json`、`package.nls.json`、`package.nls.zh-cn.json`、`l10n/bundle.l10n.zh-cn.json`
- 测试：`test/tree/ServiceTreeProvider.test.ts`、`test/extension/ExtensionLifecycle.test.ts`、`test/extension/Manifest.test.ts`

### Current code behavior（已读源码）

- `src/tree/ServiceTreeProvider.ts:264-273`：`fetchPage` 调 `client.listServices({ namespaceId, pageNo, pageSize: SERVICE_PAGE_SIZE })`——不传 `serviceName`。Provider 无 `filterText`、无 `attachTreeView`/`getFilter`/`setFilter`/`clearFilter`。
- `src/tree/ConfigTreeProvider.ts:72-79`（字段）、104–121（attach/get/set/clear）、172–195（`applyFilter` + `showFilterOnView`）——逐行镜像的模板。
- `src/extension.ts:290-292`：`serviceTreeView` 创建后**没有** `attachTreeView`（配置树在第 289 行有）。
- `src/nacos/driver/naming.ts:97-114`：name-only 兜底列表（`fetchServiceNames`）没有名字参数——降级到它的老服务器上过滤静默失效，这是已知且接受的行为（提示语义由驱动层负责）。

### Implementation steps

- [ ] 先在 `test/tree/ServiceTreeProvider.test.ts` 写失败测试（见下）。
- [ ] `src/tree/ServiceTreeProvider.ts`（照 `ConfigTreeProvider` 镜像，逐项）：
  - `import type * as vscode from 'vscode';`、`import { t } from '../i18n/t';`。
  - 私有字段 `filterText: string | undefined` 与 `treeView: Pick<vscode.TreeView<NacosTreeItem>, 'message'> | undefined`。
  - `attachTreeView(treeView)`：赋值 + 立即 `showFilterOnView()`（view 建于 provider 之后，过滤器可能已被设置）。
  - `getFilter()` / `setFilter(text)`（trim 后空串视为无过滤）/ `clearFilter()`。
  - 私有 `applyFilter(filterText)`：同文本直接 return（重复输入不是重新加载）；更新 `filterText`；`this.pageCache.clear()`（换了结果集，页计数失义）；**`instanceCache` 保留**（一个服务的实例列表与它被哪个列表找到无关——这是与 ConfigTreeProvider 唯一的结构差异点）；`showFilterOnView()`；`this.onDidChangeTreeDataEmitter.fire()`（全树，所有命名空间同时变）。
  - 私有 `showFilterOnView()`：`this.treeView.message = this.filterText ? t('Filter: "{text}"', { text: this.filterText }) : undefined;`（复用配置树的既有 key）。
  - `fetchPage` 的 `listServices` 调用加 `serviceName: this.filterText`（原样透传，不 trim 不加通配——哪个版本、哪个参数名能吃它是驱动的知识）。
- [ ] `src/extension.ts`：
  - `serviceTreeView` 创建后加 `serviceTreeProvider.attachTreeView(serviceTreeView);`。
  - 在 `clearConfigFilterCommand` 之后注册：
    - `atNacos.filterServices`：`showInputBox({ prompt: t('Filter services by service name'), placeHolder: t('e.g. merchant-admin'), value: serviceTreeProvider.getFilter() ?? '' })`；`typed !== undefined` 才 `setFilter`（Escape 保留现有过滤，空串是明确的"全部显示"）。
    - `atNacos.clearServiceFilter`：`serviceTreeProvider.clearFilter()`。
  - 两命令 push 进 subscriptions（`clearConfigFilterCommand` 之后）。
- [ ] `package.json`：
  - `contributes.commands` 加 `atNacos.filterServices`（`"icon": "$(filter)"`）与 `atNacos.clearServiceFilter`（`"icon": "$(clear-all)"`）。
  - `menus."view/title"` services 段重排：`addInstance@1`、`refreshServices@2` 不动；**新增** `filterServices@3`、`clearServiceFilter@4`；既有 `openClusterStatus` 由 @3 挪到 @5、`manageInstances` 由 @4 挪到 @6。
  - 无参命令，palette 不加 `when:false`。
- [ ] 更新 `ExtensionLifecycle.test.ts`（数组插入两条，subscriptions +2，注释数字）。
- [ ] 跑测试至全绿。

### Tests

- `test/tree/ServiceTreeProvider.test.ts` 新 `describe('ServiceTreeProvider filtering')`（沿用该文件既有的 fake client/factory 构造方式；断言点是 factory 产出 client 的 `listServices` 收到的 query）：
  - `sends no service name while nothing is filtered`：`serviceName: undefined`。
  - `hands the driver the text the user typed, with no search mode and no wildcards`：`setFilter('merchant')` → query 恰含 `serviceName: 'merchant'`，无 `*` 包装。
  - `trims the filter text before it searches with it`（`'  merchant  '` → `'merchant'`）。
  - `reads blank filter text as no filter at all`（`setFilter('   ')` → undefined）。
  - `stops searching once the filter is cleared`。
  - `starts the filtered listing at page one rather than continuing the unfiltered paging`：先 loadMore 到 page 2，setFilter 后下一次请求 `pageNo: 1`。
  - `starts at page one again when the filter is cleared`。
  - `redraws the whole tree when the filter changes`：`onDidChangeTreeData` 收到 `undefined`。
  - `keeps the pages already loaded when the same filter text is entered again`：同文本二次 setFilter 不清 pageCache、不发新请求。
  - `does nothing when the filter is cleared and there was none`。
  - `reports the filter on the view message, and takes it off again`：attach 后 set → message 含文本；clear → `undefined`。
  - `reports a filter that was set before the view was attached`：先 set 后 attach，message 立即出现。
- `test/extension/ExtensionLifecycle.test.ts` 新增（镜像既有 filterConfigs 四条，view index 用 1）：
  - `filters the service tree with what the input box returns`
  - `leaves the service filter alone when the input box is dismissed`
  - `offers the current service filter as the text to edit rather than an empty box`
  - `clears the service filter with the command contributed for it`
  - `shows the active filter on the services view, and only on that view`（`__getTreeViews()[1].message` 有、`[0]` 无）
- `test/extension/Manifest.test.ts` 新增 `it.each([['atNacos.filterServices','$(filter)'],['atNacos.clearServiceFilter','$(clear-all)']])('puts %s on the services view title with an icon')`：断言 icon 与 `when === 'view == atNacos.services'` 恰一条。

### i18n

- `l10n/bundle.l10n.zh-cn.json` 新条目（`Filter: "{text}"` 已存在，勿重复）：
  ```json
  "Filter services by service name": "按服务名过滤服务",
  "e.g. merchant-admin": "例如 merchant-admin"
  ```
- `package.nls.json`：`"atNacos.command.filterServices.title": "AT Nacos: Filter Services"`、`"atNacos.command.clearServiceFilter.title": "AT Nacos: Clear Service Filter"`；`package.nls.zh-cn.json`：`"AT Nacos: 过滤服务"`、`"AT Nacos: 清除服务过滤"`。

### Pitfalls

- **缓存 key 与缓存分层**：`pageCache` key 是 `joinKey(instanceId, namespaceId)`（percent-encoded 冒号连接），换过滤词必须 `pageCache.clear()` 否则老结果集冒充新结果；`instanceCache`（key 为 instance+namespace+group+serviceName）**不清**——清了会让展开着的服务节点无谓重拉。
- `Manifest.test.ts` 的 `scopes every view/title menu item to a view it contributes` 会检查每条 view/title 的 when；重排 group 序号时别把 configs 段的条目改坏。
- 服务名参数是**服务端子串匹配**（catalog/3.x 的 `serviceNameParam`），与配置树的 `*term*` blur 包装不同——不要在 provider 或 extension 层加通配符。
- 降级到 name-only 列表的旧 1.x 上过滤不生效（该端点无名字参数），属已知限制，不要试图在客户端本地二次过滤（会与"分组由已加载页反推"机制打架）。
- 命令 +2、subscriptions +2 记账。

### Done when

- [ ] 服务视图标题出现过滤/清除按钮；过滤词显示在视图 message 行，清除后消失。
- [ ] 过滤词经 `listServices.serviceName` 原样到达驱动；过滤/清除都从第 1 页重新拉。
- [ ] 12 条 provider 测试 + 5 条 lifecycle 测试 + manifest 测试全过；记账完成。

---

## Task 8 MCP：`getClusterNodes` 并行 + `createNacosClient` 可选 certVerifier（工厂必须用它，不走 UI 池）

### Why

两个背景通道的缺陷。其一，`NacosAgentToolService.getClusterNodes`（`src/agent/NacosAgentToolService.ts` 第 355–370 行）串行 `await listClusterNodes()` 再 `await getServerMetrics()`——两个独立读硬排队，白付一次往返延迟（面板侧 `loadClusterStatus` 早就是 `Promise.all`，见 `src/webview/ClusterStatusPanel.ts` 第 162–165 行）。其二更严重：`resolveInstance`（第 195–204 行）精心构造了**非交互**证书校验器（未信任即拒绝，绝不弹窗）传给 `createClient(instance, certVerifier)`，但 `src/extension.ts` 第 236 行的工厂写的是 `createClient: (instance) => getOrCreateClient(instance)`——第二参被丢弃，MCP 调用走 UI 客户端池，池里的客户端是用 `createInteractiveCertVerifier` 建的（`createNacosClient` 第 97 行硬编码），后台工具调用会弹出 TOFU 模态框并挂死等待一个不存在的用户。

### Files

- `src/agent/NacosAgentToolService.ts`
- `src/extension.ts`
- `test/agent/NacosAgentToolService.test.ts`

### Current code behavior（已读源码）

- `src/agent/NacosAgentToolService.ts:355-370`：`getClusterNodes` 串行两次 await，各自带 `.catch(() => [])` / `.catch(() => undefined)` 兜底。
- `src/agent/NacosAgentToolService.ts:58-61`：`NacosAgentClientFactory` 类型**已经**声明为 `(instance, certVerifier) => Promise<NacosApiClientLike>`——接口早就对了，只是 extension.ts 的实现忽略第二参。
- `src/extension.ts:89-114`：`createNacosClient(configManager, instance, certTrustStore, log)` 四参，内部固定 `certVerifier: createInteractiveCertVerifier(certTrustStore)`。
- `src/extension.ts:233-238`：`createClient: (instance) => getOrCreateClient(instance)`——经 `NacosClientPool`，池仅以 `instance.id` 为 key、指纹不含校验器维度，UI 与 MCP 共池必然共享错误的校验器。
- `test/agent/NacosAgentToolService.test.ts` 的 `createMockDeps` 中 `certTrustStore` 目前只 mock 了 `isTrusted`。

### Implementation steps

- [ ] 先在 `test/agent/NacosAgentToolService.test.ts` 写失败测试（见下）。
- [ ] `src/agent/NacosAgentToolService.ts` `getClusterNodes` 改：
  ```ts
  const [nodes, metrics] = await Promise.all([
    resolved.client.listClusterNodes().catch(() => []),
    resolved.client.getServerMetrics().catch(() => undefined)
  ]);
  ```
  （逐调用兜底保留：一个端点挂不能拖掉另一个的答案，与集群面板同一模式。）
- [ ] `src/extension.ts` `createNacosClient` 加第 5 个**可选**参数：
  ```ts
  certVerifier?: NacosCertVerifier
  ```
  （import 改为 `import { NacosCertTrustStore, type NacosCertVerifier } from './nacos/NacosCertTrustStore';`）；`NacosHttpClient` 构造改 `certVerifier: certVerifier ?? createInteractiveCertVerifier(certTrustStore)`。UI 路径（树、集群面板、连接测试）全部不传第 5 参 → 行为不变，现有 4 参调用点（含 `test/extension/createNacosClient.test.ts`）无需改动即可编译。
- [ ] `src/extension.ts` 第 233–238 行 MCP 工厂改为：
  ```ts
  createClient: (instance, certVerifier) =>
    createNacosClient(configManager, instance, certTrustStore, log, certVerifier),
  ```
  **禁止**改回 `getOrCreateClient`：池 key 只有 instance.id，共池会把交互式客户端漏给后台调用（或反向）。每次工具调用新建客户端多付一次 login——可接受，后续 B6（MCP 独立非交互池）再优化。
- [ ] 跑测试至全绿。

### Tests

`test/agent/NacosAgentToolService.test.ts`：

- `createMockDeps` 的 `certTrustStore` 补 `check: vi.fn().mockResolvedValue('trusted')`；返回值追加 `certTrustStore, createClient` 以便断言。
- `nacos_get_cluster_nodes returns both nodes and metrics`：完整结果形状断言（nodes 数组 + metrics 对象）。
- `nacos_get_cluster_nodes fetches nodes and metrics concurrently`：**并发探针**——`getServerMetrics` 的 mock 同步置 `metricsStarted = true`；`listClusterNodes` 的 mock 先 `await Promise.resolve()` 再记录 `metricsStartedBeforeNodesResolved = metricsStarted`。`Promise.all` 下两调用都在任一 await 前启动，flag 为 true；串行实现下 flag 为 false。断言 `metricsStartedBeforeNodesResolved === true`。
- `nacos_get_cluster_nodes keeps one answer when the other call fails`：`listClusterNodes` reject → 结果 `nodes: []` 且 metrics 完整。
- `passes the instance and a non-interactive certificate verifier to createClient`：任意工具调用后 `createClient.mock.calls[0]` 为 `[instance, verifier]`，`typeof verifier.verify === 'function'`。
- `agent cert verifier accepts only certificates the trust store already trusts`：`certTrustStore.check` 依次 mock `'trusted'` → `verify(...)` resolves `true`；`'unknown'` → resolves `false`（**拒绝而非弹窗**：后台 MCP 路径不允许出现 VS Code 模态）。

（`src/extension.ts` 侧的接线由类型系统守卫：`NacosAgentClientFactory` 已是双参签名，工厂改完 `npm run typecheck` 即验证；`createNacosClient` 的 TLS 行为已有 `test/extension/createNacosClient.test.ts` 覆盖 4 参路径，回归必须保持通过。）

### i18n

无新增用户可见文案；不改任何 i18n 文件。

### Pitfalls

- **不要把非交互校验器也塞进 `getOrCreateClient` 的池**：`instanceFingerprint` 不含校验器维度，谁先建谁定生死；两条路径要么分池（B6 的事）、要么 MCP 侧免池（本任务的选择）。
- `createNacosClient` 第 5 参必须**可选**：`openClusterStatus`（extension.ts 第 404 行）与 `createNacosClient.test.ts` 的 4 参调用不许被破坏。
- 并发测试的探针写法依赖"`Promise.all` 先同步启动所有 promise"这一语义，不要改成 `setTimeout` 之类的真实计时（测试会变慢且不稳）。
- `catch` 兜底吞掉 nodes/metrics 错误是**本批次保留的既有行为**；把错误透传给 MCP 结果（`nodesError`/`metricsError`）是后续 B8 的范围，别在这里顺手做。

### Done when

- [ ] `nacos_get_cluster_nodes` 两个读并行发出，单端点失败不影响另一侧结果。
- [ ] MCP 工具调用建出的客户端使用 `resolveInstance` 的非交互校验器：已信任 → 通过，未信任/已变更 → 直接拒绝，全程零弹窗。
- [ ] UI 路径（树 / 集群面板 / 连接测试）TLS 行为不变；4 参调用点原样编译。
- [ ] 新增 5 条 agent 测试 + 既有回归全过；`npm run typecheck` 通过。

---

## Phase 0 收尾核对（全部任务完成后）

- [ ] `npm test` 全绿、`npm run typecheck` 无错、`npm run build` 产物正常。
- [ ] `package.json` `contributes.commands` 共 **27** 条；`ExtensionLifecycle.test.ts` 的排序数组与 subscriptions=**36**（注释 "the twenty-seven commands"）一致。
- [ ] `package.nls.json` 与 `package.nls.zh-cn.json` key 集合一致（`nls.test.ts` 守卫）；所有新 `t()` key 在 `l10n/bundle.l10n.zh-cn.json` 有翻译且占位符齐全。
- [ ] 与 `origin/cursor/nacos-opt-1-8-6a9b` 终态对齐（若走重写路径，可 `git diff` 对比该分支抽查关键文件）。
- [ ] 提交并推送特性分支；随后进入 Phase A（见 `docs/plans/2026-08-27-followup-roadmap.md`，其 A1 的 README 项与本文任务 5 已部分重叠，做 A1 时按已完成部分裁剪）。
