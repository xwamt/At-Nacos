# AT Nacos M3 —— 服务发现与集群状态 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 服务树展开到实例级别（命名空间 → 分组 → 服务 → 实例，带健康状态与权重），以及一个自写的集群状态面板（节点列表、UP/DOWN、版本、服务端指标）。

**Architecture:** 沿用 M2 的路子——`NacosDriver` 扩出 naming 与 cluster 能力，四个 driver 各自吸收版本差异；服务树复用 `NacosTreeBase` 的实例/命名空间两层；集群面板是一个 Webview，走 M1 建立的 `renderWebviewHtml` + `data` 注入 + nonce/CSP 那套，**不嵌浏览器**。

**规格真源：** `docs/plans/2026-08-13-at-nacos-architecture.md` §6.4–6.7（naming 响应的三种形状）、§9（能力矩阵）、§14（已验证与未验证清单）。

---

## 本计划依据的真机事实（Nacos 2.3.2，2026-08-14 抓取）

### 三条推翻调研的发现

**① `/v1/ns/operator/metrics` 默认只返回状态，必须显式传 `onlyStatus=false`。**

```
GET /v1/ns/operator/metrics                  → {"status":"UP"}
GET /v1/ns/operator/metrics?onlyStatus=false → {"status":"UP","serviceCount":13,"instanceCount":13,
   "subscribeCount":38,"responsibleInstanceCount":13,"clientCount":13,"connectionBasedClientCount":13,
   "ephemeralIpPortClientCount":0,"persistentIpPortClientCount":0,"responsibleClientCount":13,
   "cpu":0.09375,"load":5.72,"mem":1.0}
```

架构文档把「metrics 退化成只有 status」记成 3.2+ 的行为，**这是错的**——2.3.2 上就是如此，而且是参数默认值造成的，不是版本退化。集群面板必须传 `onlyStatus=false`。

> **② 这一条在 Task 1 实施时被推翻了，见架构文档 §14.5 ①。** 这台服务器有 13 个注册服务，全在分组 `cl-intimfy` 下（`cl-parent-offline` 12 个、`cl-taskcenter` 1 个）。下面这段之所以查不到，正是因为它用的 `/v1/ns/service/list` 把 `groupName` 默认成了 `DEFAULT_GROUP`——也就是本节 ③ 自己写下的那个陷阱。**服务树可以做真机验证**，Task 1 的 live 测试已经从命名空间走到实例。

**② 这台服务器上没有任何注册服务，但 metrics 报了 13 个。** 全部 11 个命名空间、多种 `groupName` 组合下 `/v1/ns/service/list`、`/v2/ns/service/list`、`/v1/ns/catalog/services` 一律返回 0。`/v2/ns/client/list` 显示 13 个连接，全部来自同一台 `192.168.99.92`，且 `ephemeralIpPortClientCount` 与 `persistentIpPortClientCount` 都是 0、`connectionBasedClientCount` 是 13——即它们是走 gRPC 的**配置**客户端，不是注册的服务实例。

~~**后果：服务树在本轮无法做端到端真机验证。**~~ 见上方修正。仍然成立的部分：多节点集群与非 UP 状态在这台单节点服务器上确实无法验证（架构文档 §14.5-19）。

**③ 集群节点接口可用，形状与调研一致。**

```json
{"code":200,"message":null,"data":[{"ip":"172.25.0.2","port":8848,"state":"UP",
 "extendInfo":{"lastRefreshTime":1754895077932,
   "raftMetaData":{"metaDataMap":{
     "naming_instance_metadata":{"leader":"172.25.0.2:7848","raftGroupMember":["172.25.0.2:7848"],"term":1},
     "naming_persistent_service_v2":{...},"naming_service_metadata":{...}}},
   "raftPort":"7848","readyToUpgrade":true,"version":"2.3.2"},
 "address":"172.25.0.2:8848","failAccessCnt":0,
 "abilities":{"remoteAbility":{"supportRemoteConnection":true,"grpcReportEnabled":true},...},
 "grpcReportEnabled":true}]}
```

v1 是 `code:200`，v2 `/v2/core/cluster/node/list` 是 `code:0`，`data` 内容逐字节相同。节点顶层字段共八个：`ip` `port` `state` `extendInfo` `address` `failAccessCnt` `abilities` `grpcReportEnabled`。`extendInfo.version` 是另一条版本探测路径。

### 沿用 M2 已确认的陷阱

- **参数名传错是静默失败**，返回空列表而非报错。naming 模块在 v1 上就用 `namespaceId`（与 config 模块的 `tenant` 不同），已有 `namespaceParamName(flavor, 'naming')` 覆盖。
- **v1 的集群参数叫 `clusters`（复数、逗号分隔），v2/v3 叫 `clusterName`（单数）。**
- **`/v1/ns/service/list` 的 `groupName` 默认是 `DEFAULT_GROUP`。** 服务注册在别的分组时会静默返回空。服务树必须显式处理分组，不能依赖默认值。

---

## 版本差异对照（实现时逐条核对，来源见架构文档 §6.5–6.7）

**服务列表的三种形状：**

| 版本 | 响应 |
|---|---|
| 1.x | `{"count":N,"doms":["name1",...]}` —— 字段叫 `doms`，只有服务名 |
| 2.x | `{"code":0,"data":{"count":N,"services":["name1",...]}}` |
| 3.x | `data.pageItems[]`，每项带 `clusterCount`/`ipCount`/`healthyInstanceCount`/`triggerFlag`/`groupName`/`name` |

**要在树里显示实例数与健康数，1.x/2.x 必须走 catalog** —— 标准 `service/list` 只给名字。catalog 顶层是 `{"count":N,"serviceList":[...]}`（真机已确认）。3.x 已把 catalog 语义并入标准接口。

**实例列表的三种形状：** v1/v2 是 `data.hosts[]`（外层 ServiceInfo）；v3 admin/client 是 `data[]`；v3 console 是 `data.pageItems[]`。

**服务详情：** 1.x 的 `clusters` 是数组、服务名字段叫 `name`；2.x/3.x 的 `clusterMap` 是对象、字段叫 `serviceName`。

---

## Task 1: naming 与 cluster 的 driver 能力

**Files:** `src/nacos/driver/normalize.ts`（新模型）、`NacosDriver.ts`、四个 driver、`NacosClient.ts`、`NacosCapabilityResolver.ts`（widen `NacosCapability`）

领域模型：

```ts
export interface NacosServiceRef { namespaceId: string; group: string; serviceName: string; }

export interface NacosServiceSummary extends NacosServiceRef {
  /** 1.x/2.x 的标准列表给不出这些，只有 catalog 或 3.x 才有。 */
  instanceCount?: number;
  healthyInstanceCount?: number;
  clusterCount?: number;
  triggerFlag?: boolean;
}

export interface NacosInstance {
  ip: string; port: number; healthy: boolean; enabled: boolean; weight: number;
  clusterName: string; ephemeral: boolean; instanceId?: string;
  metadata: Record<string, string>;
}

export interface NacosClusterNode {
  address: string; ip: string; port: number;
  /** STARTING | UP | SUSPICIOUS | DOWN | ISOLATION，五种，不是三种。 */
  state: string;
  version?: string; raftPort?: string; failAccessCnt?: number;
  raftGroups?: { group: string; leader: string; members: string[]; term: number }[];
}

export interface NacosServerMetrics {
  status: string;
  serviceCount?: number; instanceCount?: number; subscribeCount?: number;
  clientCount?: number; cpu?: number; load?: number; mem?: number;
}
```

能力：`listServices` / `listInstances` / `listClusterNodes` / `getServerMetrics`。**`getService` 与 `listSubscribers` 推迟到 M4** —— M3 的树用不到详情，订阅者与监听者是同一类「谁在用」的功能，放一起做更连贯。

要点：

- v1/v2 的 `listServices` **优先走 catalog**（能拿到实例数与健康数），catalog 失败再退回 `service/list`（只有名字，`instanceCount` 留 undefined）。这个降级在 driver 内部完成，不经 `NacosCapabilityResolver`——它是同一版本内的两个端点，不是跨版本降级。
- `getServerMetrics` 必须传 `onlyStatus=false`。
- `listClusterNodes` 的 `extendInfo.raftMetaData.metaDataMap` 要归一化成 `raftGroups` 数组，别把嵌套 map 泄漏给 UI。
- 归一化必须容忍 1.x 只给服务名：`normalizeServiceSummary` 接受字符串或对象两种输入。

**测试**：四个 driver × 每个能力；三种服务列表形状；三种实例列表形状；v1 `clusters` vs v2/v3 `clusterName` 的参数名；`onlyStatus=false` 确实发出；五种 `state` 取值；`raftMetaData` 归一化；1.x 服务名数组的降级路径。

---

## Task 2: 服务树

**Files:** `src/tree/NacosTreeItems.ts`、`src/tree/ServiceTreeProvider.ts`

层级：命名空间 → 分组 → 服务 → 实例。

- 与配置树一样，**分组从已加载的页推导**，`LoadMoreTreeItem` 挂命名空间下。
- 服务节点的 description 显示 `健康数/总数`（拿得到时），图标按健康比例变色：全健康 `$(pass)` 绿、部分 `$(warning)` 黄、全不健康 `$(error)` 红、未知 `$(circle-outline)`。用 `ThemeColor` 而非硬编码颜色。
- 实例节点显示 `ip:port`，description 显示权重与集群名，tooltip 显示 metadata。不健康实例用 `problemsErrorIcon.foreground`。
- 实例节点**没有 command**（M3 只读，无详情面板）。M5 的上下线操作会给它加 contextValue 菜单。
- `contextValue` 沿用 `.readonly` 后缀约定。

**测试**：四层展开；健康状态到图标/颜色的映射（含 0 实例与未知实例数两种边界）；实例的权重与集群名；分页；一个服务加载失败不影响同组其它服务；节点 id 在两棵树间不冲突。

---

## Task 3: 集群状态面板

**Files:** `src/webview/ClusterStatusPanel.ts`、`webview/nacos-cluster-status/{index.ts,index.css}`、`esbuild.config.mjs`（加 entry）

**这是用户明确要求「不要用浏览器、自己新写」的那类面板。** 沿用 M1 `NacosInstanceFormPanel` 建立的形态：扩展侧生成 body HTML，`renderWebviewHtml(webview, asset, body, data)` 套 CSP 与 nonce 并注入 JSON 数据块（`<` 已在 `renderJsonScript` 中转义），前端是 esbuild 打的原生 TS，样式全用 `var(--vscode-*)` 跟随主题。**不引任何前端框架。**

内容分两块：

1. **节点表** —— 地址、状态徽章（五种 state 各自配色）、版本、raft 端口、失败访问计数；展开一行显示该节点的 raft group 明细（组名、leader、成员、term）。
2. **服务端指标** —— status、服务数、实例数、订阅数、客户端数、CPU、load、内存。

面板要有刷新按钮，且**每实例一个面板**（按 instanceId 去重，同 M1 的 `openPanels` map）。数据为空或获取失败时渲染一条可读的说明，不留空白。

**测试**：消息处理抽成独立导出的纯函数（沿用 M1 约定，Panel 类只是薄 `static async open()`）；渲染函数对齐全/缺字段/空节点列表三种输入；HTML 转义（一个 `state` 为 `"><script>` 的节点不能逃逸）；五种 state 各自的样式类；刷新消息触发重新取数。

---

## Task 4: 组装与真机验收

- 注册 `atNacos.openClusterStatus` 命令，图标 `$(server)`，挂两个视图的 `view/title`
- `esbuild.config.mjs` 加第三个 entry
- 两个 nls 文件加命令标题；新运行时文案进 `l10n/bundle.l10n.zh-cn.json`
- **真机验证**：集群节点与指标可以在 `http://192.168.99.90:8848/nacos` 上跑通；**服务树不行**（这台服务器没有注册服务）。把这个缺口明确写进架构文档 §14 的未验证清单，不要含糊过去。

---

## M3 验收标准

- [x] 服务树展开到实例，健康状态一眼可见（~~夹具验证~~ **真机也验证了**：13 个服务、每个 1 个实例，`test/live` 从命名空间走到实例节点，见架构文档 §14.6）
- [x] 集群面板显示节点、状态、版本、raft 明细与服务端指标（**真机验证**：`172.25.0.2:8848` / `UP` / `2.3.2` / raftPort `7848` / 三个 raft 组 / 指标八项俱全，见 §14.7 ①）
- [x] 面板跟随 VS Code 主题，中英文均正确 —— 颜色全部走 `var(--vscode-*)`，每一条文案都有 zh-cn 键（由本地化用例逐条核对）。**但没有在扩展宿主里目视过**，深浅主题与中文排版见 §14.7 ㉓ ㉖
- [x] `getServerMetrics` 带 `onlyStatus=false`，真机返回完整指标
- [x] 架构文档 §14 记录「服务树未经真机验证」及原因 —— **这条的前提被推翻了**：服务树可以真机验证，而且已经验证（§14.5 ①）。真正记进未验证清单的是另外几件：多节点与非 UP 状态（§14.5 ⑲、§14.7 ㉔）、两棵树的分页（§14.4 ⑬、§14.6 ㉑）、面板从未在扩展宿主里渲染过（§14.7 ㉓）
