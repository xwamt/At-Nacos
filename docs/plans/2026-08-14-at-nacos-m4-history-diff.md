# AT Nacos M4 —— 配置历史、diff 与「谁在用」 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 查看一条配置的历史版本、与任意历史版本或另一个环境做原生 diff、查看配置的监听者与服务的订阅者。

**Architecture:** 历史版本复用 M2 的虚拟文档层——历史内容是另一个 `nacos:` URI，diff 直接调 VS Code 的 `vscode.diff` 命令，不自己实现比对。「谁在用」是一个复用 M3 集群面板形态的自写 Webview。

**规格真源：** `docs/plans/2026-08-13-at-nacos-architecture.md` §6.6（历史字段的版本差异）、§9、§14。

---

## 本计划依据的真机事实（Nacos 2.3.2，2026-08-14）

**① 历史与监听者在这台服务器上都是空的。**

```
GET /v1/cs/history?search=accurate&dataId=application-dev.yml&group=cl-intimfy&tenant=cl-parent&pageNo=1&pageSize=3
  → {"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}
GET /v2/cs/history/list?...
  → {"code":0,"message":"success","data":{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}}
GET /v1/cs/configs/listener?dataId=...&group=...&tenant=...&sampleTime=1
  → {"collectStatus":200,"lisentersGroupkeyStatus":{}}
```

分页信封的形状确认了（v1 裸 Page、v2 包装），拼错的 `lisentersGroupkeyStatus` 也再次确认了，但**历史条目与监听者条目的字段名无法在这台机器上验证**。这一点必须写进 §14 而不是含糊过去。M5 发布配置后会产生历史记录，届时可以回来补验。

**② 订阅者有真实数据，形状与调研给的 3.x 不同。**

```json
{"subscribers":[{"addrStr":"192.168.99.92","agent":"Nacos-Java-Client:v2.3.2","app":"unknown",
  "ip":"192.168.99.92","port":0,"namespaceId":"cl-parent-offline",
  "serviceName":"cl-intimfy@@cl-auth-offline","cluster":""}],"count":1}
```

顶层是 `{subscribers, count}`，**不是** `pageItems`；`serviceName` 带 `group@@` 前缀（与实例响应一致）；`port` 是 0（gRPC 订阅者没有回调端口）；`cluster` 是空串。3.x 按调研是 `data.pageItems[]`，所以归一化要同时接受两种。

**③ 沿用已确认的历史接口陷阱**（架构文档 §6.6）：v1/v2 的时间字段是 ISO 字符串 `createdTime`/`lastModifiedTime`，3.x 是毫秒时间戳 `createTime`/`modifyTime`；`opType` **带尾随空格**（`"I "`、`"D "`），比较前必须 `trim()`；历史接口是唯一有 500 硬上限的分页接口。

---

## Task 1: 历史与「谁在用」的 driver 能力

**Files:** `src/nacos/driver/normalize.ts`、`NacosDriver.ts`、四个 driver、`NacosClient.ts`、`NacosCapabilityResolver.ts`

领域模型：

```ts
export interface NacosConfigHistoryEntry extends NacosConfigRef {
  /** 历史记录 id，取详情时作为 nid 传回。 */
  id: string;
  /** 'I' 插入 / 'U' 更新 / 'D' 删除。服务端带尾随空格，这里已 trim。 */
  opType: string;
  /** 归一成毫秒时间戳，无论服务端给的是 ISO 还是毫秒。 */
  modifiedAt?: number;
  srcIp?: string;
  srcUser?: string;
  appName?: string;
}

export interface NacosConfigListener {
  /** 监听方的地址。 */
  ip: string;
  /** 该监听方当前持有的 md5，与配置当前 md5 不同即为未同步。 */
  md5: string;
}

export interface NacosSubscriber {
  ip: string;
  port: number;
  /** 客户端标识，例如 Nacos-Java-Client:v2.3.2。 */
  agent?: string;
  app?: string;
  cluster?: string;
}
```

能力：`listConfigHistory` / `getConfigHistory` / `listConfigListeners` / `getService` / `listSubscribers`。

要点：

- **`getConfigHistory` 返回 `NacosConfigDetail`**，与 `getConfig` 同型——这样虚拟文档层无需区分「当前」和「历史」，diff 两侧走同一条渲染路径。
- **时间归一在 driver 里做完。** 上层不该知道某个版本给的是 ISO 还是毫秒。ISO 字符串用 `Date.parse`，失败留 `undefined` 而不是 `NaN`。
- **`opType` 必须 `trim()`。** 数据库 char 列填充，服务端所有版本都带尾随空格。
- **`pageSize` 在历史接口上钳到 500**，这是唯一有服务端硬上限的分页接口（源码 `Math.min(500, pageSize)`），客户端先钳一次可以让「为什么只回了 500 条」有个明确出处。
- **订阅者归一化同时接受 `{subscribers, count}`（v1/v2 真机确认）与 `data.pageItems[]`（3.x 调研）。** `serviceName` 里的 `group@@` 前缀要剥掉，复用 M3 已有的 `@@` 拆分逻辑（在**第一个** `@@` 处拆，不是 Nacos 自己的 `split()[1]`）。

**测试**：五个能力 × 四个 driver；ISO 与毫秒两种时间；带尾随空格的 `opType`；`pageSize` 钳位；订阅者的两种顶层形状；`serviceName` 的 `@@` 剥离；空历史与空监听者列表不报错。

---

## Task 2: 历史面板、diff 与跨环境对比

**Files:** `src/document/configUri.ts`（历史 URI）、`src/tree/NacosTreeItems.ts`、`src/webview/ConfigHistoryPanel.ts`、命令若干

### 历史版本的 URI

给 `nacos:` scheme 加一个历史变体，携带 `nid`。**沿用 M2 定下的规则**：每段 `encodeURIComponent`，空命名空间用 `$public` 哨兵（该哨兵不可能碰撞，因为 `encodeURIComponent` 会把 `$` 转义），instance id 放 path 首段而非 authority（authority 会被 `Uri.toString()` 转小写，而 VS Code 用该字符串索引文档）。

历史 URI 与当前版本 URI **必须不同**，否则 diff 两侧会指向同一个缓冲区。

### diff 靠 `vscode.diff`，不自己实现

```ts
await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
```

用户明确选择了「配置内容与 diff 走 VS Code 原生编辑器」，理由正是不必重造语法高亮与并排比对。

### 三个入口

1. **查看历史** —— 配置节点右键 → 打开历史面板（Webview，列出版本、操作类型、时间、来源 IP 与用户），点某一版 → 与当前版本 diff。
2. **与上一版对比** —— 配置节点右键，直接 diff 当前与最近一次历史。历史为空时给一条可读提示，不要弹空的 diff。
3. **跨环境对比** —— 配置节点右键 → 选目标实例 → 选目标命名空间 → diff。目标侧配置不存在时明确说「目标环境没有这条配置」，而不是显示一个空白右栏。

跨环境对比是用户在需求阶段选定的形态（单文件快速对比，非批量差异总览），别扩大范围。

### 历史面板与「谁在用」面板

两个面板都复用 M3 `ClusterStatusPanel` 建立的形态：扩展侧生成 body、`renderWebviewHtml(webview, asset, body, data)` 套 CSP 与 nonce、原生 TS 页面脚本、`var(--vscode-*)` 主题变量、消息处理抽成可测的独立函数、按实例去重的 `openPanels` map。

**M3 留下的一条建议：** 第三个面板到来时，应把 `openPanels` 从 `ClusterStatusPanel.ts` 提到共享的 `src/webview/openPanels.ts`。M4 有两个新面板，所以这次要做。

---

## Task 3: 组装、真机验收与 M4 收尾

- 命令：`atNacos.showConfigHistory` / `atNacos.diffWithPrevious` / `atNacos.compareAcrossEnvironments` / `atNacos.showConfigListeners` / `atNacos.showServiceSubscribers`
- 前三个挂配置节点的 `view/item/context`（`when: viewItem =~ /^atNacos\.config\b/`），`showServiceSubscribers` 挂服务节点
- 两个 nls 文件加命令标题；新运行时文案进 zh-cn 包
- esbuild 加新面板的 entry
- **真机验证**：订阅者可以验（`cl-auth-offline` 有一个）；历史与监听者**不能**验（服务器上是空的），必须在架构文档 §14 里写清楚
- 跨环境对比可以验：这台服务器有 11 个命名空间，`cl-parent` 与 `cl-parent-offline` 下有同名配置可对比

---

## M4 验收标准

- [ ] 配置节点能打开历史面板，列出版本（夹具验证；真机为空）
- [ ] 能与历史版本 diff，两侧内容正确、语法高亮正确
- [ ] 能跨环境 diff 同名配置（**真机验证**）
- [ ] 目标环境无此配置时给出明确提示而非空白栏
- [ ] 配置监听者可查（夹具验证）
- [ ] 服务订阅者可查（**真机验证**）
- [ ] `openPanels` 已提取为共享模块
- [ ] 架构文档 §14 记录历史与监听者未经真机验证及原因
