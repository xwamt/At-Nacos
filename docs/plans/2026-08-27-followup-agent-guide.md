# AT Nacos 后续完善 —— Agent 执行总入口

> **给后续实现 Agent 的第一份该读的文档。** 先读完本节再打开具体 Phase。不要同时开多个 Phase。不要在 `main` 上改代码。
>
> **For agentic workers:** 一次只做一个 Task。TDD（先红后绿）。每完成一个 Task：勾 checkbox、跑 `npm run typecheck && npm test`、单独 commit。模型与分支策略由仓库当前约定决定；实现时严格按对应 Phase 文档的文件路径、when 子句、`t()` 原文和测试名动手，不要凭记忆发明接口。

---

## 0. 文档地图

| 文档 | 用途 | 何时打开 |
|---|---|---|
| **本文** | 顺序、依赖、跳过规则、禁止项 | 永远先读 |
| [现状分析](./2026-08-27-analysis.md) | 1–8 优化批次的问题分析原文 | 需要理解「为什么改」时（文件可能尚未提交） |
| [代码库地图](./2026-08-27-followup-codebase-map.md) | 模块/文件/测试的定位索引 | 找不到某段代码在哪时 |
| [后续建议总表](./2026-08-27-followup-roadmap.md) | 模块评分与「做什么/不做什么」 | 需要产品上下文时 |
| [Phase 0](./2026-08-27-followup-phase-0-prereq.md) | 1–8 体验/性能前置批次，逐步 checkbox | `package.json` 还没有 `atNacos.createConfig` 时 |
| [Phase 0 合入指南](./2026-08-27-followup-phase-0-merge-guide.md) | 检测/合并/跳过 Phase 0，含分支 SHA 与逐项 grep 清单 | 打开 Phase 0 之前**必读**——多数情况直接 merge，无需重写 |
| [Phase A](./2026-08-27-followup-phase-A-ui.md) | 把已有 Driver 接到 UI | Phase 0 完成后 |
| [Phase B](./2026-08-27-followup-phase-B-engineering.md) | 设置项与工程债 | Phase 0 完成后；可与 A 分 PR 并行（注意 `extension.ts`） |
| [Phase C](./2026-08-27-followup-phase-C-writes.md) | 驱动写能力加宽（四 flavor 齐改） | Phase 0 + A7 服务详情建议已合入 |
| [Phase D](./2026-08-27-followup-phase-D-high-risk.md) | AK/SK、MCP 写工具等；**每个 Task 单独 PR** | C 的相关语义合入后再开 D2 |
| [架构真源](./2026-08-13-at-nacos-architecture.md) | API 方言、410/404、鉴权、能力矩阵 | 任何驱动改动 |
| [M5 写路径](./2026-08-14-at-nacos-m5-write.md) | 草稿、confirmWrite、整行回写 | Phase C |
| [MCP 官方对齐](./2026-08-20-nacos-mcp-official-alignment.md) | 13 只读工具边界 | Phase D2 之前必读 |

规格冲突时：**架构文档 > 对应 Phase 计划 > 本总入口 > 路线图一句话。**

---

## 1. 开工前检查清单

```bash
git branch --show-current   # 不得为 main
git fetch origin
```

- [ ] 当前不在 `main`。从 `main` 或已合入前置的集成分支出 `cursor/<descriptive-name>-****`。
- [ ] `npm install && npm run typecheck && npm test` 基线全绿。记下用例数（README / A1 要用真实数字）。
- [ ] 打开 `package.json` 的 `contributes.commands`：
  - **没有** `atNacos.createConfig` / `atNacos.filterServices` / `atNacos.uninstallMcpConfig` / `atNacos.editInstance` → 先做 **Phase 0**。
  - **四者都有** → Phase 0 整份跳过，从 **Phase A** 起。
- [ ] 若 `git ls-remote origin cursor/nacos-opt-1-8-6a9b` 有结果：Phase 0 **优先 merge/cherry-pick 该分支**，不要按 Phase 0 逐步重写。合入后 `npm test` 全绿再进 A。

---

## 2. 推荐执行顺序

```
Phase 0（或 merge cursor/nacos-opt-1-8-6a9b）
    │
    ├─► Phase A（A1–A5 文案/正确性 → A6–A8 面板 → 其余）
    │
    └─► Phase B（B2 正确性 → B1 设置 → B7/B8 静默丢数据 → 其余）
            │     A 与 B 可分 PR；双方都改 extension.ts / package.json 时串行合并
            ▼
        Phase C（C1 权重 → C2 克隆 → C3 命名空间 → C4 标签 → C5 CAS → C6 删空服务）
            │
            ▼
        Phase D（D1、D2、D3、D4、D5 **各一个 PR**，禁止捆绑）
```

同一时刻一个 Agent 只认**一份** Phase 文档为任务列表。做完一个 Task 再打开下一个。

---

## 3. 每个 Task 的固定作业

1. 在对应 Phase 文档里找到该 Task 的「现状 / 涉及文件 / checkbox / 测试 / i18n / Done when」。
2. **先改或先写测试**，跑指定 `npx vitest run <file>`，确认失败原因符合预期。
3. 按 checkbox 改代码。用户可见字符串一律 `t('English source')`，并写入 `l10n/bundle.l10n.zh-cn.json`；命令标题走 `package.nls.json` + `package.nls.zh-cn.json`。
4. 若新增 `registerCommand` 并 `context.subscriptions.push`：同步改 `test/extension/ExtensionLifecycle.test.ts` 的**完整排序命令数组**和 `toHaveLength(N)`（以及注释里的英文数字）。公式与累计值写在 Phase 0 §记账表、Phase A §0.3。
5. `npm run typecheck && npm test`。
6. 勾 checkbox，commit（message 带 Task 编号，如 `A4: retry error tree node`）。
7. 不要顺手做 Non-goals 或其它 Phase。

---

## 4. 全局禁止（所有 Phase 共用）

- 在 `main` 上直接提交。
- `atNacos.publishOnSave` 或把 Ctrl+S 重新接到发布。
- 用户 / 角色 / 权限管理 UI。
- 集群节点下线、Raft 干预。
- 服务树 `listServices` 传 `group`（会毁掉由列表反推的分组层；MCP 已暴露该参数）。
- 把命名空间删除或配置删除做成默认开启的 MCP 工具。
- 实现未完成前在实例表单放出 AK/SK 选项（`createAuthStrategy` 的 throw 是保护）。
- 假装 VS Code 已自动装好 MCP 配置（Hub 无 `vscode` target 时必须诚实失败）。

---

## 5. 实现时最容易踩的仓库约定

- **参数名传错 = 空列表，不是报错。** 用 `namespaceParamName` / `groupParamName` / `configTagsParamName`，不要手写 `tenant`/`groupName`。
- **Nacos 改实例是整行覆盖。** 任何实例写（上下线、改权重）必须先 `listInstances` 再提交完整行，确认框展示将写入的整行。
- **发布是 form body，删除是 query。** 见 `writes.ts`。
- **只读双层：** `contextValue` 后缀隐藏菜单 + `assertWritable`。MCP 路径没有菜单，必须在 agent 层自查。
- **`src/nacos/**`、`src/mcp/**`、`src/agent/**` 不 import `vscode`。** 证书弹窗、通知、`t()` 的 UI 适配放在现有边界。
- **1.x/2.x 默认命名空间 id 是 `''`，3.x 是 `public`，不要互代。**
- **l10n JSON 不能靠 `JSON.parse` 查重复键**（后键覆盖前键）。改 bundle 时跑 Phase A2 的重复键扫描测试。
- **`nodeMenu()` 假定每个命令在 `view/item/context` 只有一条。** 多节点共用同一命令时用一条 `when` 里的 `||`，不要贡献两条。

---

## 6. 完成后如何声明

对应 Phase 文档顶部 Status 改为「已在分支 `<name>` 落地」，并在本仓库 CHANGELOG 写用户可见变化。不要改架构文档里已验证的 API 事实，除非真机推翻并同步 §14。
