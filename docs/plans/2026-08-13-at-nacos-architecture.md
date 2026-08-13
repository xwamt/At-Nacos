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

### 5.5 M2 必须先解决：404 同时表示两件事

`classifyHttpStatus` 把 HTTP 404 映射成 `not-found`，而 `not-found` 是 fall-through 类型。这在 M1 成立，因为命名空间列表端点要么存在要么不存在。

**但 Nacos 对「配置不存在」也返回 404**（1.x 是 `config data not exist`，2.x 是 `RESOURCE_NOT_FOUND`）。一旦 M2 加入 `getConfig` 能力，每一次查询一个不存在的 dataId 都会被当成「这个版本没有这个端点」，触发完整的驱动链遍历，最终报出「No Nacos API flavor could serve "configs"」——而正确答案只是「这条配置不存在」。

修法方向（M2 开始前定夺，并在真机上确认响应体形状）：

- 让 driver 在解析响应时区分二者，把「资源不存在」重新分类为 `api-error` 或新增一个 `resource-not-found` 类型（后者不 fall-through）
- 判据只能来自响应体：v2/v3 有 `code` 字段（`20004` / `21008` / `22001` 分别对应资源、服务、命名空间不存在），1.x 只有纯文本消息
- 不要试图靠路径猜测，同一个路径既可能因版本不对而 404，也可能因资源不存在而 404

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

## 14. 真机验证结果与仍未确认的项

### 14.0 已验证环境

**Nacos 2.3.2**，standalone，`nacos.core.auth.enabled=false`，`http://192.168.99.90:8848/nacos`，2026-08-13。

除逐条核对下列条目外，还用本仓库自己的代码跑通了端到端（`test/live/liveServer.test.ts`，设 `AT_NACOS_LIVE_URL` 才执行）：

- 版本探测正确报出 `2.3.2 / major=2 / standalone / authEnabled=false`
- 从裸 origin `http://192.168.99.90:8848` 自动发现出 context path `/nacos`
- 驱动链走 2.x 分支列出 11 个命名空间，public 的 id 正确识别为空字符串
- `authMode: 'none'` 全程无凭据可用

**2.x 相关条目已全部确认；1.x 与 3.x 仍未验证。**

### 14.1 已确认（Nacos 2.3.2）

| 条目 | 结论 |
|---|---|
| 命名空间条目字段名（原 §14-10，风险最高） | **完全符合预期**：`namespace` / `namespaceShowName` / `namespaceDesc` / `quota` / `configCount` / `type`。`normalizeNamespace` 的硬性要求成立。 |
| v1 与 v2 的成功码 | v1 `/v1/console/namespaces` 返回 `code: 200`，v2 `/v2/console/namespace/list` 返回 `code: 0`。`SUCCESS_CODES = {0, 200}` 两者都覆盖到了。 |
| public 命名空间 id | 2.x 上确为**空字符串**，`namespaceShowName` 为 `"public"`。 |
| 配置监听者字段名（原 §14-3） | **拼写错误确认存在**：`{"collectStatus":200,"lisentersGroupkeyStatus":{}}`。M2/M4 解析时必须照抄这个拼错的键名。 |
| catalog services 顶层字段（原 §14-4） | `{"count":N,"serviceList":[...]}`。 |
| v1 配置列表的 pageSize 上限（原 §14-5） | **没有硬上限**。请求 `pageSize=9999` 被照单全收，无截断。500 的上限只存在于历史接口。插件端自己限制在 100 的做法是必要的。 |
| 2.x 根路径响应（原 §14-11 的 2.x 半边） | 返回 `text/html` 的控制台页面，不匹配 3.x 的 console 提示句。`parseConsoleHint` 不会误判。 |
| `standalone_mode` → `startup_mode` 改名分界（原 §14-9） | 2.3.2 **已经**是 `startup_mode`。结合已知的 2.2.3 用 `standalone_mode`，分界收窄到 2.2.3 与 2.3.2 之间。两个键都读的策略是对的。 |

### 14.2 真机上发现的、调研没预见到的四件事

**⓪ 「配置不存在」在 `?show=all` 上根本不是 404，而是 HTTP 200 + 空 body。**（M2 Task 3 的 live 测试抓到，推翻了 §5.5 原本的修法。）

```
GET /v1/cs/configs?show=all&dataId=<不存在>&group=X&tenant=Y
  → HTTP 200, Content-Type: application/json, Content-Length: 0

GET /v1/cs/configs?dataId=<不存在>&group=X&tenant=Y      （纯文本形式）
  → HTTP 404, Content-Type: application/json
    config data not exist
```

两者是**不同的 controller 方法**。`?show=all` 返回 `ConfigAllInfo`，Spring 把 null 序列化成零字节；纯文本形式才走那条 404 路径。而我们必须用 `?show=all`——纯文本形式不给 `type`，拿不到语法高亮的依据。

所以判据是：**2xx 但解包后为空（空 body，或 3.x 的 `data: null`）即为资源不存在**。404 + Spring 错误页仍然表示端点不存在（该 fall through），404 + 非错误页 body 仍然表示资源不存在——这两条对纯文本形式和其它版本仍然成立，都保留着。

**①' 传错命名空间参数名是静默失败。** 实测 `tenant=cl-parent` 返回 12 条，`namespaceId=cl-parent` 返回 `totalCount 0`、不报错。看起来就是「这个命名空间是空的」。这就是为什么 `V2Driver` 必须用 v1 的方言提问，以及为什么参数名映射要集中在 `namespaceParamName` 而不能散落。

**①'' `md5` 在两种搜索模式下都是 null。** 只有 `type` 随模式变化。

#### 14.2（续）调研没预见到的另两件

**① `type` 字段只在 `search=accurate` 下被填充，`search=blur` 下是 `null`。**（原 §14-7 的答案，但比预期复杂。）

这不是版本差异而是**搜索模式差异**。M2 用 `type` 决定虚拟文档的 language mode，而搜索过滤 UI 用的正是 blur 模式——也就是说用户一搜索，语法高亮的依据就消失了。

对策：`type` 为 null 时按 `dataId` 后缀推断（`.yml`/`.yaml` → yaml，`.properties` → properties，`.json` → json，`.xml` → xml，`.txt` → plaintext，`.html` → html，无后缀 → plaintext）。这个回退是必需路径而非兜底。

**② 配置列表接口返回完整的配置内容。**

`accurate` 与 `blur` 两种模式都在 `pageItems[].content` 里带上整条配置的正文。实测 12 条配置的响应体是 38KB；Nacos 单条配置上限 100KB，一个几百条配置的命名空间，仅列表请求就可能是几十兆。

v1 的列表接口**没有**排除内容的参数。这对 M2 有三个直接后果：

- 树的分页必须真的分页，不能"先拉全量再本地过滤"
- `maxResponseBytes` 必须在列表请求上设一个明确的上限，否则一次展开就可能把扩展宿主打爆
- 更要紧的是**内容会流经列表接口**，所以配置正文里的密码不只在"查看配置"时出现，而是在"列出配置"时就已经进入内存和日志路径。脱敏与 MCP 工具的默认脱敏因此比原计划更关键

列表条目的完整字段集：`id` / `dataId` / `group` / `tenant` / `appName` / `content` / `md5` / `type` / `encryptedDataKey`。注意 `md5` 在 accurate 模式下是 `null`。

### 14.3 仍未验证（需要 1.x 或 3.x 环境）

以下项目**不要凭调研写死代码**：

**需要 Nacos 3.x：**

1. `GET /nacos/v3/admin/core/state` 的响应是否带 `{code,message,data}` 包装。源码 `Result<Map<String,String>>` 说带，官方文档示例说不带。**代码写成两种都兼容**（先看 `data.version`，再看顶层 `version`）。
2. 3.0/3.1 兼容开关拦截时 HTTP 410 的实际 body 形状。**只依赖状态码**。
3. **3.x 命名空间条目的字段名。** 2.x 上已确认是 `namespace` / `namespaceShowName`，但 3.x 在别处改了大量字段名（`doms` → `services`、`clusters` → `clusterMap`、`createdTime` → `createTime`）。四个 driver 共用的 `normalizeNamespace` 硬性要求 `entry.namespace` 是字符串，否则抛 `invalid-response`——而这个类型**不触发** fall-through。如果 3.x 改了它，每一次 3.x 命名空间列举都会以不可恢复的错误告终。**这是 3.x 侧优先级最高的一条。**
4. **3.x console 提示句的确切措辞与它伴随的 HTTP 状态码。** `parseConsoleHint` 按近似措辞匹配，且刻意不对状态码设门槛。这条现在更要紧了：M1 修复后，console 地址的自动发现是 admin-403 降级路径能否成立的前提。
5. **admin 403 → console 降级的真实行为。** 需要一个非管理员账号的 3.x 实例。这是架构 §4.3 的主路径，目前只有构造出来的测试覆盖。
6. 3.x console 端口（8080）上是否也能调 `/v3/auth/user/login`。
7. **`/v3/auth/user/login` 是否接受与 v1 相同的 query/form 混合写法。** 这是从 v1 Java 客户端推断的，不是源码实读结论。
8. `nacos.deployment.type=console` 独立部署模式下 console 与 server 分离的完整行为。

**需要 Nacos 1.x：**

9. 1.x 的整体行为。调研只实读了 2.5.3 / 3.1.2 / 3.2.3 源码，1.x 信息全部来自官方文档。已确认的 2.3.2 行为不能外推——`standalone_mode` → `startup_mode` 的改名就发生在 2.2.3 与 2.3.2 之间，说明 2.x 内部也在动。
10. 1.x 配置列表返回的 `type` 是否也随搜索模式变化（2.3.2 上 accurate 有、blur 无）。

**需要鉴权已开启的实例：**

11. **用户名密码登录的完整链路。** 已验证环境 `auth_enabled=false`，所以 `UserPasswordStrategy`、token 缓存与刷新、403 重登重试、以及 `withAuth` 的整条重试路径都只有本地夹具覆盖，从未打过真的 `/v1/auth/login`。
12. **TLS TOFU。** 没有 HTTPS 实例，指纹信任、变更告警、以及 M1 刚修的「提示框打开期间停表」都未经真机验证。

### 14.4 M2 组装后的端到端验证（Nacos 2.3.2，2026-08-14）

M2 Task 7 把 `test/live` 从驱动层抬到了 UI 层：这一组驱动的是 `ConfigTreeProvider` 与 `openConfigDocument` / `NacosConfigDocumentProvider` 本身，而不是它们底下的 `NacosClient`。驱动层的结论上面已经记过，这里只记新的。

**① 从实例节点一路展开到编辑器是通的。** `cl-parent` 命名空间展开出 1 个分组 `cl-intimfy` 与 12 个 dataId；打开 `application-dev.yml` 得到 `nacos:/live/cl-parent/cl-intimfy/application-dev.yml`，`provideTextDocumentContent` 沿这个地址取回 1448 字节，language mode 为 `yaml`。URI 里没有任何凭据——「路径里放实例 id 而不是实例地址」这条设计在真机上成立。

**② 一个命名空间的配置常常全落在同一个分组里。** 真机上 12 条配置同属 `cl-intimfy`。「分组由已加载的页面推导」这个取舍在这种分布下几乎没有代价，但也意味着它在真机上从未被压力测试过（见下）。

**③ `type: text` 是真实存在的取值，不是理论上的。** `sentinel-cl-gateway` 的 `type` 就是 `text`，而它的 dataId 没有后缀，最终落到 `plaintext`。`configLanguage` 里 `text → plaintext` 这一行现在有真机依据。

**④ 过滤态下的语法高亮走的确实是后缀回退。** 过滤 `application-dev` 后树从 12 条收窄到 1 条，该条目的 `type` 为 `null`（§14.2 ① 在树自己的 blur 路径上复现了一次），而打开它得到的 language mode 仍是 `yaml`——此时唯一的依据就是 dataId 后缀。M2 里唯一一条「回退即主路径」的链路，现在有真机覆盖。

**这一组没有推翻任何假设。** 与前几次不同，服务端这次的行为与计划里写的完全一致。

**M2 在真机上仍未覆盖的**——这几条不需要别的 Nacos 版本，只是这台服务器上没有相应的数据：

13. **分页与 Load more。** 这台服务器上最大的命名空间只有 15 条配置，远低于每页 100 条，所以 `LoadMoreTreeItem` 在真机上从未出现过：翻第二页、增量合并、「新分组随下一页出现」、以及 `atNacos.loadMoreConfigs` 的失败提示，全部只有夹具覆盖。需要一个配置数超过 100 的命名空间。
14. **非 ASCII 的 dataId。** 这台服务器上一个都没有，所以 URI 的中文编解码往返只有单测覆盖，标签页标题的实际渲染也没有在扩展宿主里看过（见 §16.6）。
15. **虚拟文档的失败文案。** 「实例已被删除」与「配置已在服务端被删除」两条分支都只有夹具覆盖；后者要在标签页开着的时候去服务端删掉一条配置才能触发。

### 14.5 M3 Task 1 驱动层的真机验证（Nacos 2.3.2，2026-08-14）

M3 计划开篇的三条真机发现里，**第二条是错的**，而它错的方式恰好是第三条陷阱本身。

**① 这台服务器有 13 个注册服务，不是零。** 分布在两个命名空间、同一个分组 `cl-intimfy`：`cl-parent-offline` 12 个、`cl-taskcenter` 1 个，各带 1 个健康实例，metadata 是 `{"preserved.register.source":"SPRING_CLOUD"}`。~~实例全部在 `192.168.99.92`~~ ——这一句是从当时唯一展开过的那个服务外推的，Task 2 把 12 个服务全部展开后不成立，见 §14.6 ②。

得出「零服务」结论的是 `/v1/ns/service/list`，而它的 `groupName` 默认 `DEFAULT_GROUP`。同一个命名空间实测：不带分组返回 `{"count":0,"doms":[]}`，带 `groupName=cl-intimfy` 返回 12 条。**分组默认值不只是「可能藏住一个注册表」——它藏住了这一个，并且骗过了为它做调研的人。**

因此 M3 计划里「服务树本轮无法端到端真机验证」的结论作废：`test/live/liveServer.test.ts` 现在从命名空间一路走到实例，13 个服务连同实例的 ip:port、健康、权重、集群名与 metadata 全部真机可见。

**② 只有 `/v1/ns/**` 用 HTTP 501 报告「没有这个接口」，其余前缀都是 Spring 404。** 实测 `/v1/ns/__nope__` → `501 {"message":"no such api:GET:/nacos/v1/ns/__nope__"}`，而 `/v2/ns/__nope__`、`/v1/cs/__nope__`、`/v1/core/__nope__`、`/v2/core/__nope__`、`/v1/console/__nope__` 全是 404 错误页。这是 naming 模块自己的 filter。

两个后果。501 归类为 `api-error`，**不触发驱动降级**——目前只影响 driver 内部的 catalog 回退（它对任何分类错误都回退，所以无碍），但任何「v1 naming 端点缺失 → 换驱动」的设计都会卡在这里。以及 §9 把 `GET {base}/v1/ns/operator/servers` 列为集群节点的等价接口，**2.3.2 上它并不存在**（501），`listClusterNodes` 只走 `/v1/core/cluster/nodes`。

**③ catalog 的搜索参数在 2.3.2 上就带 `Param` 后缀。** §6.5 把 `serviceNameParam` / `groupNameParam` 记成 3.x 的拼法，实则 2.3.2 的 `CatalogController` 声明的就是 `@RequestParam(name = "groupNameParam")`，3.x 是继承而非发明。给 catalog 传 `groupName` 会被静默丢弃、整个命名空间照原样返回，看起来像「过滤器匹配了所有东西」。空值才是「所有分组」（`patternServices` 用 `isBlank` 判断），服务树的无分组列举依赖这一条。

**④ `triggerFlag` 在 2.x 上是字符串。** catalog 写的是 `"true"` / `"false"`，3.x 的同名字段是 boolean，归一化两种都收。

**⑤「服务不存在」是 HTTP 200 + 空 `hosts`，与「配置不存在」正好相反。** `/v1/ns/instance/list?serviceName=<不存在>` 返回完整 ServiceInfo、`hosts: []`。§14.2 ⓪ 记的配置侧判据（2xx 但解包后为空 = 不存在）**不能**套到 naming 上：那会把一个空服务读成一个缺失的服务。

**⑥ v1 的实例接口两种问法都认。** `serviceName=G@@svc` 与 `serviceName=svc&groupName=G` 等价，两个一起传也不会把分组拼两次（都得到 `G@@svc`）。但 `InstanceController.list` 源码只读 `serviceName`，所以驱动只发分组名形式。另外 `serviceName=G@@a@@b` 会被参数校验拒绝：`HTTP 400 Param 'serviceName' is illegal`——服务名里不可能出现 `@@`，但响应里的 `serviceName` 字段一定带着它。

**⑦ `/v2/ns/operator/metrics` 存在。** 2.3.2 上可用，`{code:0,data:{...}}` 包装，比 v1 少一个 `responsibleInstanceCount`。v2 驱动不必借 v1 的路径。

**⑧ metrics 的退化与版本无关，是参数默认值。** §4.1 把 `/v1/ns/operator/metrics` 只返回 `{"status":"UP"}` 记成 3.2+ 的退化；实际上 `onlyStatus` 在每个版本都默认 `true`（v1/v2 `WebUtils.optional(request,"onlyStatus","true")`，v3 `@RequestParam(defaultValue="true")`），2.3.2 上行为一模一样。带 `onlyStatus=false` 才有那 13 项指标。§4.1 里「3.2+ 仍保留该端点」的部分仍未验证。

**M3 Task 1 仍未覆盖的：**

16. **v3 的全部 naming / cluster 路径与参数。** `/v3/admin/ns/service/list`、`/v3/admin/ns/instance/list`、`/v3/admin/ns/ops/metrics`、`/v3/admin/core/cluster/node/list` 与四个 console 对应路径，都是照 3.1.0 源码写的（`UtilsAndCommons` 里的常量与各 Controller 的 `@RequestMapping`），没有 3.x 环境跑过。风险最低的是实例列表——`normalizeInstanceList` 三种形状都收，猜错顶多是「仍然能解析」。
17. **catalog 的回退路径。** 2.3.2 的 catalog 正常，所以「catalog 不可用 → 退回 service/list」只有夹具覆盖。它真正要救的是老 1.x（catalog 曾在 `/v1/ns/catalog/serviceList`，路径不同即 501）与 3.0/3.1 关掉兼容开关（catalog 是 CONSOLE_API，410）。
18. **console 没有 naming metrics 端点这一判断。** 来自 3.1.0 的 `console/controller/v3` 目录清单（只有 health、serverState、naming 的 service/instance、core 的 cluster/namespace），据此 `V3ConsoleDriver.getServerMetrics` 不发请求直接拒绝。若某个 3.x 其实提供了，我们会拒绝一个存在的能力。
19. **多节点集群与非 UP 状态。** 这台是单节点 standalone，所以 `raftGroups` 的多成员分支、以及 `STARTING` / `SUSPICIOUS` / `DOWN` / `ISOLATION` 四种状态全部只有夹具覆盖。

### 14.6 M3 Task 2 服务树的真机验证（Nacos 2.3.2，2026-08-14）

Task 1 把 `test/live` 走到了 `NacosClient`，这一组走的是 `ServiceTreeProvider` 本身——命名空间 → 分组 → 服务 → 实例四层，从树节点上读断言。

**① 四层在真机上是通的，分组确实是推导出来的。** `cl-parent-offline` 展开出 1 个分组 `cl-intimfy`（12）、12 个服务节点，每个服务再展开出 1 个实例节点。分组名不是 `DEFAULT_GROUP`——这正是 §14.5 ① 那个陷阱的反面证据：树的服务列举**不带 `group` 参数**，所以能看见注册在别处的分组；一个带默认值的列举在这台服务器上会渲染出空树。

**② 修正 §14.5 ①：实例并不全在 `192.168.99.92`。** 全部展开后，`cl-onboarding-server-offline` 注册的地址是 `192.168.66.124:9208`，其余 11 个在 `192.168.99.92` 的不同端口上。M3 计划 ② 说 13 个客户端连接「全部来自同一台 `192.168.99.92`」——那是**连接来源**，而实例注册的是**它自己上报的地址**，两者可以不同（`spring.cloud.nacos.discovery.ip`、NAT、容器网络都会让它们分开）。任何从连接来源推断实例地址的判断都不成立。

**③ catalog 的计数一路到了树上。** 12 个服务节点的 description 全是 `1/1`，图标是 `$(pass)` + `charts.green`；实例节点的 description 是 `cluster DEFAULT, weight 1`，tooltip 两行（健康 + metadata）。实例节点的 id 里地址是百分号编码的（`192.168.99.92%3A9202`），冒号进不了分隔位。

**M3 Task 2 仍未覆盖的：**

20. **除「全健康」以外的四种健康状态。** 这台服务器上 13 个服务全是 `1/1`，所以「部分健康」「全不健康」「0 实例」「未报计数」四个分支，以及不健康实例与已下线实例的图标，全部只有夹具覆盖。「未报计数」尤其需要一台真的 1.x——它是 catalog 不可用时的降级形态（§14.5 ⑰）。
21. **服务树的分页。** 最大的命名空间只有 12 个服务，远低于每页 100，所以 `LoadMoreTreeItem` 在服务树上也从未出现过（配置树同样，见 §14.4 ⑬）。
22. ~~**`atNacos.loadMoreServices` 还没有注册。**~~ 节点已经带上这个命令 id，注册留在 M3 Task 4——在那之前，一个超过 100 个服务的命名空间会渲染出一个点了没反应的 Load more。**Task 4 已注册，见 §14.7 ④。** 分页本身仍未真机验证（这台最大的命名空间只有 12 个服务），那一条并到 §14.4 ⑬ / §14.6 ㉑ 里。

### 14.7 M3 Task 3–4 集群面板的真机验证（Nacos 2.3.2，2026-08-14）

前两组把 `test/live` 走到了驱动层与树；这一组走的是集群面板的渲染函数——拿真机返回的节点与指标生成面板 body，再对生成出来的 HTML 断言。

**① 真机数据渲染出来一格 "not reported" 都没有。** 单节点 `172.25.0.2:8848`：状态徽章落在 `state-up`，version `2.3.2`、raftPort `7848`、failAccessCnt `0` 都有值，三个 raft 组连同 leader 与 term 在展开行里；指标八项俱全（services / instances / clients 13，subscribers 38）。body 2777 字节。

这条断言值钱的地方在于「节点那几个可选字段真机上到底填不填」——夹具回答不了这个问题，因为夹具填的是我们自己写进去的东西。一屏 "not reported" 会让 `test/webview` 里每一条渲染测试照样通过。

**② `cpu` 在线上是完整的双精度，不是计划里记的两位小数。** 三次连跑分别拿到 `0.09199206`、`0.1203…`、`0.12`，`load` 与 `mem` 同样会在两次刷新之间变——它们是采样出来的瞬时值，不是配置。面板对小数统一保留四位（`0.09199206` → `0.092`），整数计数不受影响。原样打印会把一行状态变成噪声，只留两位又会把一台忙着的服务器报成闲的。

**③ 状态徽章在真机上只验证到 `UP` 一种。** live 断言里写了 `not.toContain('state-unknown')`，它能抓住「这台服务器给状态起了别的名字」，但抓不到另外四种的样式对不对。那四种连同多节点表格仍然只有夹具覆盖（承 §14.5 ⑲）。

**④ `atNacos.loadMoreServices` 与 `atNacos.openClusterStatus` 都已注册，§14.6 ㉒ 关闭。** `test/extension/ServiceCommands.test.ts` 直接构造一个服务树的 `LoadMoreTreeItem`，拿它 `command.command` 去 `activate` 注册表里查——节点带的 id 与真正注册的 id 从此不会各走各的。`Manifest.test.ts` 那条「注册的命令集合 === 贡献的命令集合」是另一半保险。

**⑤ 面板不嵌浏览器这条在真机上仍然成立。** 集群信息是两次普通的 API 调用（`/v1/core/cluster/nodes` 与 `/v1/ns/operator/metrics?onlyStatus=false`），拿到的是结构化 JSON，没有任何一项非得靠渲染 Nacos 控制台的页面才能得到。M1 删掉 iframe 助手的决定到这里没有被推翻。

**M3 Task 3–4 仍未覆盖的：**

23. **面板从未在扩展宿主里渲染过。** vitest 里断言的是 HTML 字符串。CSP 是否真的放行了那个 bundle、`var(--vscode-*)` 在深色与浅色主题下的实际观感、raft 展开的点击、刷新按钮的一个来回，都没有在真的 VS Code 窗口里看过。`webview/nacos-cluster-status/index.ts` 因此是本仓库里除 M1 表单页脚本之外唯一没有自动化覆盖的文件——两者处境相同：页面脚本要跑起来需要一个 DOM 与一个 `acquireVsCodeApi`。
24. **多节点集群的表格。** 承 §14.5 ⑲。这台是单节点 standalone，所以多行渲染、跨节点的 raft 成员列表、以及「一个节点 DOWN 而其它节点 UP」的对照，全部只有夹具覆盖。
25. **面板的失败态在真机上没触发过。** 连不上服务器、以及 metrics 被拒而节点列表可用（这正是 3.x console 链的常态，§14.5 ⑱）两条分支都只有夹具覆盖。
26. **中文界面下的排版。** zh-cn 包里每个键都在（`test/webview/ClusterStatusPanel.test.ts` 的本地化用例逐条核对过），但没有在中文 VS Code 里看过实际效果——徽章与指标格是定宽的，中文标签更长。

这些是 M1 整体评审确认过的、有意留到后续里程碑的问题。它们不是缺陷清单里的遗漏，但**开始 M2 之前应当各自有个决定**。

### 14.8 M4 Task 1 五个能力的真机验证（Nacos 2.3.2，2026-08-14）

这一组把 `test/live` 从 19 条加到 26 条。与前几次不同，本轮**一半的能力在这台服务器上验不了**，而验得了的那一半推翻了计划里的三条路径。

**① v2 根本没有订阅者接口，也没有监听者接口。** 实测 `GET /v2/ns/service/subscribers` 与 `GET /v2/cs/config/listener` 都是 **HTTP 404 + Spring 错误页**——不是 410、不是 501，就是没有这个 controller。§9 把 2.x 这两行记作「同左」（即用 v1 路径），这是对的，但读起来像是「v2 也有一份」。`V2Driver` 因此在这两个能力上回到 v1 路径，订阅者还要连带回到 v1 的命名方言（分组写进 `serviceName`）。

**② `/v2/cs/history/list` 存在，但它要的是 `group`——v1 的拼法。**

```
GET /v2/cs/history/list?dataId=...&groupName=cl-intimfy&namespaceId=cl-parent
  → 400 {"code":10000,"message":"parameter missing",
         "data":"Required request parameter 'group' for method parameter type String is not present"}
GET /v2/cs/history/list?dataId=...&group=cl-intimfy&namespaceId=cl-parent
  → 200 {"code":0,"message":"success","data":{"totalCount":0,...}}
```

`namespaceId` 与 `tenant` 都不是必填（省略也返回 200），所以**它到底读哪一个，这台服务器无法分辨**——历史全空，两种拼法都返回 0 条。这是第三种方言：v1 的 `group` 配 v2 的 `namespaceId`。§6.1 的两个映射函数是成对使用的（半个方言会被静默丢弃），引入一个半 v1 半 v2 的组合会破坏那条约定，而 v1 路径在同一台服务器上答的是同样的行。**所以 `V2Driver` 的历史也走 v1 路径**，与它的配置能力一致。`/v2/cs/history` 详情同理。

**③ 「历史版本不存在」是 HTTP 200 + 空 body，与 §14.2 ⓪ 的配置详情一模一样。** v1 上 `GET /v1/cs/history?nid=999999&...` 返回零字节；v2 上 `GET /v2/cs/history?nid=999999&...` 返回 `{"code":0,"message":"success","data":null}`。两条都被 `fetchConfigDetail` 已有的判据接住（2xx 但解包后为空 = 资源不存在），所以 `getConfigHistory` 直接复用它而不是另写一条读取路径——这也是 live 里唯一一条**历史相关且真机可验**的断言。

**④ v1 的服务详情与订阅者都认 `groupName`，但分组名写进 `serviceName` 时以后者为准。** 实测：`serviceName=cl-intimfy@@cl-auth-offline&groupName=DEFAULT_GROUP` 仍然解析成 `cl-intimfy@@cl-auth-offline` 并正常返回；而 `serviceName=cl-auth-offline`（不带分组）无论带不带 `groupName=DEFAULT_GROUP` 都解析成 `DEFAULT_GROUP@@cl-auth-offline`，答 **HTTP 500** `caused: service not found, ...;`（v2 同样情况是 HTTP 400 `{"code":21008,"message":"service not exist"}`）。两者都归类为 `api-error`，不触发降级——正确，因为换一个 API 版本变不出一个没注册的服务。结论：driver 只发拼好的分组名，且这个选择不会被顺带传去的 `groupName` 推翻。

**⑤ 服务详情的两种形状与 §6.7 完全一致**，两边都是真机原文：v1 是 `clusters` 数组 + `name` + `namespaceId`，v2 是 `clusterMap` 对象 + `serviceName` + `namespace`。v2 的 `selector` 里有两个重名的 `type` 键（`"type":"NoneSelector","type":"none"`），`JSON.parse` 取后者；本轮没有读 `selector`，记一笔备查。

**⑥ 订阅者的顶层形状确认为 `{subscribers, count}`，而且这台服务器上到处都是。** 12 个服务全部有订阅者，其中 `cl-merchant-server-offline` 有两个（`192.168.99.92` 与 `192.168.66.124`）——所以多行分支也有了真机覆盖，不只是单条。`port` 全是 0（gRPC 订阅者没有回调端口），`cluster` 全是空串，`serviceName` 全带 `cl-intimfy@@` 前缀。v1 接口对 `pageNo`/`pageSize` 是可选的（源码默认 1000），所以 driver 在 v1/v2 上**不发分页**——发本项目的 100 反而会把服务端已经给的东西砍掉；只有 3.x 的分页形态需要显式要一页。

**M4 Task 1 仍未覆盖的：**

27. **历史条目与监听者条目的字段名。** 这台服务器上没有任何配置被重新发布过，也没有任何客户端在长轮询，所以两个接口在**每个命名空间的每条配置上**都返回空。验到的是分页信封（v1 裸 `Page`、v2 包装）、拼错的 `lisentersGroupkeyStatus` 键、以及「空不是失败」这三件事；**没有验到的是一行真实数据长什么样**——`opType` 的尾随空格、`createdTime`/`lastModifiedTime` 是 ISO 字符串还是毫秒、`id` 是数字还是字符串，全部来自 `ConfigHistoryInfo` 的源码而非实测。归一化因此对两套字段名、两种时间类型都收，并且 `Date.parse` 失败留 `undefined` 而不是 `NaN`——这不是兜底，而是在拿不到实测依据时唯一站得住的写法。**M5 发布配置后会产生历史记录，届时必须回来补验这一条。**
28. **`/v2/cs/history/list` 读的是 `namespaceId` 还是 `tenant`。** 见 ② ——历史全空，无法分辨。目前不影响任何代码路径（v2 走 v1 路径），但如果将来有人把 v2 的历史换回它自己的路径，这一条会先咬人。
29. **3.x 的五条路径与它们的响应形状。** `/v3/{admin,console}/cs/history/list`、`/v3/{admin,console}/cs/history`、`/v3/{admin,console}/cs/config/listener`、`/v3/{admin,console}/ns/service`、`/v3/{admin,console}/ns/service/subscribers`，全部照 §9 与调研写成，没有 3.x 环境跑过。风险最高的是订阅者：3.x 按调研是 `data.pageItems[]`，与这台服务器给的 `{subscribers, count}` 不同，归一化两种都收，猜错顶多是「仍然能解析」。
30. **admin 监听者接口需要 WRITE 权限这条降级。** §9 说 `/v3/admin/cs/config/listener` 要 WRITE 而 console 版只要 READ，也就是说这是唯一一个「管理员账号也可能被拒、普通账号必须走 console」的读能力。只有夹具覆盖。

### 14.9 M4 Task 2–3 历史 URI、diff 与两个面板的真机验证（Nacos 2.3.2，2026-08-14）

Task 1 把五个能力做到了 `NacosClient`，这一组把它们做成用户能点的东西：历史面板、监听者面板、订阅者面板，以及三个 diff 入口。`test/live` 从 26 条加到 33 条。**这一轮验到的与验不到的，界线和 §14.8 一样锋利，而且是同一条线**：有真实数据的能验，没有的不能。

**① 跨环境对比是真的通了，而且两侧内容确实不同。** 命令走完整条路——列命名空间 → 选目标 → 探测目标是否有这条配置 → `vscode.diff`——然后测试再把交给 `vscode.diff` 的那两个 URI 分别喂回文档提供器：

```
sentinel-cl-gateway: live / cl-parent compared with live / damon
  left  nacos:/live/cl-parent/cl-intimfy/sentinel-cl-gateway (858 bytes)
  right nacos:/live/damon/cl-intimfy/sentinel-cl-gateway (677 bytes)
  the two sides differ
```

这一条闭合的是整个地址往返：**构造 → 解析 → 重新取内容**。一个在回程上把命名空间丢掉的 URI 会让两侧变成同一段文本，这里就会红。

**② 修正：配置列表里的 `md5` 在这台服务器上恒为 `null`，`search=accurate` 也一样。** 实测 `/v1/cs/configs?search=accurate&...` 每一行都是 `"md5": null`（`id`、`type`、`content` 都有值），只有详情接口 `?show=all` 填了真的 md5。所以 **`NacosConfigSummary.md5` 不能用来判断两份副本是否相同**——live 里挑「内容不同的一对命名空间」原本想用列表的 md5 免掉请求，结果只能改成取两次详情比内容。

这条同时解释了监听者面板为什么必须自己取一次详情：它判断「某个客户端是否落后」要拿配置当前的 md5，而树节点手上那个 summary 的 md5 是空的。取详情的代价是把配置正文（含这套部署的 redis 密码）读进内存，所以 `loadConfigListeners` **只把 md5 放进快照**，live 里有一条断言直接对快照做 `not.toContain('password')`。

**③ 「历史版本不存在」这条路径端到端跑通了，而且说的是版本不在而不是配置不在。**

```
nacos:/live/cl-parent/cl-intimfy/application-dev.yml?nid=99999999
  -> Version 99999999 of application-dev.yml is no longer on the server.
     Nacos keeps a configuration's history for a limited time and prunes what is older.
```

Nacos 默认只保留 30 天历史，所以「面板开着过了个周末，点某一版时它已经被清了」是真实场景。这里如果沿用配置那句「已不存在」，用户会去找一次没发生过的删除。

**④ 订阅者面板在真机上是满的，多行分支也有了。** `cl-parent-offline` 的 12 个服务全部渲染出行；`cl-merchant-server-offline` 渲染出两行（`192.168.99.92` 与 `192.168.66.124`）。端口全是 0——这是答案不是缺失，所以那一列写「none」而不是走 "not reported" 的样式，地址列也不写 `ip:0`。

**⑤ 历史与监听者两个面板，真机上只验到空态。** 两个接口在这台服务器上对每条配置都返回空，所以跑到的是「Nacos 没有返回任何历史版本 / 任何持有该配置的客户端」这两句话，以及「空不是失败」。**行的渲染——`opType` 的三种译法、时间列、来源 IP/用户、md5 落后徽章与那句「N 个客户端中有 M 个仍持有旧版本」——全部只有夹具覆盖。** M5 发布配置之后历史会长出来，监听者要有客户端长轮询才会有。

**M4 Task 2–3 仍未覆盖的：**

31. **历史行与监听者行的渲染。** 承 §14.8 ㉗。夹具照 `ConfigHistoryInfo` 与 `lisentersGroupkeyStatus` 写成，真机上两张表都没有一行。**M5 之后必须回来补。**
32. **历史分页的顺序假设。** 「与上一版对比」只取第 1 页第 1 条，依据是 Nacos 的 `order by nid desc`（最新在前）；这台服务器一条历史都没有，所以顺序无从验证。若某个版本改成升序，这个命令会去比最老的那一版。
33. **「历史行存的是改动前的内容」这一条。** `insertConfigHistoryAtomic` 在更新时写的是旧值，所以最近一条历史 = 上一个版本——这是「与上一版对比」成立的前提，来自源码而非实测。
34. **`?nid=` 这个 query 在真正的 `Uri.parse` 上的往返。** vitest 用的是 `test-fixtures/vscode.ts` 的 `Uri`，它不做百分号编码；真实的 `vscode.Uri.toString()` 会把 query 编码、`parse()` 再解码回来。往返在两侧都成立（编码一次、解码一次），但只有扩展宿主里才验得到。
35. **三个新面板从未在扩展宿主里渲染过。** 承 §14.7 ㉓。断言的是 HTML 字符串：CSP 是否真的放行了两个新 bundle、`.listener-behind` 那个红徽章在深浅主题下的观感、历史面板每行那个「与当前版本对比」按钮点下去的一个来回，都没有在真的 VS Code 窗口里看过。
36. **右键菜单本身。** `when` 子句是按 `viewItem` 的正则写的，`Manifest.test.ts` 把它编译出来对着真实节点的 contextValue 做了断言（含 `.readonly` 变体，以及 `atNacos.serviceInstance` 不能被 `^atNacos\.service\b` 命中这一条），但没有人在真的树上右键点过。
37. **同一条配置同时开着历史面板与监听者面板时的 key 隔离**，只有单测覆盖（两个面板 key 前缀不同）。真机上没有同时开过。

### 16.1 错误文案没有本地化

`t()` 的覆盖是完整的——`src/` 里 54 处 `t()` 字面量全部在 zh-cn 包里有键。但出问题时用户读到的那些句子从来不经过 `t()`：`testNacosConnection` 里 `describeConnectionFailure` 的十二个分支、`describeForbidden`，以及 `ErrorTreeItem` 渲染的每一条 `NacosApiError` 消息。中文用户会看到一个完全汉化的界面，直到出错，然后是一段英文。

原因是结构性的：这些句子由地址、状态码和服务端原话拼装而成，没有可以作为翻译键的源字符串；而且它们产自 `src/nacos/**`，那一层按约定不能 import `vscode`，也就够不到 `t()`。

修法方向：失败结果已经带了 `reason`、`kind`、`status`、`triedBaseUrls` 等结构化字段，正是为此准备的。由呈现层（webview 与树）按 `reason` 选择本地化模板重建句子，而不是把 `src/nacos/**` 产出的英文原样显示。

§3 记录的决定是「完整中英双语」，无保留条件，所以这是一笔明确的欠债。

### 16.2 3.x 非管理员账号每次刷新多花一次登录

`UserPasswordStrategy.refresh()` 无条件返回 `true` 并丢弃缓存的 token，而 `withAuth` 见到任何 403 都会调它。3.x 非管理员的标准流程因此变成：登录 → 探测 → `v3-admin` 403 → **丢弃刚签发几秒的 token** → 再登录 → `v3-admin` 再 403 → 才降级到 console。两次登录、四个请求，而一次登录、两个请求就够。

因为 `createNacosClient` 每次刷新都新建客户端（这个设计本身是对的，理由在 `extension.ts` 的注释里），resolver 的能力缓存随之失效，所以这是稳态成本而非首次成本。两个视图都展开时是每次刷新四次登录，每次服务端都要做一遍 BCrypt。

修法：让 `refresh()` 在当前 token 签发时间过近时返回 `false`——一个刚签发一秒的 token 收到 403，那是权限问题不是过期问题，而这正是重试机制要区分的东西。

### 16.3 换认证方式时是否保留旧密码，两处结论相反

`NacosInstanceConfigManager` 的测试断言「换认证方式保留已存密码」，理由是「误点两下不该赔上密码」。而 `NacosInstanceFormPanel` 做的正好相反，理由是「一个用户再也无法从任何设置触达的密码，没有留在 SecretStorage 里的道理」。两种行为各自有测试，所以测试套件是绿的，而代码库在自相矛盾。

manager 的那条行为实际上不可达——唯一的生产调用方总是显式传 `''`。所以那条测试断言的是一个没有用户会遇到的默认值，而它的理由陈述对产品而言是错的。**选一个策略，删掉另一处的理由陈述。**

### 16.4 自动发现的 console 地址会跨服务器变更残留

对服务器 A 做连接测试（自动填入 A 的 console 地址），随后把服务端地址改成 B 并保存而不清空 console 字段，B 就会用上 A 的 console 地址。字段是可见可编辑的，用户能看到将要保存什么，这是把值写进输入框而不是暗中留存的主要理由——但重新测试不会清掉它，因为非空字段按设计会抑制发现。

### 16.5 无法取消信任一张证书

`NacosCertTrustStore.forget()` 存在且有测试，但没有任何命令或 UI 调用它。用户一旦信任了一张证书，除了手工编辑 `globalState` 之外没有反悔的办法。

### 16.6 非 ASCII dataId 的标签页标题是百分号编码（M2 完成时记录）

`buildConfigUri` 对每个路径段做 `encodeURIComponent`，这是必需的：dataId 合法地含 `/`，不编码就会把路径切成五段，`parseConfigUri` 的四段规则随之失效。代价是 `vscode.Uri.from({ path })` 把传进去的字符串**原样**当作已解码的 path 存下来，于是 `uri.path` 里躺着的就是 `%E8%AE%A2...`，而标签页标题取的正是它。dataId 为 `订单服务.yaml` 的配置，标签页会写成 `%E8%AE%A2%E5%8D%95%E6%9C%8D%E5%8A%A1.yaml`。对一个面向中文用户的插件，这不是理论代价。

**`contributes.resourceLabelFormatters` 修不了这一条。** 读 VS Code 源码确认（`src/vs/workbench/services/label/common/labelService.ts`、`src/vs/workbench/common/editor/resourceEditorInput.ts`）：

- 标签页标题这条链路确实经过 formatter：`AbstractResourceEditorInput.getName()` → `labelService.getUriBasenameLabel(resource)` → `basename(formatUri(...))`。
- 但 `formatUri` 的模板只认五个 token（`labelMatchingRegexp`）：`${scheme}` / `${authority}` / `${authoritySuffix}` / `${path}` / `${query.KEY}`。其中 `case 'path'` 直接返回 `resource.path`，整个文件没有任何一处 `decodeURI*`。

也就是说 `label: "${path}"` 拿到的就是我们自己写进去的那串编码，加不加这条 contribution 结果一模一样。所以 M2 **没有**加它：一条什么都不做的 contribution 比不加更糟，它会让下一个人以为这里已经处理过。

真正走得通的有两条，都不是 manifest 改动，因此都留待专门决定：

1. **`${query.dataId}` + 在 URI 上挂一个 JSON query。** `formatUri` 会对 `resource.query` 做 `JSON.parse` 再取键，所以这条确实能显示出原文。但它等于把 dataId 在文档主键里写两遍、纯为显示；两份一旦不一致，同一条配置就会开出两个 buffer。而且 dataId 含 `/` 时 `basename` 仍会把前缀切掉。
2. **只编码会破坏路径结构的字符**（`%` 与 `/`），其余原样进 path。`uri.path` 于是是 `/inst/uat/cl-intimfy/订单服务.yaml`，标签页不需要任何 contribution 就是对的，含 `/` 的 dataId 退化成 `com%2Fexample%2Fservice.yml`。这是更干净的解，但它改的是 `configUri.ts` 的编码约定，会改变每一个已打开文档的身份（VS Code 按 `uri.toString()` 认文档），应当单独决定而不是顺手带过。

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
