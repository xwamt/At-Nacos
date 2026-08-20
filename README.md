# AT Nacos

<p align="center">
  <b>VS Code / Cursor 专业的 Nacos 配置管理、服务发现与运维协同插件</b>
  <br />
  <sub>作为 AT Series 开发者工具套件的一员，为微服务架构提供无缝的 IDE 原生 Nacos 操作体验与 AI Agent MCP 互通能力。</sub>
</p>

---

## 🌟 核心特性

### 1. 多实例与多版本兼容 (M1 & M2)
- **跨版本全兼容**：全面支持 Nacos **1.x**、**2.x**、**3.x**（包括 3.x Admin API 与 Console API 自动降级与适配）。
- **多种鉴权策略**：支持账号密码（User/Password）、静态 Token、自定义请求头以及阿里云/官方 AK/SK 签名鉴权。
- **凭据安全存储**：敏感密码及 Token 使用 VS Code 原生 `SecretStorage` 加密存储，不存明文。
- **TLS 首次信任 (TOFU)**：HTTPS 自签名证书首次连接弹窗确认并计算 SHA-256 指纹记录，防中间人劫持。
- **只读实例安全模式**：支持将生产环境配置为“只读实例”，UI 层隐藏写操作，运行时底层硬拦截所有写请求。

### 2. 配置中心管理 (M3)
- **树状结构导航**：按 `实例 -> 命名空间 -> 分组 (Group) -> 配置 (Data ID)` 层级清晰展示。
- **多标签页独立查看**：支持同时打开多个配置文件的独立虚拟文档 (`nacos:`) 标签页，便于对照与查阅。
- **智能语言高亮**：根据 Data ID 后缀与内容智能识别 `YAML`、`Properties`、`JSON`、`XML`、`TOML`、`HTML` 等语法。
- **增量分页与搜索**：支持大数据量下的流式与翻页加载，支持命名空间与配置关键字快速过滤。

### 3. 服务发现与实例运维 (M3 & M5)
- **服务状态监控**：直观展示每个服务的健康实例比例（如 `2/2`、`1/2`）及健康状态图标。
- **全量实例查看**：无缝对接 Nacos 控制台 Catalog 管理接口，完整展现**已上线**与**已下线 (disabled)** 的所有实例。
- **实例一键上下线**：支持在服务实例节点右键点击执行**「上线实例」**与**「下线实例」**，实时控制微服务流量路由。
- **监听者与订阅者面板**：支持查看服务订阅客户端列表与配置监听客户端详情。

### 4. 高级配置检查与对比 (M4)
- **历史版本回溯**：Webview 面板呈现配置的历史发布记录，查看变更时间、发布人及变更类型。
- **版本差异对比 (Diff)**：一键调用 VS Code 原生 Diff 编辑器，将当前配置与历史版本进行并排高亮比对。
- **跨环境/跨命名空间比对**：支持选择不同环境或命名空间下的同名配置进行一键比对。

### 5. 安全可控的写操作 (M5)
- **草稿编辑体系**：基于内存文件系统 (`nacos-draft:`)，编辑配置不影响线上，保存草稿随时调整。
- **并发冲突检测**：发布时校验服务端 MD5，发现已被他人修改时提示冲突并提供合并比对。
- **强制 Diff 预览与二次确认**：点击发布/回滚/删除时，强制弹出原生 Diff 预览与破坏性操作模态确认框。

### 6. 集群状态监控 (M4)
- **节点拓扑看板**：图形化展示 Nacos 集群各节点 IP、端口、健康状态、Raft Leader 选举状态与 Term 任期。
- **运行时指标**：直观展示服务总数、实例总数、订阅者数、CPU 负载及内存使用率。

### 7. AI Agent 与 MCP 支持 (M6)
- **内置 13 个只读 MCP 工具**：
  1. `nacos_list_instances`：列出已配置的插件连接（不是服务实例）
  2. `nacos_list_namespaces`：查询命名空间（含默认命名空间）
  3. `nacos_list_configs`：服务端过滤的配置列表（不含正文）
  4. `nacos_get_config`：获取配置详细内容（默认脱敏）
  5. `nacos_list_services`：查询注册服务（`serviceName` / `ignoreEmptyService`）
  6. `nacos_get_service`：获取服务元数据（不含实例列表）
  7. `nacos_list_service_instances`：列出某个服务的注册主机
  8. `nacos_get_cluster_nodes`：查询集群节点拓扑与指标
  9. `nacos_list_config_history`：配置历史列表
  10. `nacos_get_config_history`：某一历史版本（默认脱敏）
  11. `nacos_list_config_listeners`：某条配置的监听者
  12. `nacos_list_service_subscribers`：某个服务的订阅者
  13. `nacos_list_listened_configs`：按客户端 IP 反查已订阅配置
- **敏感数据脱敏**：默认对密码、密钥、Token 等关键字内容执行星号脱敏，防止数据泄露。
- **MCP Hub 互通**：支持通过 Bridge 本地桥接服务无缝接入 `@at-series/mcp-hub`。

---

## 🚀 编译与打包

### 前置要求
- Node.js 18+
- npm 或 pnpm

### 本地构建
```bash
# 安装依赖
npm install

# 运行自动化测试 (1800+ 单元测试)
npm test

# 类型检查
npm run typecheck

# 编译扩展与 Webview
npm run build

# 打包 VSIX 插件
npm run package
```
打包成功后，将在根目录下生成 `at-nacos-0.1.1.vsix`。

---

## 📦 安装与使用

1. 打开 VS Code 或 Cursor。
2. 进入扩展视图（Extensions），点击右上角 **`⋯` (更多操作) -> 从 VSIX 安装... (Install from VSIX...)**。
3. 选择生成的 `at-nacos-0.1.1.vsix` 文件完成安装。
4. 在左侧活动栏点击 **AT Nacos** 图标，点击 **「添加 Nacos 实例」** 即可开始使用。

---

## 🛡️ 架构与测试

本项目采用严格的分层架构设计：
- **Driver 驱动层**：针对 Nacos 1.x、2.x、3.x 提供统一的抽象驱动，自动探测与回退。
- **Virtual Document 虚拟文档层**：基于 `TextDocumentContentProvider` 与只读/草稿文件系统实现安全的编辑查看体验。
- **Webview UI 层**：纯原生现代深色风格 Webview，零多余依赖，极速响应。
- **自动化测试**：覆盖全量 Driver、Resolver、安全拦截、并发锁、MCP 协议等，包含 **1800+** 单元测试与 100% 覆盖率保证。

---

## 📄 开源许可

[MIT License](LICENSE)

