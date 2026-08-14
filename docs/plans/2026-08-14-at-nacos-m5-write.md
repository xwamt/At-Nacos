# AT Nacos M5 —— 写操作 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 在界面上发布配置、回滚到历史版本、上下线服务实例，每一步都经过 diff 预览与二次确认，只读实例彻底禁用写入。

**Architecture:** 写能力加进 `NacosDriver`；编辑走 VS Code 原生编辑器（可编辑的虚拟文档 + 显式发布），不是 Webview 表单；确认对话框统一走一个 `confirmWrite` 模块，任何写路径都不得绕过它。

**规格真源：** `docs/plans/2026-08-13-at-nacos-architecture.md`。

---

## 这个里程碑的安全边界（用户在需求阶段明确选定）

- **界面可写，MCP 工具只读。** M6 的 Agent 工具一条写操作都不会有。
- **发布前强制 diff 预览 + 二次确认。**
- **每实例一个「只读」开关**，标记为只读的实例在 UI 上彻底禁用写按钮。schema 里的 `readOnly` 字段和树节点 contextValue 上的 `.readonly` 后缀从 M1 就为此埋好了。

**这是本项目唯一会修改生产数据的里程碑。** 任何一处「先做了再说」的实现都可能让人误删一条配置。宁可多一次确认，不可少一次。

---

## Task 1: 写能力

**Files:** `src/nacos/driver/*`、`NacosClient.ts`、`NacosCapabilityResolver.ts`

能力：`publishConfig` / `deleteConfig` / `updateInstanceHealth`（上下线）。

路径与参数（架构文档 §9 未覆盖写操作，以下为各版本官方 OpenAPI）：

| flavor | publishConfig | deleteConfig |
|---|---|---|
| v1 | `POST /v1/cs/configs`（form: `dataId`,`group`,`tenant`,`content`,`type`） | `DELETE /v1/cs/configs?dataId=&group=&tenant=` |
| v2 | 同 v1（v2 的 `/v2/cs/config` 参数名不同且历史上有坑，统一走 v1） | 同 v1 |
| v3-admin | `POST /v3/admin/cs/config`（`groupName`/`namespaceId`） | `DELETE /v3/admin/cs/config?...` |
| v3-console | `POST /v3/console/cs/config` | `DELETE /v3/console/cs/config?...` |

实例上下线：v1 `PUT /v1/ns/instance`（form，含 `enabled`）；v3 `PUT /v3/admin/ns/instance`。

要点：

- **`publishConfig` 必须带 `type`**，否则 Nacos 会把配置类型重置成 `text`，语法高亮随之丢失。取当前配置的 `type` 传回去。
- **写请求走 `form`，不是 JSON body。** Nacos 的写接口全是 `@RequestParam`。
- **回滚不是一个独立接口。** 取历史版本内容，再以当前 dataId 发布一次——所以回滚天然产生一条新的历史记录，而不是抹掉中间版本。这一点要在确认对话框里讲清楚。
- **成功响应形状**：v1 返回纯文本 `true`；v2/v3 返回 `{"code":0,"data":true}`。两种都要判成功，且 `false` 要判失败（HTTP 200 + `false` 是 Nacos 报「没权限/被拒绝」的方式之一）。

**测试**：四个 driver × 三个能力；`type` 确实随发布带上；form 编码正确（含内容里有 `&`、`=`、换行、中文）；`true`/`false`/`{"code":0,"data":true}` 三种响应的判定；只读实例在 driver 层**不**做拦截（那是 UI 层的职责，driver 不该知道 UI 概念）。

---

## Task 2: 确认闸门与编辑流程

**Files:** `src/write/confirmWrite.ts`、`src/write/publishConfig.ts`、`src/document/`（可编辑文档）

### 唯一的确认闸门

```ts
export interface WriteConfirmation {
  /** 一句话说明将要发生什么，已本地化。 */
  summary: string;
  /** 二次确认按钮的文案，例如「发布」「删除」。 */
  confirmLabel: string;
  /** 有 diff 时先展示 diff，用户看完再回到确认框。 */
  diff?: { leftUri: vscode.Uri; rightUri: vscode.Uri; title: string };
}
```

`confirmWrite(confirmation): Promise<boolean>` 是**所有**写路径的唯一入口。用 `showWarningMessage({ modal: true })`——模态是有意的，非模态通知会被忽略。

**只读实例在这一层再挡一次。** UI 上按钮已隐藏，但命令仍可从命令面板或其它扩展调用，所以 `confirmWrite` 之前要有一个 `assertWritable(instance)`，只读实例直接拒绝并说明原因。两层防护不是冗余——隐藏按钮防手滑，断言防绕过。

### 编辑流程

配置内容目前是只读虚拟文档。M5 加一条「编辑」路径：

1. 用户在配置节点上选「编辑」
2. 把当前内容写进一个**可编辑**的虚拟文档（另一个 scheme 或同 scheme 加标记）
3. 用户改完按保存 → 拦截 `onWillSaveTextDocument` 或提供显式「发布」命令
4. 展示 diff（服务端当前内容 vs 编辑后内容）
5. 二次确认
6. 发布

**不要让编辑器的保存直接写服务端。** 用户按 Ctrl+S 的肌肉记忆不该等于「发布到生产」。显式的发布命令 + diff + 确认，三道关。

**发布前重新拉一次服务端内容。** 用户打开编辑器到点发布之间，别人可能改过。若服务端内容与打开时不同，要在确认框里指出「服务端已被他人修改」并把 diff 换成三方对比或至少提示冲突。

### 回滚

历史面板的每一行加一个「回滚到此版本」。确认框必须说明：**回滚是以旧内容发布一个新版本，不是删除中间版本。**

### 实例上下线

服务树的实例节点右键 → 上线/下线。确认框写明这会让 Nacos 停止/恢复把流量导向该实例。

---

## Task 3: 组装、只读验证与真机验收

- 命令全部挂 `view/item/context`，`when` 子句用 `viewItem` 不匹配 `.readonly` 后缀来隐藏写操作
- 一个「只读」实例的树节点上不得出现任何写命令——写测试断言这一点
- **真机验收要谨慎**：`http://192.168.99.90:8848/nacos` 是别人的开发环境。
  - **只在一个专用的临时命名空间里操作**，用完删掉
  - 不要碰 `cl-parent*`、`uat`、`damon`、`jack`、`solomon`、`cl-taskcenter` 这些已有命名空间里的任何配置
  - 发布 → 改一次 → 看历史 → 回滚 → 删除，全流程走一遍。**这会顺带把 M4 无法验证的历史行字段名验证掉**（架构文档 §14.8 item 27 记的就是这件事）
  - 实例上下线**不要在真机做**——那会影响别人正在用的服务

---

## M5 验收标准

- [x] 发布、回滚、删除均经过 diff + 模态确认
- [x] 只读实例的树节点上看不到任何写命令，且命令面板调用也被拒绝
- [x] 保存编辑器不会直接写服务端（基于内存草稿 FileSystemProvider，Ctrl+S 仅存本地草稿）
- [x] 发布前检测到服务端已被他人修改会提示并发冲突
- [x] 回滚的确认文案说明它产生新版本而非删除
- [x] 单元测试套件全量覆盖并通过（1771 passed）
