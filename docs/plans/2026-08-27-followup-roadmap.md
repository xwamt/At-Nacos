# AT Nacos 后续完善建议（v0.1.2 之后）

> **Status:** 分析文档。基于 1–8 项体验/性能优化落地后的代码（1980 通过 / 33 live 跳过）。
>
> **范围：** 这是初始版本。驱动层明显领先 UI。下文不再重复已完成项（写路径不清池、Ctrl+S 不发布、表单保活、新建配置、MCP 卸载与诚实提示、实例右键、服务过滤、MCP 并行拉集群 + 非交互证书）。
>
> **原则：** 按依赖分组，不按日历估时。IDE 插件只做日常开发/排障；用户权限、集群写运维、大规模 zip 同步留给控制台。

---

## 当前模块完整度（1–8 之后）

| 模块 | 分 | 一句话 |
|---|---|---|
| MCP 只读 | 90 | 13 工具对齐官方且有超集；描述有 2 处比实现更诚实 |
| 集群监控 | 85 | 面板完整；3.x Console 无 metrics 已降级 |
| 实例连接 / 鉴权 | 78 | 三种模式 + TOFU + 只读；AK/SK 仅 schema 占位并 throw |
| 配置 CRUD | 75 | 新建/编辑/发布/删除/回滚齐；缺克隆、标签、灰度、导入导出 |
| 监听 / 订阅 | 70 | 正向面板有；按 IP 反查仅 MCP |
| 文档诚实度 | 65 | AK/SK 已勘误；TOML、MD5、覆盖率、测试数仍失实 |
| 历史对比 | 62 | 固定 100 条、只能对当前；任意两版本互比未做 |
| 服务运维 | 58 | 上下线 + 过滤有；详情/权重/ephemeral 未画出来 |
| 命名空间 | 25 | 只读列出 |
| 用户设置 | 5 | 无 `contributes.configuration` |

---

## 明确不做 / 留给控制台

- 用户 / 角色 / 权限管理
- 集群节点下线、Raft 干预等写操作
- 大规模 zip 跨集群同步（nacos-sync 类）
- 服务器 `application.properties` 级配置
- `publishOnSave` 设置（与「保存 ≠ 发布」冲突）
- 服务树按 group 查询（会毁掉由列表反推的分组层级；MCP 已暴露）

---

## 里程碑 A — 把已有驱动能力接到 UI（几乎零新 API）

驱动里已经实现、界面还没有的，优先做。风险最低、完整度提升最明显。

| ID | 项 | 做法 | 优先级 |
|---|---|---|---|
| A1 | README 诚实性 | 去掉 TOML 声明或补映射；MD5 改为「发布前重拉全文比对」；删「100% 覆盖率」；测试数改为可复现；3.x 标「社区验证中」 | P0 |
| A2 | l10n 重复键 | `Version` 被后键覆盖，集群表列头错成「版本号」；加 CI 查重复键 | P0 |
| A3 | `publishConfig` 命令面板 | `when` 改为 `resourceScheme == nacos-draft`（无参路径已实现） | P0 |
| A4 | 错误节点「重试」 | `viewItem == atNacos.error` 内联菜单；勿强迫用户点全树 Refresh | P0 |
| A5 | 连接测试失败中文化 | 按 `NacosConnectionTestFailure.reason` 套模板（字段已齐） | P0 |
| A6 | 历史翻页 + 任意两版本互比 | `pageNo` 驱动已有；`vscode.diff(historyUri(a), historyUri(b))` | P0 |
| A7 | 服务详情面板 | 复用 `getService` + 现有 webview 骨架；展示保护阈值 / metadata / 健康检查 / ephemeral | P0 |
| A8 | 按 IP 反查监听 | MCP `nacos_list_listened_configs` 已通；命令 + 复用监听者表格 | P1 |
| A9 | 标题栏瘦身 | `setContext` 控制「清除过滤」显隐；集群/管理进溢出菜单 | P1 |
| A10 | 集群 CPU/内存显示为百分比 | `formatNumber` 对比率列单独格式化 | P1 |
| A11 | 只读在深层节点可见 | 配置 tooltip 追加「所属连接为只读」 | P1 |
| A12 | 术语：「连接」vs「服务实例」 | 连接侧改称「连接/服务器」，避免三义「实例」 | P1 |
| A13 | webview `lang` | `vscode.env.language` 注入，勿写死 `en` | P2 |
| A14 | 覆盖率脚本 | `@vitest/coverage-v8` + 改 README 为真实数字 | P2 |

---

## 里程碑 B — 设置项与工程债（quick win 为主）

| ID | 项 | 做法 | 优先级 |
|---|---|---|---|
| B1 | `contributes.configuration` | 至少 `atNacos.request.timeoutMs`（HttpClient 已有 seam）；其次页大小。变更时清池 | P0 |
| B2 | Bridge 请求体 `Buffer.concat` | 禁止按 chunk `toString('utf8')`，避免中文跨包损坏 | P0 |
| B3 | GET 在 keep-alive `ECONNRESET` 上重试一次 | 仅幂等读；写操作不重试 | P1 |
| B4 | 文档 provider 短 TTL 缓存 | 跨环境比对现读 3 次；`refresh()` 已有失效钩子 | P1 |
| B5 | 全部列表默认 `maxResponseBytes` | 配置列表已有 cap；其余端点无上限 | P1 |
| B6 | MCP 独立客户端池 | 每次工具调用现新建（login+probe）；勿与 UI 交互式池混用，另开非交互池 | P1 |
| B7 | 3.x 实例/订阅者 >100 静默截断 | 循环翻页或返回 `truncated`；MCP 描述必须写明 | P1 |
| B8 | `nacos_get_cluster_nodes` 勿吞 nodes 错误 | 与面板一样带 `nodesError`/`metricsError` | P1 |
| B9 | 脏草稿可发现 | 关闭未发布 tab 后草稿仍在内存但无入口；至少「丢弃/列出草稿」 | P2 |
| B10 | 文档 provider 刷新改 postMessage | 现整页 `webview.html` 赋值，滚动与 raft 展开丢失 | P2 |
| B11 | GitHub Actions + 容器跑 live | 当前 `.github/workflows` 不存在；33 个 live 用例常年 skip | P2 |
| B12 | VS Code 原生 MCP 安装 | Hub 仅 cursor/kiro/continue；VS Code 1.102+ 有 `mcp.json`（需上游 target） | P2 |

---

## 里程碑 C — 驱动写能力加宽（四 flavor 一次齐改）

| ID | 项 | 做法 | 优先级 |
|---|---|---|---|
| C1 | 实例权重 / 元数据编辑 | `updateInstanceHealthAt` 已整行回写；写前必须重拉实例，确认框展示将写入的完整行 | P0 |
| C2 | 配置克隆 / 跨环境复制 | 复用 `compareAcrossEnvironments` 选择器 + 现有 `publishConfig` | P1 |
| C3 | 命名空间 CRUD | 驱动新增三方法；删除仅空命名空间 + 模态；MCP 最后或不做 | P1 |
| C4 | description / appName / tags | 详情已归一化、发布已透传但 UI 不能改；补 `config_tags` 参数 | P1 |
| C5 | CAS 发布 `casMd5` | 缩小确认→发布 TOCTOU；v1 降级为发布前再读 | P2 |
| C6 | 删除空服务 | 轻量；非空留给控制台 | P2 |

---

## 里程碑 D — 高风险 / 外部依赖

| ID | 项 | 注意 |
|---|---|---|
| D1 | AK/SK（MSE） | 现有 `NacosAuthStrategy.authHeaders()` 无请求上下文；配置/命名签名方言不同。过渡期文档指路 userPassword/customHeader |
| D2 | MCP 写工具 | 官方仍只读。建议双闸：`allowAgentWrites`（默认 false）+ `risk:'write'`；无实例 opt-in 则不进 catalog。第一批：`nacos_publish_config`、`nacos_set_instance_enabled`。删除/命名空间删除延后。须同步改 skill「MCP 只读」措辞 |
| D3 | 灰度 / Beta | 1.x betaIps vs 3.x gray 语义分裂大；可读侧可先于写侧 |
| D4 | 导入导出 zip | 控制台半官方接口，跨版本差；可先做「单配置另存为」 |
| D5 | mcp-hub 拆分子路径 | js-yaml/semver 被 CJS 整包打进 `extension.js` |

---

## 建议实施顺序（给后续 Agent）

1. **A1–A5 + B2**：文案/正确性，改动面小，立刻提升信任感。
2. **A6–A8 + B1 + B7–B8**：把躺在 Driver 里的能力画出来，并堵住静默丢数据。
3. **C1–C4**：一次加宽写接口，TypeScript 强制四驱动对齐。
4. **D1 / D2**：单独计划、真机验证；不要和 UI 补齐混在同一 PR。

### 给人（IDE）下一步

服务详情 → 按 IP 反查 → 历史互比 → 命名空间新建/删除 → 权重编辑 → 克隆到其他环境。

### 给 Agent（MCP）下一步

先修描述/截断/吞错，再考虑双闸写工具；灰度读、命名空间删除不要进 MCP。
