# Phase 0 合入指南 —— 检测 / 合并 / 跳过，不要重写

> **给后续实现 Agent：** 这是 [Phase 0 计划](./2026-08-27-followup-phase-0-prereq.md) 的伴生文档。Phase 0 的 8 项优化**已经在远端分支上完整实现**（本文列出的所有 SHA 于 2026-08-27 用 `git ls-remote` 逐一核实，测试数字用真实 `vitest run` 复核）。你的默认动作是 **merge，不是重写**。只有 §2 的逐项检测证明某项缺失、且 §1 的合并路径不可用时，才回到 Phase 0 文档按 checkbox 实现那一项。

**判定顺序（严格照此执行）：**

1. 查 `package.json` 的 `contributes.commands`：`atNacos.createConfig`、`atNacos.filterServices`、`atNacos.uninstallMcpConfig`、`atNacos.editInstance` **四个全有** → Phase 0 已落地，跑一次 §4 验收后直接进 Phase A，本文读完即弃。
2. 四者不全 → `git ls-remote origin cursor/nacos-opt-1-8-6a9b` 有结果 → 走 §1 合并路径。
3. 合并分支不存在或无法合入 → 用 §2 逐项检测找出缺失项，按 §3 从对应单项分支 cherry-pick，或按 Phase 0 文档重写该项。

---

## 1. 首选路径：merge `origin/cursor/nacos-opt-1-8-6a9b`

### 1.1 该分支是什么

`cursor/nacos-opt-1-8-6a9b`（tip **`5d8d6f2950f420b4ac1eaea7b1e53e6c0c1871db`**，2026-08-27 核实）是 8 个单项优化分支的集成分支。它从 `main`（`c4cc4bf7557b68e93323d1c5fafdf6e6e10a891e`，即 v0.1.2 + skills 文档）上的 form-state 提交出发，按以下顺序把其余 7 个分支 merge 进来（`git log --first-parent` 可复现）：

```
6cbe99c fix(instance-form)  ← 分支起点（任务 3，直接落在 main 上）
412463c ← merge ae986f6 opt-mcp-cluster-cert（任务 8）
0b57e03 ← merge f46fea4 opt-write-refresh（任务 1）
45b456f ← merge 27bc67f opt-save-draft（任务 2）
931db1d ← merge 593e68d opt-readme-mcp（任务 5，含 eccc002 README 提交）
f4bfa5b ← merge 3f70dea opt-service-filter（任务 7）
8298e88 ← merge 0a678cb opt-instance-menu（任务 6，含 2bb58ff 功能提交）
5d8d6f2 ← merge a5701da opt-create-config（任务 4）＝分支 tip
```

该 tip 上 `npm run typecheck` 通过（exit 0）、`npm test` 为 **1980 passed / 33 skipped（共 2013，71 个文件通过 + 1 个 live 文件跳过）**——这两个数字是 2026-08-27 在该 tip 的干净 worktree 上实跑得到的，不是估算。

### 1.2 精确命令

```bash
# 0) 确认不在 main、工作区干净
git branch --show-current       # 不得为 main
git status --porcelain          # 应为空

# 1) 取回集成分支并核对 tip SHA
git fetch origin cursor/nacos-opt-1-8-6a9b
git rev-parse FETCH_HEAD        # 应为 5d8d6f2950f420b4ac1eaea7b1e53e6c0c1871db
                                # 若不同：分支被更新过，先 git log 看新提交再决定

# 2) 无副作用预演：先看会不会冲突
git merge-tree --write-tree --name-only HEAD origin/cursor/nacos-opt-1-8-6a9b
#    exit 0 且输出只有一个 tree SHA（无 CONFLICT 行）→ 干净合并
#    exit 1 → 输出会列出冲突文件，对照 §1.3 处理

# 3) 正式合并（不要 squash：保留 8 个功能提交的边界，方便回溯与二分）
git merge --no-ff origin/cursor/nacos-opt-1-8-6a9b \
  -m "Merge cursor/nacos-opt-1-8-6a9b: land Phase 0 optimizations 1-8"

# 4) 验收（见 §4）
npm run typecheck && npm test
```

**2026-08-27 实测：** 在 `cursor/followup-suggestions-6a9b`（tip `c867424`，只含文档提交）上执行第 2 步预演，exit 0、零冲突——因为两条分支的 merge-base 同为 `c4cc4bf`（当前 origin/main tip），且文档分支只动 `docs/**`。**只要 main 没有前进、你的工作分支只叠加了文档/无关文件，这次合并就是零冲突的。**

### 1.3 若有冲突：历史冲突点与解法

8 个单项分支两两合并时（即 §1.1 那串 merge 的过程中）反复冲突的是这 4 个文件。若你的工作分支包含了别的代码改动、或 main 前进后重演此合并，冲突大概率还是它们：

| 文件 | 为什么冲突 | 解法原则 |
|---|---|---|
| `src/extension.ts` | 任务 1/2/4/5/6/7/8 全都改它：命令注册区、`refreshTreeViews` 的替换、`saveDocumentListener`、MCP 工厂 | **取并集、保留全部 8 项行为**。终态锚点：存在 `refreshAfterConfigWrite`/`refreshAfterServiceWrite`/`refreshAfterInstanceChange` 三个函数且 **`refreshTreeViews` 不存在**；`clientPool.clear()` 全文件**恰好 2 处**（`atNacos.refreshConfigs`/`refreshServices` 两个显式刷新命令里）；`saveDocumentListener` 只发 `setStatusBarMessage`，`inFlightPublish` 不存在；MCP 工厂是 `createClient: (instance, certVerifier) => createNacosClient(configManager, instance, certTrustStore, log, certVerifier)`（**不是** `getOrCreateClient`）；`createConfig`/`uninstallMcpConfig`/`editInstance`/`deleteInstance`/`filterServices`/`clearServiceFilter` 六个新命令全部注册并 push 进 `context.subscriptions` |
| `package.json` | 各分支都往 `contributes.commands`、`menus` 里插条目 | **命令取并集**：终态 `contributes.commands` 恰 **27** 条。`menus.commandPalette` 的 `when:"false"` 覆盖 `createConfig`/`editInstance`/`deleteInstance`（带参命令）；`uninstallMcpConfig`、`filterServices`、`clearServiceFilter` **不加** `when:false`（面板可见是有意的）。services 的 `view/title` 顺序：`addInstance@1`、`refreshServices@2`、`filterServices@3`、`clearServiceFilter@4`、`openClusterStatus@5`、`manageInstances@6` |
| `test/extension/ExtensionLifecycle.test.ts` | 每个新增命令都要改同一个排序数组和同一个 `toHaveLength` | **不要接受任何一侧的中间值**（合并历史里出现过 33、35 的中间态）。终态：排序命令数组含全部 27 个 id、`expect(context.subscriptions).toHaveLength(36)`、注释为 `the twenty-seven commands`。逐项记账公式见 Phase 0 文档「记账规则」小节 |
| `test/extension/Manifest.test.ts` | `when:"false"` 的 `it.each` 清单、节点菜单断言各分支都在加 | **清单取并集**：`when:false` it.each 里有 `createConfig`/`editInstance`/`deleteInstance`；保留 createConfig 的 `viewItem == atNacos.namespace \|\| viewItem == atNacos.group`（`==` 精确匹配）断言与实例节点的 `viewItem =~ /^atNacos\.instance\b/`（正则）断言——两种匹配策略是**故意不同**的，别统一 |

解完冲突后跑 §4 验收；`ExtensionLifecycle` 或 `Manifest` 红了几乎必然是上表的并集没取全。也可以用 `git diff origin/cursor/nacos-opt-1-8-6a9b -- src/ test/ package.json` 与集成分支终态对照抽查（差异应只剩你工作分支自己的改动）。

---

## 2. 逐项检测清单：8 项优化的存在性证明

以下命令在**仓库根目录**执行，全部只读。每项给出「grep 证据」与「定向测试」两级验证；grep 全中即可认为该项在，测试用于合并后回归或存疑时确认。行号以集成分支 tip `5d8d6f2` 为准，仅作参考（后续提交会漂移）。

### 任务 1 —— 写路径不再清空客户端池（`opt-write-refresh`）

```bash
rg -n 'refreshAfterConfigWrite|refreshAfterServiceWrite|refreshAfterInstanceChange' src/extension.ts
# 应有：三个函数定义（约 190/193/203 行）+ 各回调调用点
rg -c 'clientPool\.clear\(\)' src/extension.ts        # 应恰好输出 2
rg -n 'refreshTreeViews' src/extension.ts             # 应无输出（旧函数已删除）
npx vitest run test/extension/WriteCommands.test.ts -t 'client pool survival'
```

### 任务 2 —— Ctrl+S 只存草稿不发布（`opt-save-draft`）

```bash
rg -n 'setStatusBarMessage' src/extension.ts          # saveDocumentListener 里（约 822 行）
rg -n 'inFlightPublish' src/extension.ts              # 应无输出
rg -n 'Draft saved locally' l10n/bundle.l10n.zh-cn.json   # 应有该 key 的中文翻译
rg -n '__getStatusBarMessages' test-fixtures/vscode.ts    # fixture 已补
npx vitest run test/extension/WriteCommands.test.ts -t 'does not trigger publishConfig when a dirty draft document is saved'
```

### 任务 3 —— 实例表单保留输入（`opt-form-state`）

```bash
ls webview/nacos-instance-form/state.ts               # 文件存在（DOM-free 状态模块）
rg -n 'readSavedInstanceFormState' webview/nacos-instance-form/state.ts webview/nacos-instance-form/index.ts
rg -n 'retainContextWhenHidden: true' src/webview/NacosInstanceFormPanel.ts   # 约 116 行
npx vitest run test/webview/NacosInstanceFormPanel.test.ts -t 'readSavedInstanceFormState'
```

### 任务 4 —— 新建配置命令（`opt-create-config`）

```bash
rg -n '"atNacos\.createConfig"' package.json          # commands + commandPalette(when:false) + view/item/context 三处
rg -n 'configTypeForDataId' src/nacos/driver/configLanguage.ts   # 约 89 行，反向后缀→Nacos type
rg -n 'createNew' src/document/openDraftDocument.ts   # options 字段 + emptyDetail/fetchDetailOrEmpty
rg -n 'askForNewConfigRef' src/extension.ts
npx vitest run test/document/openDraftDocument.test.ts test/nacos/driver/configLanguage.test.ts
```

### 任务 5 —— README 诚实化 + MCP 卸载 + 安装三态（`opt-readme-mcp`）

```bash
rg -n '"atNacos\.uninstallMcpConfig"' package.json
rg -n 'uninstallAtSeriesConfigForCurrentIde' src/extension.ts    # import 且真的被调用
rg -n 'AK/SK 签名鉴权\*\*尚未实现\*\*' README.md      # README 第 15 行不再虚假承诺
rg -n '卸载 MCP 配置' README.md                       # 第 99 行提及卸载命令
ls test/extension/McpConfigCommands.test.ts           # 新测试文件存在（9 条用例）
npx vitest run test/extension/McpConfigCommands.test.ts
```

### 任务 6 —— 实例节点右键菜单（`opt-instance-menu`）

```bash
rg -n '"atNacos\.(editInstance|deleteInstance)"' package.json
rg -n 'viewItem =~ /\^atNacos\\\\\.instance' package.json   # 实例节点 when 正则（\b 让 .readonly 也命中）
rg -n "'atNacos\.(editInstance|deleteInstance)'" src/extension.ts
# 注意：registerCommand( 与命令 id 字符串分行，别用单行 registerCommand\('atNacos\.edit...' 之类的模式去匹配
npx vitest run test/extension/InstanceCommands.test.ts test/extension/ClusterStatusCommand.test.ts
```

### 任务 7 —— 服务树按名过滤（`opt-service-filter`）

```bash
rg -n '"atNacos\.(filterServices|clearServiceFilter)"' package.json
rg -n 'attachTreeView|setFilter|clearFilter' src/tree/ServiceTreeProvider.ts
rg -n 'serviceName: this\.filterText' src/tree/ServiceTreeProvider.ts   # 约 343 行，原样透传给驱动
rg -n 'serviceTreeProvider\.attachTreeView' src/extension.ts
npx vitest run test/tree/ServiceTreeProvider.test.ts -t 'filter'
```

### 任务 8 —— MCP 集群并行 + 非交互证书校验（`opt-mcp-cluster-cert`）

```bash
rg -n 'Promise\.all' src/agent/NacosAgentToolService.ts          # getClusterNodes 里（约 363 行）
rg -n 'certVerifier\?: NacosCertVerifier' src/extension.ts       # createNacosClient 第 5 个可选参数
rg -n 'createClient: \(instance, certVerifier\)' src/extension.ts # MCP 工厂转发校验器，不走 UI 池
npx vitest run test/agent/NacosAgentToolService.test.ts -t 'cluster'
```

### 全局记账（合并质量的一票否决项）

```bash
rg -n 'twenty-seven commands|toHaveLength\(36\)' test/extension/ExtensionLifecycle.test.ts
# 两行都在 = 27 命令 / 36 subscriptions 的终态记账正确
```

---

## 3. 单项分支映射表（SHA 已于 2026-08-27 用 `git ls-remote origin` 核实）

只缺个别项时，从对应分支 cherry-pick（都基于 `c4cc4bf` = 当前 origin/main tip，落到同基线的工作分支上通常干净；落到已含其他项的分支上会遇到 §1.3 的 4 个文件冲突，同样按并集解）：

| Phase 0 任务 | 单项分支 | tip SHA | 功能提交（若 tip 非功能提交） |
|---|---|---|---|
| 任务 1 写路径不清池 | `cursor/opt-write-refresh-6a9b` | `f46fea48c8723eec358e40e10293e210f6ad6275` | — |
| 任务 2 保存≠发布 | `cursor/opt-save-draft-6a9b` | `27bc67f335feac1d82d387a235828c9111f64d7b` | — |
| 任务 3 表单保留输入 | `cursor/opt-form-state-6a9b` | `6cbe99c1fe247fca6f5a45e4cee90f4c754920de` | — |
| 任务 4 新建配置 | `cursor/opt-create-config-6a9b` | `a5701da381a4d96c1e6edde93d50db7e84932605` | — |
| 任务 5 README + MCP 卸载 | `cursor/opt-readme-mcp-6a9b` | `593e68d5bf8c8b40451abb83e346aca6d60caa16` | 含父提交 `eccc002`（README 修正）；cherry-pick 需两个都拿：`git cherry-pick eccc002 593e68d` |
| 任务 6 实例节点菜单 | `cursor/opt-instance-menu-6a9b` | `0a678cb6d24a070dd53720a1929a4e7afde1383c` | tip 是 chore（清理误提交的 node_modules 符号链接）；功能在父提交 `2bb58ff`。cherry-pick 建议两个都拿 |
| 任务 7 服务过滤 | `cursor/opt-service-filter-6a9b` | `3f70deacac7fc7564bcf56b4f6c35842d7bcc20d` | — |
| 任务 8 MCP 并行+证书 | `cursor/opt-mcp-cluster-cert-6a9b` | `ae986f6609ec50640a4cc7568d38348e2e4e9775` | — |
| **集成分支（1–8 全部）** | `cursor/nacos-opt-1-8-6a9b` | `5d8d6f2950f420b4ac1eaea7b1e53e6c0c1871db` | 见 §1.1 拓扑 |

存在性自查（任何时候先跑这个再引用上表）：

```bash
git ls-remote origin 'refs/heads/cursor/opt-*-6a9b' 'refs/heads/cursor/nacos-opt-1-8-6a9b'
# 输出应含上表 9 行；SHA 若与表中不同，以 ls-remote 实测为准并更新本表
```

> 逐项 cherry-pick 时的记账提醒：每项分支各自基于「main 的 21 命令 / 30 subscriptions」记账，叠加多项时 `ExtensionLifecycle.test.ts` 的数组与 `toHaveLength` 必须**手工合成累计值**（终态 27/36），不能接受任何单分支侧的原值。这正是 §1.3 表里该文件反复冲突的原因。

---

## 4. 验收标准

```bash
npm run typecheck && npm test
```

- **typecheck**：exit 0，零错误。
- **test**：**1980 passed / 33 skipped，共 2013**（71 个测试文件通过 + `test/live/liveServer.test.ts` 整文件 33 条跳过——live 测试靠环境变量门控，本地无真实 Nacos 时跳过是预期行为）。
- 该数字为 2026-08-27 在集成分支 tip `5d8d6f2` 的干净 worktree 上实跑结果（全程约 6 秒，很便宜，**直接跑就行**，不必找文档旁证）。若你的工作分支在合并前已含其他测试改动，passed 数会相应更多——关键判据是**零 failed**，且 §2 各项的定向测试全绿。
- 顺手跑 `npm run build` 确认 esbuild 产物正常（任务 3 引入的 `webview/nacos-instance-form/state.ts` 会被打进 `dist/webview/nacos-instance-form.js`）。

---

## 5. 合并之后做什么

1. **不要再做 Phase 0 的 checkbox。** [Phase 0 文档](./2026-08-27-followup-phase-0-prereq.md) 的逐步实现区仅供「合并路径不可用」时使用；合并成功后整份视为完成，可在其顶部 Status 标注「已通过合并 `cursor/nacos-opt-1-8-6a9b`（`5d8d6f2`）落地」。
2. commit 合并结果并 push 工作分支，然后打开 [Phase A](./2026-08-27-followup-phase-A-ui.md) 从 A1 开始。注意 Phase A 的 A1（README 项）与 Phase 0 任务 5 已部分重叠，做 A1 时按已完成部分裁剪。
3. [总入口 agent-guide](./2026-08-27-followup-agent-guide.md) §1 的跳过判据就是本文开头那四个命令：`atNacos.createConfig`、`atNacos.filterServices`、`atNacos.uninstallMcpConfig`、`atNacos.editInstance` 全部出现在 `package.json` 即视为 Phase 0 完成。合并后请自查一次，四者应全部存在（外加 `atNacos.deleteInstance` 与 `atNacos.clearServiceFilter`，共 27 条命令）。

---

## 6. 禁止事项（合并与解冲突时最容易犯的错）

- **不要重新引入 publish-on-save。** 任何形态都不行：不加 `atNacos.publishOnSave` 命令，不加设置项，不在 `saveDocumentListener` 里恢复 `publishConfig` 调用。`inFlightPublish` 这个标识符在终态代码里不存在——解冲突时看见它出现在「theirs/ours」任何一侧的旧代码里，删。
- **不要在服务树的 `listServices` 里传 `group`。** 服务树的分组层是由已加载页反推的，传 `group` 会毁掉这套机制（MCP 工具层已暴露该参数，那是另一条路径，别混淆）。任务 7 只透传 `serviceName`，终态是 `listServices({ namespaceId, pageNo, pageSize, serviceName: this.filterText })`——没有 `group`。
- **不要在写操作成功后清空整个客户端池。** `clientPool.clear()` 只允许出现在两个显式刷新命令（`atNacos.refreshConfigs` / `atNacos.refreshServices`）里，全文件恰好 2 处。解冲突时若发现某个 `onPublished`/`onDeleted`/`onRollback`/`onUpdated` 回调又调了 `clear()` 或复活了 `refreshTreeViews`，那是把任务 1 合丢了。实例删除用 `clientPool.evict(instanceId)`（经 `refreshAfterInstanceChange`），不是 `clear()`。
- 另外两个次级雷区：MCP 工厂**不要**改回 `getOrCreateClient`（会把交互式证书弹窗漏给后台 MCP 调用，任务 8 修的就是它）；实例表单的 `setState` 状态**只**存在 webview 侧，不要把含密码的 payload postMessage 给插件宿主。

---

## 附：本文所有已核实事实的核实方式（2026-08-27）

- 9 个分支 tip SHA：`git ls-remote origin` 实测（§3 表）。
- 集成分支拓扑与合并顺序：`git log --first-parent --oneline 5d8d6f2`。
- 1980/33 测试数与 typecheck：在 `5d8d6f2` 的临时 worktree 上实跑 `npx vitest run`（5.5 秒）与 `npx tsc --noEmit`（exit 0）。
- §2 全部 grep 锚点：逐条在 `git show 5d8d6f2:<file>` 上验证命中。
- 「合并到文档分支零冲突」：`git merge-tree --write-tree HEAD 5d8d6f2` exit 0 实测（HEAD = `c867424`）。
