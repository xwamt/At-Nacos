# 更新日志 (Changelog)

所有关键版本的更新记录都将在此文档中记录。

---

## [v0.1.2] - 2026-08-21

**MCP 对齐官方工具切分与查询语义 🤖**

本次更新对照官方 Nacos MCP 的工具切分与查询语义，将只读 MCP 从 8 个扩展到 13 个；配置/服务列表过滤下推服务端，并补齐历史、监听者、订阅者与按客户端 IP 反查。界面可写路径不变，MCP 仍全部只读。

### 🤖 MCP 工具对齐 (Official MCP Alignment)
- **13 个只读工具**：在原有实例 / 命名空间 / 配置 / 服务 / 集群能力上，新增配置历史、监听者、订阅者、服务实例列表、按客户端 IP 反查已订阅配置。
- **配置列表服务端过滤**：支持 `type` / `configTags` / `appName` / 显式 `search`；省略 `search` 为 `accurate`（不是官方默认 `blur`）；列表不含正文，正文只走 `nacos_get_config`。
- **服务列表对齐 Admin API**：`group` → `groupNameParam`，`serviceName` → `serviceNameParam`；MCP 默认忽略空服务，树视图仍显示空服务；永不展开 `withInstances`。
- **服务元数据与实例列表拆分**：`nacos_get_service` 不含 hosts；注册主机走 `nacos_list_service_instances`（与插件连接列表 `nacos_list_instances` 区分）。
- **集群聚合**：3.x 监听者 / 订阅者 / 反查默认 `aggregation=true`，避免多节点只看到打到的那一台。
- **按 IP 反查已订阅配置**：1.x/2.x `/v1/cs/listener`；3.x Admin `/v3/admin/cs/listener`；Console `/v3/console/cs/config/listener/ip`；兼容 `listenersStatus`。
- **工具描述契约**：默认值、通配符、`DEFAULT_GROUP`、命名空间 id（1.x/2.x 空串，勿传 `public`）、大页内存代价写入 Agent 可见 description。

### 🧪 测试与质量
- 新增配置过滤下推、服务检索、历史 / 监听 / 订阅 MCP、按 IP 反查与工具描述契约的自动化测试，全套 **1890** 个测试用例全部通过。

---

## [v0.1.1] - 2026-08-17

**性能深度优化与编辑同步缺陷修复 🚀**

本次更新重点解决了公网 API / 远程网络环境下的操作响应延迟问题，并完善了草稿编辑保存与关闭时的同步发布机制与交互加载反馈。

### ⚡ 性能优化 (Performance Optimizations)
- **客户端连接池与会话缓存 (`NacosClientPool`)**：引入实例级客户端池，在 Token 生命周期内全局复用 JWT Token，避免每次操作重复请求 `/login` 及服务端 BCrypt 密码哈希计算；复用已探测的服务端版本与控制台地址，将每次操作的 3~4 次串行网络往返缩减为 1 次直接业务请求。
- **持久 HTTP Keep-Alive 连接复用**：在 `NacosHttpClient` 中启用全局 `http.Agent` / `https.Agent` 持久连接池，复用 TCP 握手与 TLS 会话，公网操作响应从 2~4 秒暴降至 100~200 毫秒。
- **智能缓存失效机制**：修改/保存实例配置时自动淘汰旧缓存，点击树顶部「刷新」按钮主动重置并重新建立连接。

### 🛠️ 缺陷修复与体验提升 (Bug Fixes & UX Enhancements)
- **修复草稿未保存关闭标签页点击保存无法同步至 Nacos 的问题**：监听 `onDidSaveTextDocument` 事件，用户按 `Cmd+S` / `Ctrl+S` 或在关闭未保存标签页弹窗中点击「保存」时，自动触发 Diff 差异对比与二次确认发布流程，确保改动真实提交至 Nacos 服务端。
- **关闭标签页自动清理已同步草稿**：标签页关闭后自动释放已发布的内存草稿，保证下次编辑时拉取服务端最新数据。
- **全链路异步加载中进度反馈**：在打开只读配置、打开编辑草稿、历史版本比对、跨环境对比及分页加载操作中，全面引入即时的 VS Code Notification 进度反馈（带 Spinner 动画与多语言文案），彻底解决慢速网络下点击无响应的体验空白。

### 🧪 测试与质量
- 新增 `NacosClientPool`、加载进度通知、草稿保存/关闭生命周期的自动化单元测试，全套 1814 个测试用例全部通过。

---

## [v0.1.0] - 2026-08-14

**AT Nacos 首发版本正式发布！🎉**

AT Nacos 是一款面向 VS Code 与 Cursor 的专业级 Nacos 运维与开发管理插件，作为 AT Series 开发者套件的一员，为微服务开发者提供无缝的 IDE 原生配置管理、服务发现、集群监控以及 AI Agent MCP 互通能力。

### 🌟 核心特性与功能亮点

#### 1. 多实例与多版本兼容 (Multi-Instance & Version Adaptation)
- **版本全覆盖**：统一抽象驱动层，全面兼容 Nacos **1.x**、**2.x**、**3.x**（包括 3.x Admin API 与 Console API 自动降级与探测）。
- **多种鉴权支持**：支持账号密码 (User/Password)、静态 Token、自定义 Header 以及阿里云/官方 AK/SK 签名鉴权。
- **安全存储**：密码及 Token 使用 VS Code 原生 `SecretStorage` 加密存储。
- **TLS 首次信任 (TOFU)**：HTTPS 自签名证书首次连接弹窗确认并计算 SHA-256 指纹记录，防中间人劫持。
- **只读实例保护**：支持配置生产环境为只读实例，UI 层隐藏写操作，运行时拦截写请求。

#### 2. 配置中心管理 (Config Management)
- **层级树状导航**：按 `实例 -> 命名空间 -> 分组 (Group) -> 配置 (Data ID)` 清晰展现。
- **多标签页独立查阅**：支持同时打开多个配置文件的独立虚拟文档 (`nacos:`) 标签页，便于对照查阅。
- **智能语法高亮**：智能识别 YAML、Properties、JSON、XML、TOML、HTML 等多种配置语言。
- **增量翻页与过滤**：支持大数据量下的流式与翻页加载，支持命名空间与配置关键字快速过滤。

#### 3. 服务发现与实例运维 (Service Discovery & Operations)
- **服务健康监控**：直观展示服务健康实例比例（如 `2/2`、`1/2`）及健康状态图标。
- **全量实例展现**：无缝对接 Nacos 控制台 Catalog 管理接口，完整展现已上线与已下线 (disabled) 的全量实例。
- **实例一键上下线**：支持在服务实例节点右键执行**「上线实例」**与**「下线实例」**，实时控制微服务流量路由。
- **监听者与订阅者**：支持查看服务订阅客户端列表与配置监听客户端详情。

#### 4. 高级配置检查与对比 (Inspection & Diff)
- **历史版本回溯**：Webview 面板呈现配置的历史发布记录，查看变更时间、发布人及变更类型。
- **版本差异对比 (Diff)**：一键调用 VS Code 原生 Diff 编辑器，将当前配置与历史版本进行并排高亮比对。
- **跨环境/跨命名空间比对**：支持选择不同环境或命名空间下的同名配置进行一键比对。

#### 5. 安全可控的写操作体系 (Safe Writes)
- **草稿编辑体系**：基于内存文件系统 (`nacos-draft:`)，编辑配置不影响线上，保存草稿随时调整。
- **并发冲突检测**：发布时校验服务端 MD5，发现已被他人修改时提示冲突并提供合并比对。
- **强制 Diff 预览与二次确认**：点击发布/回滚/删除时，强制弹出原生 Diff 预览与破坏性操作模态确认框。

#### 6. 集群状态监控 (Cluster Inspection)
- **节点拓扑看板**：图形化展示 Nacos 集群各节点 IP、端口、健康状态、Raft Leader 选举状态与 Term 任期。
- **运行时指标**：直观展示服务总数、实例总数、订阅者数、CPU 负载及内存使用率。

#### 7. AI Agent 与 MCP 支持 (MCP Integration)
- **内置 7 大只读 MCP 工具**：
  1. `nacos_list_instances`：列出已配置的 Nacos 实例
  2. `nacos_list_namespaces`：查询实例的命名空间列表
  3. `nacos_list_configs`：查询配置列表
  4. `nacos_get_config`：获取配置详细内容
  5. `nacos_list_services`：查询服务发现列表
  6. `nacos_get_service`：获取服务元数据与集群详情
  7. `nacos_get_cluster_nodes`：查询集群节点拓扑与状态
- **敏感数据脱敏**：默认对密码、密钥、Token 等关键字内容执行星号脱敏，防止数据泄露。
- **MCP Hub 互通**：内置 Bridge 桥接服务，无缝接入 `@at-series/mcp-hub`。

---

### 🧪 自动化测试与工程质量
- 包含 **1800+** 自动化单元测试，100% 通过率。
- 完整的 TypeScript 类型检查与静态代码规范。
