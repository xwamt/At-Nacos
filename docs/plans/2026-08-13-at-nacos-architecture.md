# AT Nacos 架构与决策文档

> 这是 `at-nacos-series` 插件的规格真源。每个里程碑计划都引用本文档，不重复其中的 API 表格与决策依据。
> 调研依据：Nacos 2.5.3 / 3.1.2 / 3.2.3 源码实读 + 官方文档，调研日期 2026-08-13。

---

## 1. 项目定位

在 VS Code / Cursor 中浏览与管理 Nacos 的配置中心与注册中心，并通过 AT Series MCP Hub 向 Agent 暴露只读查询能力。

隶属 AT Series 插件家族，与 `at-grafana-series`、`at-jumpserver-series`、`at-terminal-series` 共享同一套工程骨架与 MCP 接入方式。

## 2. 身份标识

| 项 | 值 | 约束来源 |
|---|---|---|
| 仓库目录 | `/Users/clkj/项目/at/at-nacos-series` | 必须与 `at-series-mcp-hub` 同级，否则 `file:../at-series-mcp-hub/packages/mcp-hub` 解析失败 |
| npm `name` | `at-nacos` | 系列约定 |
| `displayName` | `AT Nacos` | 系列约定 |
| `publisher` | `local` | 系列约定（侧载分发） |
| 命令/配置/状态前缀 | `atNacos.` | 系列约定 |
| activitybar 容器 id | `atNacos` | 系列约定 |
| MCP `pluginId` | `at.nacos` | 必须匹配 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`，否则 Hub 静默丢弃整条注册记录 |
| MCP 工具前缀 | `nacos_` | Hub 协议 §4.4 对新插件强制要求；工具名必须匹配 `^[a-z][a-z0-9_]*$` |
| `engines.vscode` | `^1.85.0` | 系列约定（Electron 25 / Node 18 / Chromium 114） |

## 3. 已确认的需求决策

| 维度 | 决定 |
|---|---|
| 服务端版本 | Nacos 1.x + 2.x + 3.x 全支持 |
| 鉴权 | 用户名密码 / 无鉴权 / 自定义请求头 / AK-SK（AK-SK 推迟到后期里程碑） |
| 功能面 | 配置列表与内容、配置历史与 diff、监听者、命名空间、服务与实例与订阅者、集群状态、跨环境对比 |
| UI 形态 | 混合：配置内容与 diff 用 VS Code 原生虚拟文档；列表、集群、服务看板用自写 Webview |
| 侧边栏 | 两棵树（配置 / 服务），命名空间作为树内一层；集群状态单独面板 |
| 读写边界 | VS Code 界面可写；MCP 工具全部只读 |
| 写护栏 | 发布前强制 diff 预览 + 二次确认；每实例「只读模式」开关 |
| 跨环境对比 | 右键单个配置 → 选目标实例/命名空间 → 打开原生 diff 编辑器 |
| TLS | 移植 Grafana 的 TOFU 指纹信任机制 |
| i18n | 完整中英双语；基础设施做成可移植到其他 AT 插件的形式 |
| MCP | 粗粒度约 7 个只读工具；读配置默认脱敏，`raw: true` 才出原文 |
| 版本适配 | 能力探测 + fallback 链，而非硬编码版本路径表 |
| 分页 | 树视图从一开始就做分页/懒加载 |
| 测试 | 严格 TDD，vitest |
| 交付 | 分里程碑，逐个验收 |

## 4. 三个颠覆性的服务端事实

这三条决定了架构形态，实现时必须时刻记住。

### 4.1 Nacos 3.2.0 起 v1/v2 API 已从发行包中物理删除

不是废弃、不是开关关闭，是代码移除，访问返回 **404**。唯二例外：

- `POST /nacos/v1/auth/login`（为老客户端保留，仍可用）
- `GET /nacos/v1/ns/operator/metrics`（退化成只返回 `{"status":"UP"}`）

要恢复需单独安装 `nacos-api-legacy-adapter` 插件 jar。

### 4.2 Nacos 3.0 / 3.1 默认拦截大部分 v1/v2 API，返回 HTTP 410

三个开关的默认值：

| 开关 | 默认值 | 控制范围 |
|---|---|---|
| `nacos.core.api.compatibility.client.enabled` | `true` | `ApiType.OPEN_API` 端点 |
| `nacos.core.api.compatibility.admin.enabled` | `false` | `ApiType.ADMIN_API` 端点 |
| `nacos.core.api.compatibility.console.enabled` | `false` | `ApiType.CONSOLE_API` 端点 |

被拦截时返回 **HTTP 410 Gone**。要命的是这个分类很反直觉——**配置列表查询、配置历史、命名空间列表、`/v1/console/server/state`、catalog、集群节点列表全部属于 CONSOLE_API 或 ADMIN_API，默认全部 410**；而「读单条配置内容」「实例列表」「服务名列表」属于 OPEN_API，默认可用。

3.0/3.1 上每个 v1 只读端点的分类：

| v1 端点 | ApiType | 3.0/3.1 默认 |
|---|---|---|
| `GET /v1/cs/configs`（取内容） | OPEN_API | 可用 |
| `GET /v1/cs/configs?show=all` | CONSOLE_API | 410 |
| `GET /v1/cs/configs?search=accurate\|blur` | CONSOLE_API | 410 |
| `GET /v1/cs/configs/listener` | CONSOLE_API | 410 |
| `GET /v1/cs/history*` | CONSOLE_API | 410 |
| `GET /v1/ns/instance/list` | OPEN_API | 可用 |
| `GET /v1/ns/service/list` | OPEN_API | 可用 |
| `GET /v1/ns/service`（详情） | ADMIN_API | 410 |
| `GET /v1/ns/service/subscribers` | ADMIN_API | 410 |
| `GET /v1/ns/catalog/*` | CONSOLE_API | 410 |
| `GET /v1/core/cluster/nodes` | CONSOLE_API | 410 |
| `GET /v1/console/server/state` | CONSOLE_API | 410 |
| `GET /v1/console/namespaces` | CONSOLE_API | 410 |
| `POST /v1/auth/login` | OPEN_API | 可用 |

**410 的 body 不可解析**：源码用 `response.sendError(410, json)`，会走 Spring Boot 错误页机制，实际 body 大概率是 `{"timestamp":...,"status":410,"error":"Gone","message":"<转义后的 JSON 字符串>","path":"..."}`。**只依赖 HTTP 410 状态码做降级判断，不要解析 body。**

### 4.3 Nacos 3.x 是双端口，且 Admin/Console API 默认强制鉴权

| | Server | Console |
|---|---|---|
| 端口 | 8848 | **8080** |
| context-path | `/nacos` | **空** |
| 路径前缀 | `/v3/admin/*`、`/v3/client/*`、`/v3/auth/*` | `/v3/console/*` |
| 鉴权开关 | `nacos.core.auth.admin.enabled`，默认 **true** | `nacos.core.auth.console.enabled`，默认 **true** |
| 权限要求 | 多数要求**管理员身份** | 多数只要求对应 namespace 的 read 权限 |

`nacos.core.auth.enabled` 默认 `false`，但它**只管 SDK/gRPC**。所以一台「没开鉴权」的 3.x 实例，`/v3/admin/*` 和 `/v3/console/*` 依然要求登录——与 2.x 的直觉完全相反。

**架构选择**：优先 Admin API（与 Server 同端口同 context-path，只需一个 base URL；`nacos.console.ui.enabled=false` 的部署下 console 可能没起；独立部署模式下 console 在另一台机器）。Admin API 因权限不足返回 403 时，降级到 Console API。

## 5. 核心架构：Driver 抽象

### 5.1 为什么不用「版本号 → 路径表」

同一个 2.4 可能开也可能关某些 API；3.x 默认关 v1 兼容但管理员能手动打开；3.2+ 装了 legacy-adapter 又能用 v1。纯版本映射会在真实环境里碎掉。

### 5.2 分层

```
NacosInstanceConfig (globalState)  +  凭据 (SecretStorage)
        │
        ▼
NacosAuthenticator            ← 4 种鉴权策略，token 缓存/刷新/403 重登
        │
        ▼
NacosHttpClient               ← node:http/https，TOFU，超时，错误分类
        │
        ▼
NacosDriver (interface)       ← 归一化的领域方法
   ├── V1Driver               ← /nacos/v1/*
   ├── V2Driver               ← /nacos/v2/* + v1 补位
   ├── V3AdminDriver          ← {server}/nacos/v3/admin/*
   └── V3ConsoleDriver        ← {console}/v3/console/*
        │
        ▼
NacosCapabilityResolver       ← 按能力选 driver，404/410/403 时沿链降级并缓存结果
        │
        ▼
NacosClient (门面)            ← 上层唯一入口
```

每个 driver 内部负责两件事：**参数名映射** 和 **响应归一化**。上层拿到的永远是统一的领域模型，不出现 `if (version === ...)`。

### 5.3 Driver 接口（M1 只实现 `probeState` 与 `listNamespaces`，其余里程碑逐步填充）

```ts
export interface NacosDriver {
  readonly flavor: NacosApiFlavor;
  probeState(): Promise<NacosServerState>;
  listNamespaces(): Promise<NacosNamespace[]>;
  listConfigs(query: ConfigListQuery): Promise<Paged<NacosConfigSummary>>;
  getConfig(ref: ConfigRef): Promise<NacosConfigDetail>;
  listConfigHistory(query: ConfigHistoryQuery): Promise<Paged<NacosConfigHistoryEntry>>;
  getConfigHistory(ref: ConfigHistoryRef): Promise<NacosConfigDetail>;
  listConfigListeners(ref: ConfigRef): Promise<NacosConfigListener[]>;
  listServices(query: ServiceListQuery): Promise<Paged<NacosServiceSummary>>;
  getService(ref: ServiceRef): Promise<NacosServiceDetail>;
  listInstances(ref: ServiceRef): Promise<NacosInstance[]>;
  listSubscribers(query: SubscriberQuery): Promise<Paged<NacosSubscriber>>;
  listClusterNodes(): Promise<NacosClusterNode[]>;
}

export type NacosApiFlavor = 'v1' | 'v2' | 'v3-admin' | 'v3-console';
```

### 5.4 降级判据（统一规则）

| 响应 | 含义 | 动作 |
|---|---|---|
| `404` | 该版本没有此端点 | 沿 fallback 链换下一个 driver |
| `410` | 3.0/3.1 兼容开关关闭 | 直接跳到 v3 driver |
| `403` | 鉴权失败或权限不足 | 先尝试重新登录并重试一次；仍 403 则从 v3-admin 降级到 v3-console |
| `401` | Nacos 自己从不返回 401 | 判定为前置反向代理/网关问题，提示用户 |
| `200` 但 `code` 非 `0`/`200` | 业务错误 | **不降级**，直接报错 |

能力探测结果按 `实例 id + 能力名` 缓存在内存中，避免每次请求都试错。

## 6. 参数名与响应形状的版本差异

这一节是实现 driver 时的对照表，写代码时必须逐条核对。

### 6.1 命名空间参数名（最经常写错的地方）

| 版本 | Config（CS）模块 | Naming（NS）模块 |
|---|---|---|
| 1.x | **`tenant`** | **`namespaceId`** |
| 2.x v1 端点 | `tenant` | `namespaceId` |
| 2.x v2 端点 | `namespaceId` | `namespaceId` |
| 3.x | `namespaceId` | `namespaceId` |

**1.x 的 config 接口用 `tenant`，同一版本的 naming 接口用 `namespaceId`。** 必须在 driver 层做映射函数，不要散落硬编码。

同理 `group` vs `groupName`：v1 config 用 `group`，v1 naming 用 `groupName`，v3 全部统一为 `groupName`。配置标签在 v1 是 `config_tags`（下划线），v3 是 `configTags`。

### 6.2 public 命名空间的表示

- 1.x / 2.x：public 的 id 是**空字符串** `""`。**不要传 `tenant=public`**，那会被当成一个名叫 "public" 的自定义命名空间，查出来是空的。
- 3.x：统一成字面量 `"public"`。传空串也能工作（有兼容层），但显式传 `public` 更安全。

### 6.3 响应包装形状

| 接口族 | 形状 |
|---|---|
| 1.x 配置列表 / 历史列表 | **裸 `Page` 对象**，无 `{code,message,data}` 包装 |
| 1.x `RestResult` 类接口（命名空间等） | `{"code":200,...}` —— **注意是 200 不是 0** |
| 2.x v2 / 3.x | `{"code":0,"message":"success","data":...}` |
| 1.x 取配置内容 | **纯文本**，无任何 JSON 包装 |
| 2.x `GET /v2/cs/config` | `data` 就是内容字符串本身，**拿不到 `type`** |

判断成功不能只看 `code === 0`，1.x 会给 `200`。判据写成 `code === 0 || code === 200`，或只看 HTTP 状态码 + `data` 是否存在。

**1.x 有一部分接口在业务失败时仍返回 HTTP 200，错误藏在 body 的 `code` 里。** 不能只判 `response.ok`。

### 6.4 实例列表的三种形状

| 来源 | 形状 |
|---|---|
| v1 / v2 | `data.hosts[]`（外层是 ServiceInfo） |
| v3 admin / v3 client | `data[]`（直接是数组） |
| v3 console | `data.pageItems[]`（分页对象） |

必须写归一化函数。

另外 v1 的集群参数叫 **`clusters`**（复数，逗号分隔），v2/v3 叫 **`clusterName`**（单数）。

### 6.5 服务列表的三种形状

| 版本 | 响应 |
|---|---|
| 1.x | `{"count":N,"doms":["name1","name2"]}` —— 字段叫 `doms`，只有服务名 |
| 2.x | `{"code":0,"data":{"count":N,"services":["name1"]}}` —— 字段改叫 `services` |
| 3.x | `data.pageItems[]`，每项含 `clusterCount`/`ipCount`/`healthyInstanceCount`/`triggerFlag` |

**要在树里显示「服务名 + 实例数 + 健康数」，在 1.x/2.x 上必须用 catalog 接口**（`GET /v1/ns/catalog/services`），标准 `service/list` 给不了这些数字。3.x 已把 catalog 语义合并进了标准接口。

3.x 的搜索参数叫 `serviceNameParam` / `groupNameParam`（带 `Param` 后缀）。

### 6.6 配置历史的字段差异

| | 1.x / 2.x | 3.x |
|---|---|---|
| 时间字段 | `createdTime` / `lastModifiedTime`，**ISO 字符串** | `createTime` / `modifyTime`，**毫秒时间戳** |
| 列表路径 | `/v1/cs/history?search=accurate`（同路径靠 query 区分） | `/v3/admin/cs/history/list`（独立子路径） |

**`opType` 带尾随空格**（数据库 char 填充），值形如 `"I "`、`"D "`，所有版本都有这个问题，比较前必须 `trim()`。

3.x 新增 `publishType`（`formal` / `gray`）、`grayName`、`extInfo`。

### 6.7 服务详情的字段差异

- 1.x：`clusters` 是**数组**，服务名字段叫 `name`
- 2.x / 3.x：`clusterMap` 是**对象**，服务名字段叫 `serviceName`
- 2.x 的命名空间字段叫 `namespace`，1.x / 3.x 叫 `namespaceId`

### 6.8 配置 `type` 字段的可见性

`type` 决定虚拟文档的 VS Code language mode，取值 `properties` / `yaml`（也写作 `yml`）/ `json` / `xml` / `text` / `html`。

| 接口 | 有 `type`？ |
|---|---|
| 1.x `GET /v1/cs/configs`（纯文本） | 无 |
| 1.x `?show=all` | 有 |
| 2.x `GET /v2/cs/config` | 无（`data` 只是字符串） |
| 3.x 所有 config 详情/列表 | 有 |
| 3.x `/v3/client/cs/config` | 有，但字段名叫 `contentType` |

**取配置内容时不要用 1.x 的纯文本端点，用 `?show=all`。** `type` 为 null 时回退到按 `dataId` 后缀名推断。

## 7. 鉴权

### 7.1 登录端点与降级

| 版本 | 端点 |
|---|---|
| 1.x / 2.x | `POST {base}/v1/auth/login`（`/v1/auth/users/login` 等价） |
| 3.x | `POST {base}/v3/auth/user/login` |
| 3.0 – 3.2.3 | `POST {base}/v1/auth/login` 仍保留可用 |

降级链：先打 v3，**收到 404 或 501 退到 v1**（照抄官方 Java 客户端 `HttpLoginProcessor` 的逻辑）。

**请求格式**：`username` 和 `password` 都是 Spring `@RequestParam`，query 和 form body 都接受。官方 Java 客户端把 `username` 放 query、`password` 放 form body。**我们照此实现**——密码不进 URL，避免被 access log 记录。`Content-Type: application/x-www-form-urlencoded`。

**响应**（三个版本一致）：

```json
{"accessToken":"eyJhbGciOiJIUzI1NiJ9...","tokenTtl":18000,"globalAdmin":true,"username":"nacos"}
```

### 7.2 携带 token

三种方式在所有版本都支持，优先级从高到低：`Authorization: Bearer <token>` 头、`accessToken: <token>` 头、`?accessToken=<token>` query。

**统一用 `Authorization: Bearer`。** 不要用 query 参数——token 会进 Tomcat access log（`server.tomcat.accesslog.enabled` 默认 true）。

### 7.3 Token 过期

- 默认 TTL 18000 秒（5 小时），响应里的 `tokenTtl` 就是它。
- 过期后返回 **403**（2.x 走 Spring 错误页；3.x 返回 `{"code":10001,...}`）。
- **Nacos 自己从不返回 401。** 收到 401 基本可断定前面挂了反向代理/网关。
- 策略：按 `tokenTtl * 0.8` 主动刷新，同时对任意 403 做一次「重新登录并重试」。

### 7.4 无鉴权实例

2.x 上 `nacos.core.auth.enabled=false` 时全部放行。判据是 state 端点的 `auth_enabled` 字段（**是字符串 `"true"`/`"false"`，不是 boolean**）。

**3.x 上 `auth_enabled: "false"` 不代表 Admin/Console 不要鉴权**——该字段只反映 `nacos.core.auth.enabled`。3.x 无论如何都要准备登录流程。

**拿不到 token 时不要拒绝连接**，先无凭据试一次。

### 7.5 OIDC 例外

`nacos.core.auth.system.type=oidc` 时 `/v3/auth/user/login` 返回 `Result.failure(ILLEGAL_STATE, "Current Nacos auth plugin type is not 'nacos' or 'nacos-ldap', don't support login API.")`。识别这个 message 并提示用户改用「直接粘贴 token」模式。

### 7.6 AK/SK（推迟）

阿里云 MSE 的 SPAS 签名。CONFIG 资源注入 `Spas-AccessKey`/`Spas-Signature`/`Timestamp` 到 header；NAMING 资源注入 `ak`/`signature`/`data` 到请求参数。HMAC-SHA1 后 Base64，但 resource 拼装规则在两类资源下不同，`signatureVersion=v4` 时还有区域派生密钥。开源版 Server 默认不校验，MSE 也支持用户名密码。**推迟到后期里程碑。**

## 8. 版本与 context-path 探测

### 8.1 免鉴权探测端点

以下端点**全部免鉴权**（源码中无 `@Secured` 注解），所以「先探版本再决定怎么登录」可行：

| 端点 | 1.x | 2.x | 3.0/3.1 | 3.2+ |
|---|---|---|---|---|
| `GET {base}/v1/console/server/state` | 有 | 有 | 410 | 404 |
| `GET {base}/v3/admin/core/state` | — | — | 有 | 有 |
| `GET {console}/v3/console/server/state` | — | — | 有 | 有 |

**actuator 不要指望**：`management.endpoints.web.exposure.include` 默认为空。

### 8.2 探测顺序

```
1) GET {origin}{ctx}/v3/admin/core/state
     200 → 3.x，读 version（顶层或 data 下都要试）→ flavor = v3-admin
2) GET {origin}{ctx}/v1/console/server/state
     200 → 读 version → 1.x 或 2.x → flavor = v1 / v2
     410 → 3.0/3.1 且 console 开关关闭 → 回到 (1)
     404 → 可能 3.2+，或 context-path 猜错
3) GET {origin}/v3/console/server/state（试 8080）
     200 → 3.x console 可达 → 记录 consoleBase
4) GET {origin}{ctx}/ → text/plain 含 "Nacos Console default port is"
     → 确认 3.x，并从该文本解析出 console 端口与路径
```

### 8.3 context-path 探测

`/nacos` 不是绝对的，K8s Ingress 和部分 Docker 镜像会设成 `/`。策略：用户填的完整 base URL 优先；否则依次尝试 `{origin}/nacos` 和 `{origin}`，第一个在探测端点返回 200 且 body 含 `version` 的即为正确 base。

3.x 专属信号：`GET {origin}/nacos/` 会被 `NacosConsolePathTipFilter` 拦截，返回 `Content-Type: text/plain` 的 `Nacos Console default port is 8080, and the path is /.`。这一条同时告诉你「这是 3.x」和「console 在哪」。1.x/2.x 访问 `/nacos/` 返回的是控制台 HTML。

### 8.4 单机 vs 集群

判据按可靠性排序：

1. state 端点的 `startup_mode`（2.5+/3.x）或 `standalone_mode`（1.x/早期 2.x），取值 `standalone` / `cluster`。**两个 key 都要读**——字段在 2.x 中途改过名，不要用版本号比较来选 key。
2. `cluster/node/list` 的节点数 > 1（需管理员权限）。
3. `extendInfo.raftMetaData.metaDataMap.*.raftGroupMember` 数组长度。

## 9. 能力矩阵

`{srv}` = `http://host:8848/nacos`；`{con}` = `http://host:8080`；`{base}` = `http://host:8848/nacos`

| 功能 | 1.x | 2.x | 3.0 / 3.1 | 3.2+ |
|---|---|---|---|---|
| 服务端状态 | `GET {base}/v1/console/server/state` 免鉴权 | 同左 | v1 默认 410；用 `GET {srv}/v3/admin/core/state` 免鉴权 | v1 已删；`{srv}/v3/admin/core/state` 或 `{con}/v3/console/server/state` 免鉴权 |
| 登录 | `POST {base}/v1/auth/login` | 同左 | `POST {srv}/v3/auth/user/login`（v1 仍可用） | 同左 |
| 配置列表 | `GET {base}/v1/cs/configs?search=accurate\|blur` | 同左（v2 无此接口） | v1 默认 410；`GET {srv}/v3/admin/cs/config/list` 需管理员 | `{srv}/v3/admin/cs/config/list`（管理员）或 `{con}/v3/console/cs/config/list`（ns read） |
| 配置详情 | `GET {base}/v1/cs/configs?show=all` | 同左；或 `GET {base}/v2/cs/config`（无 type） | `?show=all` 默认 410；纯文本端点可用；`GET {srv}/v3/admin/cs/config` | `{srv}/v3/admin/cs/config` 或 `{con}/v3/console/cs/config` 或 `{srv}/v3/client/cs/config` |
| 配置历史列表 | `GET {base}/v1/cs/history?search=accurate` | 同左；或 `GET {base}/v2/cs/history/list` | v1/v2 默认 410；`GET {srv}/v3/admin/cs/history/list` | `{srv}/v3/admin/cs/history/list` 或 `{con}/v3/console/cs/history/list` |
| 配置历史详情 | `GET {base}/v1/cs/history?nid=` | 同左；或 `GET {base}/v2/cs/history?nid=` | v1/v2 默认 410；`GET {srv}/v3/admin/cs/history?nid=` | 同 3.0/3.1 或 console 版 |
| 配置监听者 | `GET {base}/v1/cs/configs/listener` | 同左 | v1 默认 410；`GET {srv}/v3/admin/cs/config/listener` **需 WRITE 权限** | admin 版需 WRITE；`{con}/v3/console/cs/config/listener` 只需 READ |
| 命名空间列表 | `GET {base}/v1/console/namespaces` 免鉴权 | 同左；或 `GET {base}/v2/console/namespace/list` 免鉴权 | v1/v2 默认 410；`GET {srv}/v3/admin/core/namespace/list` 需管理员 | `{srv}/v3/admin/core/namespace/list`（管理员）或 `{con}/v3/console/core/namespace/list`（任意有效身份） |
| 服务列表 | `GET {base}/v1/ns/service/list`（仅名字）或 `GET {base}/v1/ns/catalog/services`（带统计） | 同左；或 `GET {base}/v2/ns/service/list` | v1 service/list 可用；catalog 默认 410；`GET {srv}/v3/admin/ns/service/list` | `{srv}/v3/admin/ns/service/list` 或 `{con}/v3/console/ns/service/list` |
| 服务详情 | `GET {base}/v1/ns/service` | 同左；或 `GET {base}/v2/ns/service` | v1 默认 410（ADMIN_API）；`GET {srv}/v3/admin/ns/service` | 同 3.0/3.1 或 console 版 |
| 实例列表 | `GET {base}/v1/ns/instance/list` | 同左；或 `GET {base}/v2/ns/instance/list` | v1 可用（OPEN_API）；`GET {srv}/v3/admin/ns/instance/list` | admin / console（分页）/ client 三种 |
| 订阅者列表 | `GET {base}/v1/ns/service/subscribers` | 同左 | v1 默认 410；`GET {srv}/v3/admin/ns/service/subscribers` | admin 或 console 版 |
| 集群节点 | `GET {base}/v1/core/cluster/nodes` 或 `GET {base}/v1/ns/operator/servers` | 同左；或 `GET {base}/v2/core/cluster/node/list` | v1/v2 默认 410；`GET {srv}/v3/admin/core/cluster/node/list` 需管理员 | admin 或 `{con}/v3/console/core/cluster/nodes`（均需管理员） |
| 健康检查 | `GET {base}/v1/console/health/{readiness,liveness}` 免鉴权 | 同左 | v1 默认 410；`GET {srv}/v3/admin/core/state/{readiness,liveness}` 免鉴权 | 同 3.0/3.1 或 `{con}/v3/console/health/*` |

**鉴权列读法**：1.x/2.x 只有 `nacos.core.auth.enabled=true` 时「需 X」才生效，而该值默认 false；3.x 的 admin/console 开关默认 true，「需 X」默认就生效。

## 10. 分页上限

| 接口 | 默认 | 上限 | 是否源码确认硬截断 |
|---|---|---|---|
| 配置历史列表（全版本） | 100 | 500 | 是（`Math.min(500, pageSize)`） |
| 配置列表 v1 | 无默认（必传） | 未标 | 否 |
| 配置列表 v3 | 100 | 未标 | 否 |
| 服务列表 v2 / v3 | 20 | 500（仅文档） | 否 |

**插件端自己把 `pageSize` 限制在 100 以内并做分页拉取，不要赌服务端会截断。**

## 11. 错误码

| code | 含义 |
|---|---|
| `0` | success（v2/v3） |
| `200` | success（1.x 的 `RestResult`） |
| `10000` | parameter missing |
| `10001` | access denied（配 HTTP 403） |
| `20001` | 'tenant' parameter error |
| `20004` | resource not found |
| `21008` | service not exist |
| `22001` | namespace not exist |
| `40000` | API deprecated（3.0/3.1 兼容开关拦截，配 HTTP 410） |

403 的三种原因需分别提示：未带 token 或 token 过期（重新登录）；权限不足（换账号或降级到 Console API）；服务端 `nacos.core.auth.server.identity.*` 配错（服务端问题）。

## 12. 目录结构

```text
at-nacos-series/
├── src/
│   ├── extension.ts                    # composition root
│   ├── config/
│   │   ├── schema.ts                   # zod schema
│   │   └── NacosInstanceConfigManager.ts
│   ├── nacos/                          # 领域层，不 import vscode
│   │   ├── NacosHttpClient.ts
│   │   ├── NacosApiError.ts
│   │   ├── auth/
│   │   │   ├── NacosAuthenticator.ts
│   │   │   ├── UserPasswordStrategy.ts
│   │   │   ├── NoAuthStrategy.ts
│   │   │   ├── CustomHeaderStrategy.ts
│   │   │   └── AkSkStrategy.ts         # 后期里程碑
│   │   ├── probe/
│   │   │   ├── probeServerState.ts
│   │   │   └── resolveBaseUrl.ts
│   │   ├── driver/
│   │   │   ├── NacosDriver.ts          # 接口 + 领域模型
│   │   │   ├── V1Driver.ts
│   │   │   ├── V2Driver.ts
│   │   │   ├── V3AdminDriver.ts
│   │   │   ├── V3ConsoleDriver.ts
│   │   │   └── normalize.ts            # 响应归一化与参数名映射
│   │   ├── NacosCapabilityResolver.ts
│   │   ├── NacosClient.ts              # 门面
│   │   ├── NacosCertTrustStore.ts
│   │   ├── createInteractiveCertVerifier.ts
│   │   └── testNacosConnection.ts
│   ├── tree/
│   │   ├── NacosTreeItems.ts
│   │   ├── ConfigTreeProvider.ts
│   │   └── ServiceTreeProvider.ts
│   ├── document/
│   │   ├── NacosConfigDocumentProvider.ts   # 虚拟文档
│   │   └── configUri.ts                     # URI 编解码 + language mode
│   ├── webview/
│   │   ├── html.ts
│   │   ├── NacosInstanceFormPanel.ts
│   │   └── ClusterStatusPanel.ts
│   ├── mcp/                            # 从 grafana 移植的六件套
│   ├── agent/
│   │   ├── NacosAgentToolService.ts
│   │   └── redactConfigContent.ts
│   ├── i18n/
│   │   ├── t.ts                        # vscode.l10n 薄封装
│   │   └── webviewStrings.ts           # webview 文案注入
│   └── utils/                          # errors/nonce/notifications/logger/redaction
├── webview/                            # 浏览器侧 TS + CSS
├── l10n/
│   └── bundle.l10n.zh-cn.json
├── package.nls.json
├── package.nls.zh-cn.json
├── media/                              # at-nacos-icon.png/svg + at-nacos-activity.svg
├── test/                               # 镜像 src/ 的目录结构
├── test-fixtures/vscode.ts
├── scripts/{copy-hub,package}.mjs
└── docs/plans/
```

**核心约定**：`src/nacos/**`、`src/config/**`、`src/mcp/**`（除 `hubSync.ts`）**不 import `vscode`**，靠结构化接口（`ExtensionMemento` / `SecretStore` / `LogSink`）解耦，这样 vitest 无需启动 VS Code 即可测试。

## 13. 里程碑划分

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M1** | 项目脚手架、i18n 基础设施、实例配置与凭据、四种鉴权、TLS TOFU、版本与 context-path 探测、Driver 抽象 + 四个 driver 的命名空间实现、实例表单、两棵树骨架 | 能添加实例、测试连接成功、树中展开实例看到命名空间列表；1.x/2.x/3.x 三种服务端都能连上 |
| **M2** | 配置树（命名空间 → 分组 → dataId）、分页与懒加载、搜索过滤、虚拟文档查看配置内容（按 type 着色） | 能浏览并打开任意配置，语法高亮正确 |
| **M3** | 服务树（命名空间 → 分组 → 服务 → 实例）、订阅者、集群状态面板 | 服务与实例健康状态可见，集群节点状态面板可用 |
| **M4** | 配置历史列表、历史版本 diff、监听者查询、跨环境配置对比 | 能对任意配置查看历史并与历史版本或其他环境做原生 diff |
| **M5** | 写操作：发布配置、回滚到历史版本、实例上下线；diff 预览 + 二次确认；实例只读开关 | 写操作全部经过 diff 确认；只读实例的写按钮被禁用 |
| **M6** | MCP Bridge、7 个只读工具、配置内容脱敏、hub 同步与配置安装、打包发布 | Agent 通过 `at_list_providers` 能发现 `at.nacos` 并调用只读工具 |

## 14. 待真机验证的不确定项

以下项目**不要凭调研写死代码**，M1 开始前用真实环境 curl 确认：

1. `GET /nacos/v3/admin/core/state` 的响应是否带 `{code,message,data}` 包装。源码 `Result<Map<String,String>>` 说带，官方文档示例说不带。**代码写成两种都兼容**（先看顶层 `version`，再看 `data.version`）。
2. 3.0/3.1 兼容开关拦截时 HTTP 410 的实际 body 形状。**只依赖状态码**。
3. 1.x/2.x `GET /v1/cs/configs/listener` 的响应字段名。类型是 `GroupkeyListenserStatus`（Nacos 源码里这个类名本身就拼错了），疑似 `collectStatus` + `lisentersGroupkeyStatus`。
4. `GET /v1/ns/catalog/services?withInstances=false` 的顶层字段名（`serviceList`？）。
5. 除配置历史外，各分页接口是否真有 500 硬上限。
6. 3.x console 端口（8080）上是否也能调 `/v3/auth/user/login`。
7. 1.x 配置列表返回的 `type` 是否总被填充（可能为 null，需按后缀名回退）。
8. `nacos.deployment.type=console` 独立部署模式下 console 与 server 分离的完整行为。
9. 1.x 各小版本差异（`standalone_mode` → `startup_mode` 的确切分界版本未确定）。调研只实读了 2.5.3 / 3.1.2 / 3.2.3 源码，1.x 信息全部来自官方文档。

## 15. 参考

- Hub 接入指南：`../../at-series-mcp-hub/docs/guides/plugin-integration.md`
- Hub Bridge 协议：`../../at-series-mcp-hub/docs/protocol/v1.md`
- Hub 渐进暴露协议：`../../at-series-mcp-hub/docs/protocol/v2.md`
- 模板插件：`../../at-grafana-series/`
- [Nacos 3.x Admin API](https://nacos.io/en/docs/latest/manual/admin/admin-api/)
- [Nacos 3.x Console API](https://nacos.io/en/docs/latest/manual/admin/console-api/)
- [Nacos 2.X OpenAPI](https://nacos.io/docs/v2/guide/user/open-api/)
- [Nacos 1.X OpenAPI](https://nacos.io/docs/v1/open-api/)
- [升级手册（含 3.2.0 v1/v2 移除说明）](https://nacos.io/en/docs/latest/manual/admin/upgrading/)
