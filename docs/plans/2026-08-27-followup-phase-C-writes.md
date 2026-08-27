# AT Nacos Phase C —— 驱动写能力加宽 实现计划

> **Status:** 待执行的实现计划（docs only，本文档不含任何产品代码改动）。
>
> **前置依赖:** Phase 0 + Phase A（面板与设置项——尤其 A7 服务详情面板、B1 `contributes.configuration`；见 `docs/plans/2026-08-27-followup-roadmap.md`）。另依赖「1–8 项优化」批次中的两项：`atNacos.createConfig` 的 createNew 空草稿路径（分支 `cursor/opt-create-config-6a9b`，commit `a5701da`）与写后刷新（`cursor/opt-write-refresh-6a9b`）。**若这些尚未合入 main，先合它们，再动本计划。**
>
> **规格真源:** `docs/plans/2026-08-13-at-nacos-architecture.md`（下称「架构文档」），尤其 §6.1（参数方言）、§6.2（public 命名空间）、§9（能力矩阵）、§14.2 ①'（参数名传错是静默失败）、§14.9 ②（列表 md5 恒为 null）。写路径的既有决策见 `docs/plans/2026-08-14-at-nacos-m5-write.md`。
>
> **执行方式:** 每个 Task 一个独立 commit；建议按 §2 的分组拆 PR。TDD：先写测试后写实现，vitest 全绿才算完。

---

## 0. 范围与非目标

**做（对应路线图 C1–C6）：**

| ID | 项 | 一句话 |
|---|---|---|
| C1 | 实例权重 / 元数据编辑 | 泛化实例更新类型；写前必须重拉实例；确认框展示将写入的完整行 |
| C2 | 配置克隆 / 跨环境复制 | 复用跨环境对比的选择器 + 现有 `publishConfig` 管线；目标缺失时按 createNew 空基线处理；绝不跳过 diff |
| C3 | 命名空间 CRUD | 驱动新增三方法（四 flavor 一次齐改）；删除仅限空命名空间；MCP 本阶段绝不暴露 |
| C4 | tags / appName / description 编辑 | 详情与发布补 `configTags` 透传（`config_tags` vs `configTags` 方言）；UI 可改三项元信息 |
| C5 | CAS 发布（casMd5） | v2/v3 走服务端 CAS；v1 降级为发布前最后一秒重读；接通闲置的 `DraftEntry.baseMd5` |
| C6 | 删除空服务 | 仅空服务；非空留给控制台 |

**不做（本阶段非目标，出现在任何 Task 里都算跑偏）：**

- AK/SK 签名（Phase D1）
- MCP 写工具（Phase D2）——**C3 的命名空间 CRUD 与 C6 的删除服务尤其不进 MCP**
- 灰度 / Beta 发布（Phase D3）
- zip 导入导出（Phase D4）
- 用户 / 角色 / 权限管理（永久留给控制台）

---

## 1. 全局约束（写路径公理，每个 Task 逐条核对）

这些不是建议，是既有代码里已经付过学费的规则。违反任何一条的实现不予验收。

1. **写请求走 `form`，不走 JSON body。** Nacos 所有写端点用 `@RequestParam` 绑参：1.x/2.x 直接注解，3.x 走 command object，两者都只从 query string 与 `application/x-www-form-urlencoded` body 读。JSON body 不会被拒绝——它被**忽略**，然后服务端回 `parameter missing`，点名一个请求里明明发了的字段。见 `src/nacos/driver/writes.ts` 顶部 `publishConfigAt` 的注释。
2. **DELETE 的参数进 query string，不进 form。** Servlet 容器只对 POST 解析 form body，DELETE 的 form body 到不了任何 `@RequestParam`——1.x 上表现为 HTTP 400 `parameter missing`。见 `deleteConfigAt` 注释。PUT + form 可用（Spring `FormContentFilter`，`updateInstanceHealthAt` 已在真机验证）。
3. **方言成对使用，按端点族而非驱动 flavor 取参数名。** `namespaceParamName` / `groupParamName` / `configTagsParamName`（`src/nacos/driver/normalize.ts`）都按**路径所属的 API 族**取值：`V2Driver` 发配置写请求到 `/v1/cs/configs`，就必须说 v1 方言（`tenant` + `group` + `config_tags`）。半个方言（`tenant` 配 `groupName`）不会被拒绝，会被**静默丢弃**——读的时候是空列表，写的时候是**把配置发进了没人看的命名空间**（`configRefFields` 注释）。
4. **写响应必须走 `assertWriteAccepted`**（`src/nacos/driver/writes.ts`）。它已处理四种应答形状（裸 `true` / `{"code":0,"data":true}` / 裸 `ok` / `{"code":0,"data":"ok"}`），并把 **HTTP 200 + `false` 判为拒绝**（Nacos 报「没权限/被拒」的方式之一），且拒绝**不触发驱动降级**——被拒的写换一个 API 族重试是灾难。新增的写能力一律复用它，不许自己判 `response.ok`。
5. **只读两层防护，driver 层零防护。** UI 隐藏写菜单（contextValue 的 `.readonly` 后缀不匹配 `when` 子句）防手滑；`assertWritable`（`src/write/confirmWrite.ts`）防命令面板/其他扩展绕过。driver **不知道**什么是只读实例——`NacosDriver` 接口注释明说了原因：一条安全规则放两层，最终会出现两层都不跑的路径。
6. **所有写路径的唯一确认闸门是 `confirmWrite`**（modal + 可选 diff）。任何新写命令绕过它即拒收。
7. **接口加宽拖着四个驱动走。** `NacosDriver` 新增方法时 TypeScript 强制 `V1Driver` / `V2Driver` / `V3AdminDriver` / `V3ConsoleDriver` 全部实现——这是刻意设计（接口注释原话）。**没有对应端点的 flavor 用 `missingCapability` 显式拒绝**（先例：`V3ConsoleDriver.getServerMetrics`），不许留 `throw new Error('TODO')`。
8. **`V3ConsoleDriver` 的每个新方法必须带 `this.onConsoleOrigin()`。** 忘掉 override 的请求打到 server origin，404 读起来像「这个版本没有 console API」（`onConsoleOrigin` 注释）。
9. **每个新 `t()` 字符串同步进 `l10n/bundle.l10n.zh-cn.json`；每个新命令同步进 `package.json` `contributes.commands` + `package.nls.json` / `package.nls.zh-cn.json`。** `test/extension/Manifest.test.ts` 的「注册命令集合 === 贡献命令集合」断言会抓漏网的。
10. **真机验收礼仪**（承 M5 计划 Task 3）：`http://192.168.99.90:8848/nacos` 是别人的开发环境。只在自建的临时命名空间里操作，用完删掉；不碰 `cl-parent*`、`uat`、`damon`、`jack`、`solomon`、`cl-taskcenter`；**实例权重/上下线不要在真机的已有服务上做**——C1 的 live 用例必须先注册一个自己的临时服务实例（或干脆只跑夹具）。C3/C6 的 live 用例天然安全：自己建的命名空间/服务自己删。

---

## 2. 建议 PR 切分与实施顺序

| PR | 内容 | 理由 |
|---|---|---|
| PR-C-α | C1 + C4 + C5 | 三者都是**泛化既有类型**（`NacosInstanceHealthUpdate` → patch 形；`NacosConfigPublish` 加 `configTags` / `casMd5`），改动集中在 `NacosDriver.ts` 类型 + `writes.ts` 共享 helper，四个驱动文件几乎只动 import。一起改一次跑全量测试。 |
| PR-C-β | C3 + C6 | 两者都是**接口新增方法**（命名空间三方法 + `deleteService`），四驱动逐个填路径。一次齐改，TS 编译错误清零即知覆盖完整。 |
| PR-C-γ | C2 | 纯 UI 组合层（选择器 + 草稿 + 既有 publish 管线），不动 driver。依赖 PR-C-α 里 C4 的 `configTags` 透传（克隆要把 tags 一起带过去），故排最后。 |

Task 内部实施顺序：**C1 → C4 → C5 →（发 PR-C-α）→ C3 → C6 →（发 PR-C-β）→ C2 →（发 PR-C-γ）**。

---

## Task C1: 实例权重 / 元数据编辑

### C1.1 现状与问题

- `updateInstanceHealthAt`（`src/nacos/driver/writes.ts`）**已经整行回写**：ip/port/clusterName/enabled/healthy/ephemeral/weight/metadata 全部随 PUT form 发出。原因写在注释里：Nacos 没有「改一个字段」的端点，更新是**从请求重建实例**，请求漏掉的字段一律取 builder 默认值——`weight` 归 1、`healthy` 归 true、metadata 清空（2.3.2 `HttpRequestInstanceBuilder`、3.x `InstanceForm.validate()` 双双核实）。所以驱动层的地基是对的，**缺的只是让 weight/metadata 可以被「改」而不仅是「原样带过」**。
- 但 UI 层有一个真实的过期数据缺口：`extension.ts` 的 `atNacos.enableServiceInstance` / `disableServiceInstance` 直接把 `item.serviceInstance`——**树节点渲染时缓存的实例对象**——传给 `toggleServiceInstanceEnabled`。树刷新到用户右键之间，实例的 weight/metadata 可能已被别人改过；整行回写会**把过期的行写回去**，静默抹掉别人的修改。上下线场景里这个窗口小且后果轻（enabled 是用户要改的），但一旦 weight/metadata 成为可编辑字段，过期行就是主要事故来源。**这就是「写前必须重拉实例」是硬性要求的原因。**
- `NacosInstanceHealthUpdate`（`src/nacos/driver/NacosDriver.ts`）目前长这样：`{ service, instance, enabled: boolean }`——`enabled` 是唯一的 override。要支持改 weight/metadata，需要泛化，但**不能破坏 enable/disable 的现有调用方**（`src/write/updateInstanceHealth.ts`、四个驱动、`NacosClient.updateInstanceHealth`、全部相关测试）。

### C1.2 架构决策

**类型泛化：`enabled: boolean` → `patch` 对象。**

```ts
// src/nacos/driver/NacosDriver.ts
/** 至少一个字段必须出现；全空的 patch 在 helper 层以 NacosApiError('validation') 拒绝。 */
export interface NacosInstancePatch {
  enabled?: boolean;
  weight?: number;
  metadata?: Record<string, string>;
}

export interface NacosInstanceUpdate {
  service: NacosServiceRef;
  /** 必须是写前刚从 listInstances 重拉的行，不是树节点缓存。 */
  instance: NacosInstance;
  patch: NacosInstancePatch;
}
```

- 驱动接口方法名保持 `updateInstanceHealth`（避免动四个驱动的方法体和 resolver 能力名 `instance-health`），只把参数类型从 `NacosInstanceHealthUpdate` 换成 `NacosInstanceUpdate`。四个驱动的实现体本来就是一行转发到 `updateInstanceHealthAt`，所以真正的合并逻辑只写一处：

```ts
// src/nacos/driver/writes.ts — updateInstanceHealthAt 内部
const row = { ...request.instance, ...definedFieldsOf(request.patch) };
// 之后照旧：serviceIdentityParams(endpointFlavor, request.service) + 整行 form 化
```

- **`serviceIdentityParams` 原样复用**（`src/nacos/driver/naming.ts`）：写请求对服务的称呼必须与找到它的读请求一致——v1 分组折进 `serviceName`（`GROUP@@name`），v2/v3 分开 `groupName` + `serviceName`。这是它当初被导出的原因（函数注释原话），不许在 C1 里长出第二种拼法。
- 旧类型 `NacosInstanceHealthUpdate` 直接删除并全仓替换（调用方就 `updateInstanceHealth.ts` 与测试，量小），不做兼容别名——同仓库内不留两个名字。
- **权重预校验范围 0–10000**：2.x `InstanceControllerV2` 的 `checkWeight` 用 `Constants.MAX_WEIGHT_VALUE = 10000 / MIN_WEIGHT_VALUE = 0`；v1 端点源码没有该校验，1.x/3.x 未逐一核对——插件端统一预校验 0–10000 并在校验失败文案里说明这是 Nacos 自身的上限，宁可比 1.x 严也不给用户一个服务端才拒绝的表单。
- **metadata 编辑格式**：InputBox 预填 `JSON.stringify(current, null, 0)`，校验 `JSON.parse` 结果必须是扁平 `Record<string, string>`（值出现非字符串即拒绝，不做隐式 String() 转换——一个 number 值写回去后服务端存的是字符串，下次读回来与用户输入不等，会造成「我明明没改」的假 diff）。form 序列化端已有依据：`updateInstanceHealthAt` 发 `metadata: JSON.stringify(...)`，v1 的 `UtilsAndCommons.parseMetadata` 先试 JSON（注释已记录）。
- **UI 形态**：两个新命令 `atNacos.editInstanceWeight` / `atNacos.editInstanceMetadata`，挂在服务树实例节点右键（enabled 与 disabled 两种 contextValue 都挂，`.readonly` 变体不挂）。A7 服务详情面板落地后可以在面板里加同一命令的按钮入口，但**本 Task 不等 A7**——InputBox 流程独立可用。

**写前重拉（本 Task 的核心安全语义）：**

新增共享 helper：

```ts
// src/write/refetchInstance.ts（新文件，不 import vscode 之外的 UI）
export async function refetchInstance(
  client: Pick<NacosClient, 'listInstances'>,
  service: NacosServiceRef,
  cached: Pick<NacosInstance, 'ip' | 'port' | 'clusterName' | 'ephemeral'>
): Promise<NacosInstance>;
// 匹配键：ip + port + clusterName + ephemeral（四元组在一个服务内唯一）。
// 找不到 → 抛本地化错误「实例 {address} 已不在服务 {serviceName} 中注册（可能已下线或被摘除），未做任何修改」。
```

- `editInstanceWeight` / `editInstanceMetadata` **和现有的 `toggleServiceInstanceEnabled` 一起**改为：连接 → `refetchInstance` → 用**新鲜行**构造 patch → `confirmWrite` → 写。上下线也吃这次修复（路线图 C1 原文：「写前必须重拉实例」不限于权重编辑）。
- 重拉后若新鲜行的目标字段已经等于用户想设的值（例如 weight 已被别人改成同值），照常走确认——不做「无事可做」的静默短路，用户应当看到自己确认的是什么。

**确认框展示完整 payload（第二个硬性要求）：**

`confirmWrite` 的 `detail` 是 modal 的多行明细文本。写实例前必须把**将要 PUT 出去的整行**展示出来，逐字段：

```text
将写入 Nacos 的完整实例行（Nacos 的实例更新是整行覆盖，未列字段不存在）：
  服务:      cl-intimfy@@demo-service / 命名空间 dev
  地址:      192.168.99.92:9202  集群 DEFAULT  ephemeral: true
  enabled:   true
  healthy:   true
  weight:    1 → 5           ← 变更字段用「旧 → 新」标出
  metadata:  {"preserved.register.source":"SPRING_CLOUD"}
```

格式化函数独立成 `describeInstanceRow(row, patch)`（纯函数，可测），三个入口（enable/disable/weight/metadata）共用。metadata 超过 ~200 字符时截断展示并注明「完整内容以此 JSON 开头」，但**发出去的永远是完整行**——截断只发生在展示层。

### C1.3 文件清单

| 文件 | 动作 |
|---|---|
| `src/nacos/driver/NacosDriver.ts` | `NacosInstanceHealthUpdate` → `NacosInstanceUpdate` + `NacosInstancePatch`；接口方法签名更新 |
| `src/nacos/driver/writes.ts` | `updateInstanceHealthAt` 合并 patch；空 patch 抛 `validation` |
| `src/nacos/driver/V1Driver.ts` / `V2Driver.ts` / `V3AdminDriver.ts` / `V3ConsoleDriver.ts` | 类型 import 更新（方法体不变） |
| `src/nacos/NacosClient.ts` | `updateInstanceHealth` 签名更新 |
| `src/write/refetchInstance.ts` | 新增 |
| `src/write/updateInstanceHealth.ts` | `toggleServiceInstanceEnabled` 改为重拉 + patch + 完整行确认；新增 `editServiceInstanceWeight` / `editServiceInstanceMetadata` |
| `src/extension.ts` | 注册两个新命令；三个既有实例命令改传 `connect` 给重拉 |
| `package.json` / `package.nls*.json` / `l10n/bundle.l10n.zh-cn.json` | 命令、菜单（`view/item/context`，两种 contextValue，排除 `.readonly`）、文案 |
| `test/nacos/driver/writeDrivers.test.ts`、`test/write/updateInstanceHealth.test.ts`、`test/write/refetchInstance.test.ts`（新）、`test/extension/ServiceCommands.test.ts` | 见 C1.5 |

### C1.4 实施清单

- [ ] 泛化 `NacosInstanceUpdate` / `NacosInstancePatch`，删除旧类型，四驱动 + `NacosClient` 编译通过
- [ ] `updateInstanceHealthAt`：patch 覆盖在 instance 行之上；全空 patch 抛 `NacosApiError('validation', ...)`（写不出去的请求不该走到网络层）
- [ ] `refetchInstance` helper + 找不到实例的本地化失败文案
- [ ] `toggleServiceInstanceEnabled` 接入重拉；确认框 detail 换成完整行展示
- [ ] `editServiceInstanceWeight`：InputBox（数字，0–10000，支持小数）→ 重拉 → patch `{weight}` → 完整行确认 → 写 → 刷新服务树
- [ ] `editServiceInstanceMetadata`：InputBox（JSON，扁平 string map 校验）→ 同上，patch `{metadata}`
- [ ] `describeInstanceRow` 纯函数 + 「旧 → 新」标注
- [ ] 命令注册 / manifest / 菜单 / l10n 全链路
- [ ] 全量 vitest 通过

### C1.5 测试

驱动层（`writeDrivers.test.ts`）：

- patch `{weight: 5}` 时 form 里 `weight=5` 且 metadata/enabled/healthy/ephemeral 全部来自 instance 行原值（整行仍完整）
- patch `{metadata}` 时 form 里 `metadata` 是新 JSON，`weight` 是原值
- patch `{enabled: false}` 行为与改造前 `enabled` 参数完全一致（回归保护）
- 空 patch 抛 `validation`，且**没有发出任何 HTTP 请求**
- 四 flavor 的 `serviceIdentityParams` 方言不回归（v1 grouped serviceName，v2/v3 分离）
- weight 以字符串形式进 form（`Record<string,string>` 已在类型上强制，断言序列化值）

写层（`updateInstanceHealth.test.ts` + 新文件）：

- `refetchInstance`：命中四元组返回新鲜行；ip:port 相同但 cluster 不同不误匹配；消失时抛出且消息含地址
- 编辑权重全流程：重拉被调用、confirm 的 detail 含新鲜行的 metadata（而非缓存行的）、用户取消则零写请求
- 权重输入校验：负数 / >10000 / 非数字被 InputBox 校验器拒绝
- metadata 输入校验：非法 JSON、值为 number、嵌套对象均拒绝
- 只读实例：`assertWritable` 抛出，重拉都不发生
- `describeInstanceRow`：变更字段带「→」，未变字段原样，长 metadata 截断且注明

### C1.6 安全与坑

- **最大的坑就是本 Task 要修的坑**：整行回写 × 过期缓存 = 静默覆盖他人修改。重拉必须发生在 confirm **之前**（用户确认的必须是将要写的那行），写必须紧跟 confirm 之后——confirm 期间的窗口由 C5 的思路管不了（实例更新没有 CAS），只能靠 detail 里明示整行让用户自查。
- v1 与 v2/v3 的 cluster 参数拼法不同（`clusters` vs `clusterName`，`clusterParamName` 注释），但写路径发的是 `clusterName`（form 字段，非 query 过滤），v1 的 `InstanceController` 读 `clusterName`——已有实现如此且真机验证过，不要「顺手统一」。
- ephemeral=false（持久实例）的更新走 Raft，慢且可能在单机 standalone 上表现不同——live 验证时注册的临时实例用 ephemeral=true。
- 不要给 `NacosInstance.instanceId` 找用途：`updateInstanceHealthAt` 注释明确了不发它的原因（没有版本读它）。

### C1.7 完成判据

- 服务树实例节点右键可改权重与 metadata，确认框展示将写入的完整行，写前重拉真实发生（测试可证）
- enable/disable 行为无回归且同样吃到重拉
- 四驱动编译零改动遗漏，全量测试绿

---

## Task C2: 配置克隆 / 跨环境复制

### C2.1 现状与可复用件

- `compareConfigAcrossEnvironments`（`src/document/diffConfig.ts`）已有完整的环境选择流程：`pickTargetInstance`（单实例免选）→ `pickTargetNamespace`（排除「源实例 + 源命名空间」的组合、空列表给句子不给空 QuickPick、public 空 id 的显示名兜底）。两个函数目前是模块私有——**导出复用，不重写**。同文件的 `hasConfig`（用 `resource-not-found` 区分「没有这条配置」与「服务器不可达」）也直接复用。
- `publishConfig`（`src/write/publishConfig.ts`）已经是完整的安全管线：重读服务端 → 冲突警告 → 原生 diff → modal 确认 → 携带 type/appName/description 整行发布 → `markClean`。**克隆 = 在目标环境造一个内容为源配置的草稿，然后走这条既有管线**，一行发布逻辑都不新写。
- createNew 空基线语义已存在（1–8 批次 commit `a5701da`）：`openDraftDocument` 的 `createNew` 选项 + `publishConfig` 把 `resource-not-found` 读作 serverContent `''`。克隆到不存在的目标配置复用同一语义。

### C2.2 架构决策

**流程（命令 `atNacos.cloneConfig`，挂配置节点右键）：**

```text
1. 源：读取节点的 (instance, ref)；连接源实例，getConfig 拿完整 detail
   （content + type + appName + description + configTags——C4 之后 detail 才有 configTags，
     这是 C2 排在 PR-C-γ 的原因）
2. 目标实例：pickTargetInstance（复用）
3. assertWritable(目标实例)  ← 注意是目标；源实例只读【允许】，克隆只读源是合法诉求
4. 目标命名空间：pickTargetNamespace（复用；同实例时排除源命名空间）
5. targetRef = { ...source.ref, namespaceId: 目标命名空间 }   ← group 与 dataId 原样保留，本 Task 不提供改名
6. 探测目标是否已有该配置：hasConfig（复用）
   - 已存在 → 后续 diff 的左侧是目标现值，确认框带「将覆盖目标环境的现有配置」警告
   - 不存在 → createNew 语义：基线为空，diff 左侧为空文档
7. 在目标 (instanceId=目标.id, targetRef) 上初始化克隆草稿：
   content   = 源 content
   baseContent = 目标现值（不存在则 ''）
   type/appName/description/configTags = 源的（复制元信息是本 Task 的显式需求）
8. 调 publishConfig({ instance: 目标实例, ref: targetRef, ... })
   → 它自己会再读一次目标、开 diff（目标当前 vs 克隆草稿）、modal 确认、整行发布
9. 成功后 deleteDraft（克隆草稿是一次性的，不留在草稿池里变成幽灵脏草稿——见路线图 B9）
   + 刷新配置树
```

**`initDraft` 的小扩展（步骤 7 需要）：** 现有 `NacosDraftFileSystemProvider.initDraft(instanceId, ref, detail)` 把 `content` 与 `baseContent` 都设为 `detail.content`，表达不了「基线是目标、内容是源」。加一个可选参数：

```ts
initDraft(instanceId, ref, detail, initialContent?: string)
// content = existing?.content ?? initialContent ?? detail.content；baseContent 仍取 detail.content
```

克隆调用：`initDraft(target.id, targetRef, 目标detail或空detail(含源元信息), 源content)`。空 detail 的构造复用 `a5701da` 的 `emptyDetail` 思路，但 type 取**源的 type** 而非后缀推断——源明确知道自己的类型。

**目标缺失时 diff 左侧必须是真正的空文档，不是错误句子。** `publishConfig` 的 diff 左侧是 `buildConfigUri(instance.id, ref)`，而 `NacosConfigDocumentProvider` 对不存在的配置渲染的是失败文案（「配置已在服务端被删除」类句子）——那会让克隆确认 diff 的左侧出现一段说明文字，读起来像目标环境有一个内容为错误信息的配置。**实施前先跑一次验证**；确认属实后的修法（推荐 a）：

- (a) `buildConfigUri` 增加可选 query 标记 `absent=1`（仅克隆流程设置），provider 见到该标记且服务端答 `resource-not-found` 时返回空字符串；其他 URI 行为不变。
- (b) 目标缺失时不走 `publishConfig` 内置 diff，克隆流程自己 `vscode.diff(空的 untitled 文档, 草稿)` 再走确认——代价是 diff 逻辑出现两份，不推荐。

**「never skip Diff」的落点：** 目标缺失 ≠ 不用看 diff。空 vs 源内容的 diff 仍然强制打开——它回答的是「我到底要往这个环境写进什么」，这在跨环境操作里比同环境更重要（写错环境是这类功能的头号事故）。`publishConfig` 管线天然保证这一点，实现中不许加「目标为空就直接确认」的捷径。

### C2.3 文件清单

| 文件 | 动作 |
|---|---|
| `src/document/diffConfig.ts` | 导出 `pickTargetInstance` / `pickTargetNamespace` / `hasConfig`（或抽到 `src/document/environmentPickers.ts`，diffConfig 回头 import；二选一，倾向抽文件——两个消费者了） |
| `src/write/cloneConfig.ts` | 新增：上面 9 步的编排 |
| `src/document/NacosDraftFileSystemProvider.ts` | `initDraft` 加 `initialContent` 可选参 |
| `src/document/configUri.ts` + `NacosConfigDocumentProvider.ts` | `absent=1` 标记（方案 a，验证后实施） |
| `src/extension.ts` | 注册 `atNacos.cloneConfig` |
| `package.json` / nls / l10n | 命令 + 菜单（`viewItem =~ /^atNacos\.config\b/`——**含 readonly 源**，与其他写命令的等值匹配刻意不同）+ 文案 |
| `test/write/cloneConfig.test.ts`（新）、`test/document/NacosDraftFileSystemProvider.test.ts`、`test/document/diffConfig.test.ts` | 见 C2.5 |

### C2.4 实施清单

- [ ] 抽出/导出环境选择器与 `hasConfig`，`compareConfigAcrossEnvironments` 行为零变化（既有测试不动就绿）
- [ ] `initDraft` 的 `initialContent` 参数 + 测试
- [ ] 验证 provider 对缺失配置的渲染行为，落实方案 (a)
- [ ] `cloneConfig` 编排：九步全部落地，元信息（type/appName/description/configTags）从源复制
- [ ] 成功后清理克隆草稿 + 双树刷新
- [ ] 命令 / manifest / 菜单 / l10n
- [ ] 全量 vitest 通过

### C2.5 测试

- 同实例跨命名空间克隆（最常见形态，也是唯一能真机验证的形态——架构文档 §14.9 ① 的两个命名空间可用）
- 跨实例克隆：目标实例的 client 与源实例的 client 是两个连接（断言 connect 工厂按实例 id 分别调用）
- 目标缺失：基线为空、无冲突警告、diff 左侧空、发布后内容与源逐字节一致、type 为源 type（不是后缀推断值）
- 目标已存在：确认框带覆盖警告、diff 左右分别是目标现值与源内容
- 源只读实例允许克隆（只 assert 目标可写）；目标只读实例在选择后立刻拒绝（第 3 步位置的测试）
- 每一步取消（实例选择 / 命名空间选择 / diff 后拒绝确认）都零写请求
- 源 `getConfig` 失败（网络 / forbidden）传播错误，不产生半初始化草稿
- 克隆草稿发布后从草稿池消失（不残留脏草稿）
- 元信息复制：源带 appName/description/tags 时全部随发布 form 出现在目标端点方言下

### C2.6 安全与坑

- **写错环境是头号风险。** 确认框 summary 必须同时点名源与目标两个地址（复用 `environmentAddress` 的「实例 / 命名空间」格式）：「将 {dataId} 从 {source} 克隆到 {target}？」。
- 目标探测（第 6 步）到发布之间目标可能被人创建/修改——`publishConfig` 内部的第二次重读与冲突警告就是为这个窗口准备的，别在克隆层「优化掉」重复读取。C5 落地后此窗口进一步被 casMd5 收窄。
- `pickTargetNamespace` 的排除规则只排「同实例 + 同命名空间」；跨实例克隆到同名命名空间是合法的（uat 实例的 `dev` → prod 实例的 `dev`）。
- public 命名空间的 id：1.x/2.x 是 `''`，3.x 是 `'public'`（架构文档 §6.2）。targetRef 直接用目标实例 `listNamespaces` 返回的 id 原文，**绝不做任何归一化**——把 `''` 改写成 `'public'` 发给 2.x 会写进一个名叫 public 的自定义命名空间。
- 大配置（接近 100KB 上限）克隆时 diff 与两次读取都在内存里；现有 `maxResponseBytes` 护栏已覆盖读路径，无需新护栏，但不要在克隆层缓存内容副本。

### C2.7 完成判据

- 右键任一配置可克隆到任一可写环境；目标存在与否两条路径都强制 diff + modal；元信息随克隆复制；真机（同实例跨命名空间）走通一次并记录进架构文档 §14 追加节。

---

## Task C3: 命名空间 CRUD

### C3.1 现状

命名空间目前只读列出（`listNamespaces`，四驱动齐全，M1 实现）。路线图给它的完整度打 25 分。驱动层没有任何命名空间写方法。

### C3.2 架构决策

**接口新增三方法（PR-C-β 的第一半，四驱动被 TS 强制齐改）：**

```ts
// src/nacos/driver/NacosDriver.ts
export interface NacosNamespaceCreate {
  /** 自定义 id，可空——空时由服务端生成 UUID。客户端预校验 ^[\w-]{1,128}$。 */
  namespaceId?: string;
  name: string;
  description?: string;
}
export interface NacosNamespaceUpdate {
  namespaceId: string;
  name: string;
  description?: string;
}

interface NacosDriver {
  // ...
  createNamespace(request: NacosNamespaceCreate): Promise<void>;
  updateNamespace(request: NacosNamespaceUpdate): Promise<void>;
  deleteNamespace(namespaceId: string): Promise<void>;
}
```

返回 `void`，理由与 `publishConfig` 相同（接口注释原话）：写的唯一结果是它发生了，三种拒绝方式折进返回值会被调用方忽略。响应判定全部走 `assertWriteAccepted`——v1 的 console namespaces 写端点答裸 boolean，v2/v3 答 `{"code":0,"data":true}`，都在它的四形状覆盖内。

**路径与参数（每个 flavor 一个小节，实施时逐条核对）：**

| flavor | create | update | delete | 参数拼法 |
|---|---|---|---|---|
| v1 | `POST /v1/console/namespaces` | `PUT /v1/console/namespaces` | `DELETE /v1/console/namespaces` | POST form: `customNamespaceId`(可空), `namespaceName`, `namespaceDesc`；PUT form: `namespace`, `namespaceShowName`, `namespaceDesc`（**PUT 的 id 字段叫 `namespace`、名字叫 `namespaceShowName`，与 POST 不同拼——照官方 v1 OpenAPI，别想当然统一**）；DELETE query: `namespaceId` |
| v2 | `POST /v2/console/namespace` | `PUT /v2/console/namespace` | `DELETE /v2/console/namespace` | form/query: `namespaceId`, `namespaceName`, `namespaceDesc`（官方 2.x OpenAPI；**2.3.2 未实测**——若真机 404（Spring 错误页 → `not-found` → fall through）会自然落到 v1，这正是链式降级该干的活；若真机可用则留在 v2） |
| v3-admin | `POST /v3/admin/core/namespace` | `PUT /v3/admin/core/namespace` | `DELETE /v3/admin/core/namespace` | form/query: `namespaceId`, `namespaceName`, `namespaceDesc`。**路径推导规则**：架构文档 §9 只列了 `/v3/admin/core/namespace/list`，单资源路径按「去掉 `/list`」惯例推得——同一惯例已在 config（`/v3/admin/cs/config/list` vs `/v3/admin/cs/config`）与 instance（`.../instance/list` vs `.../instance`）上成立。**未真机验证，风险等级与 §14.3 条目 3 相同**，实现照写，live 前不声称支持 |
| v3-console | `POST/PUT/DELETE /v3/console/core/namespace` | 同左 | 同左 | 同 v3-admin 拼法 + **必须 `onConsoleOrigin()`**（全局约束 8）。同样未验证 |

- create/update 用 **form**（公理 1），delete 用 **query**（公理 2）。
- `namespaceDesc` 与 config 写的 `desc` 一样按「present-but-empty」发送（`request.description ?? ''`）——update 漏发它不是「保持原值」而是可能清空。
- **命名空间参数这里没有 tenant 方言问题**：console/core 模块全版本都说 `namespaceId`（v1 的 `tenant` 只属于 config 模块，`namespaceParamName` 注释）。不要顺手套 `namespaceParamName`——它会对 v1 返回 `tenant`，恰好是错的。此处直接写字面参数名并加注释说明为何不走映射函数。

**「删除仅限空命名空间」是客户端护栏，不是服务端行为。** Nacos 的 delete namespace **不检查内容**——删除一个还有配置的命名空间只是删掉 tenant 行，配置成为孤儿。所以：

1. 命令入口先重拉 `listNamespaces` 确认目标还在，并读它的 `configCount`（服务端自报，2.3.2 已验证有该字段）；
2. 再各发一发 `listConfigs({namespaceId, pageNo:1, pageSize:1})` 与 `listServices({namespaceId, pageNo:1, pageSize:1})`——configCount 可能滞后，实时探测是权威；
3. 两者任一 `totalCount > 0` → 拒绝，弹信息框写明「命名空间 {name} 还有 {n} 条配置 / {m} 个服务，请先清空或到控制台操作」，**不提供 force 选项**；
4. public 命名空间（id 为 `''` 或 `'public'`，两种拼法都挡）**无条件拒绝删除与编辑 id**；
5. 全部通过才进 `confirmWrite` modal：summary 点名 id 与显示名，detail 说明「删除仅移除命名空间本身，Nacos 不会级联删除任何数据；本插件已确认其为空」。

**UI 入口：**

- 「新建命名空间」：挂实例节点右键（`viewItem == atNacos.instance`，排除 `.readonly` 变体）。InputBox × 3：自定义 id（可空过，校验 `^[\w-]{1,128}$`）、名称（必填）、描述（可空）。
- 「编辑命名空间」「删除命名空间」：挂命名空间树节点右键（配置树与服务树的命名空间节点 contextValue 需要确认现值并统一；只读实例不挂）。编辑只允许改 name/description，id 不可改（Nacos 无 rename）。
- 成功后刷新**两棵树**（命名空间是两棵树的第一层）。

**MCP：本阶段绝不暴露。** 不进 `toolCatalog`、不进 `bridgeSchemas`、不进 `NacosAgentToolService`。`test/docs/AtNacosMcpSkill.test.ts` 的「不出现写工具名」断言顺带看住这一条。

### C3.3 文件清单

| 文件 | 动作 |
|---|---|
| `src/nacos/driver/NacosDriver.ts` | 两个请求类型 + 三个接口方法 + 共享 helper（若抽 `namespaceWrites.ts` 更好：`createNamespaceAt/updateNamespaceAt/deleteNamespaceAt`，与 `writes.ts` 同构） |
| `src/nacos/driver/writes.ts` 或新文件 `namespaceWrites.ts` | 三个 `xxxAt` helper，form/query 编码 + `assertWriteAccepted` |
| 四个 Driver 文件 | 各三方法：v1/v2/v3-admin/v3-console 的路径常量 + 一行转发 |
| `src/nacos/NacosClient.ts` + `NacosCapabilityResolver` 能力名 | `namespace-create` / `namespace-update` / `namespace-delete` 三个能力（写能力不落缓存降级结论?——落，与 config-publish 同策略） |
| `src/write/namespaceCrud.ts` | 新增：三个 UI 编排（含空检查、public 拒绝、confirm） |
| `src/tree/NacosTreeItems.ts` | 命名空间节点 contextValue 补 `.readonly` 变体（若尚无） |
| `src/extension.ts` / `package.json` / nls / l10n | 三个命令 + 菜单 + 文案 |
| `test/nacos/driver/namespaceWrites.test.ts`（新）、`test/write/namespaceCrud.test.ts`（新）、`test/extension/Manifest.test.ts` | 见 C3.5 |

### C3.4 实施清单

- [ ] 接口三方法 + 请求类型；四驱动路径常量与转发；`missingCapability` 不适用（四 flavor 都有端点，v2 靠链降级兜底）
- [ ] helper：POST/PUT form、DELETE query、v1 PUT 的 `namespace`/`namespaceShowName` 特殊拼法、desc present-but-empty
- [ ] resolver 三个新能力名接入
- [ ] UI 编排：空检查（configCount + 双实时探测）、public 双拼法拒绝、id 格式预校验、modal 文案
- [ ] 树刷新（双树）
- [ ] 命令 / manifest / 菜单 / l10n
- [ ] 全量 vitest 通过
- [ ] live（2.3.2）：建 → 改描述 → 确认树上可见 → 在其中发一条配置 → 验证删除被空检查拒绝 → 删配置 → 删命名空间成功。结果记入架构文档 §14 追加节（v2 端点是否存在的答案顺带记录）

### C3.5 测试

- 四驱动 × 三方法：URL、HTTP 方法、form vs query、参数拼法逐字段断言（v1 PUT 的三个特殊参数名是重点回归对象）
- v3-console 每个方法都带 `baseUrlOverride`（漏一个就是全局约束 8 的事故）
- 响应判定：裸 `true`、`{"code":0,"data":true}`、HTTP 200 + `false`（断言抛 api-error 且不 fall-through）、`{"code":10001}`
- 空检查：configCount>0 拒绝；configCount=0 但实时探测到配置也拒绝；服务非空拒绝；双零才放行
- public：`''` 与 `'public'` 都拒绝删除/编辑
- id 预校验：非法字符、超长、与现有命名空间重复（重拉列表比对——服务端也会拒，客户端先给可读文案）
- 只读实例：三命令全被 `assertWritable` 挡
- 取消路径零请求

### C3.6 安全与坑

- **孤儿配置是这个 Task 的最大事故形态**：服务端不做空检查，客户端检查是唯一防线，所以它必须发生在 confirm 之前且不可跳过；检查与删除之间的窗口（别人刚发了一条配置进来）无法闭合——modal detail 里如实说明「检查时为空」。
- 删除后的能力缓存：resolver 按「实例 id + 能力名」缓存驱动选择，删除命名空间不影响缓存正确性，但**树的分页状态**（该命名空间的已加载页）要随刷新丢弃。
- 3.x 的 `normalizeNamespace` 硬性要求 `entry.namespace` 是字符串且该错误不 fall-through（§14.3 条目 3 是 3.x 侧最高风险项）——CRUD 落地后每次操作都跟一次 `listNamespaces`，等于把这颗雷的触发频率提高了，live 验证 3.x 时优先确认。

### C3.7 完成判据

- 2.3.2 真机全流程走通并记录；四驱动实现齐全、v3 两条路径标注「未真机验证」入架构文档；MCP 目录与 skill 中不出现任何命名空间写字样。

---

## Task C4: description / appName / tags 编辑与透传

### C4.1 现状

- `NacosConfigDetail` 归一化了 `appName` / `description`，`publishConfig`（UI 层）发布时已把两者从 detail/draft 携带过去（`draft.appName ?? latestDetail?.appName`），`publishConfigAt` 按 present-but-empty 发 `appName` / `desc`——**但 UI 上没有任何地方能改它们**，且 **`configTags` 整条链路缺失**：detail 不归一化、publish 不发、draft 不存。
- `configTagsParamName(flavor)`（`src/nacos/driver/normalize.ts`）已存在：v1 族 `config_tags`（下划线），v2/v3 `configTags`——目前只用于列表过滤。发布 form 复用同一函数，键仍按**端点族**取：`V2Driver` 发到 `/v1/cs/configs`，必须发 `config_tags`。
- 发布是整行 upsert：tags 存在独立关联表，但 publish 会**重写关联**——请求里 tags 为空即清空存量 tags。所以 tags 与 appName/desc 同一条军规：**要保它就得带上它**，present-but-empty。

### C4.2 架构决策

**类型与驱动（属 PR-C-α 的类型加宽）：**

```ts
// NacosConfigSummary / NacosConfigDetail（normalize.ts）
configTags?: string;   // 逗号分隔原文，服务端字段名 configTags（2.x ConfigAllInfo 已确认有该字段；
                       // 3.x 拼法未真机验证，归一化对缺失容忍——undefined 即无 tags）

// NacosConfigPublish（NacosDriver.ts）
configTags?: string;

// publishConfigAt（writes.ts）form 增加一行：
[configTagsParamName(endpointFlavor)]: request.configTags ?? ''
// 与 appName/desc 同段注释、同 present-but-empty 语义
```

**草稿链路：** `DraftConfigMetadata`（`NacosDraftFileSystemProvider.ts`）加 `configTags?: string`；`initDraft` 从 detail 复制；`publishConfig` 发布时 `draft.configTags ?? latestDetail?.configTags`。**同时排查全部发布调用方**：`rollbackConfig`（历史版本的 tags 应随回滚恢复→ `historyDetail.configTags ?? currentDetail?.configTags`，若历史接口不回 tags 则退回 current 的并在注释说明）、`cloneConfig`（C2，复制源 tags）、`createConfig`（1–8 批次，新配置无 tags，发 `''`）。漏一个调用方 = 那条路径的发布静默清 tags。

**UI：命令 `atNacos.editConfigMetadata`（配置节点右键，只读不挂）。**

```text
1. 连接 → getConfig 重拉 detail（不用树节点缓存——summary 连 description 都没有）
2. InputBox × 3，预填现值：
   - appName（可清空）
   - description（可清空）
   - tags（逗号分隔；预校验：单个 tag 不含逗号外的分隔符、总长度合理；
     Nacos v1 的 config_tags 就是逗号分隔多值）
3. 无任何变化 → 信息框「没有修改」并结束，不发请求
4. confirmWrite：无 diff（内容不变），detail 展示三项的「旧 → 新」，
   且明确一句「本操作将以当前服务器内容整行重新发布该配置（Nacos 无单独的元信息接口）」
5. publishConfig 驱动调用：content/type 取第 1 步 detail 的原值，三项元信息取新值
6. 刷新文档 provider 与树
```

- 第 1 步与第 5 步之间是 TOCTOU 窗口（别人改了 content，我们把旧 content 写回去）——**C5 的 casMd5 落地后此处必须带上 `casMd5: detail.md5`**（详情接口的 md5 是真值，§14.9 ②）。实施顺序上 C4 在 C5 之前，先在代码注释里留 `TODO(C5)` 锚点，C5 的实施清单里包含回填此处。
- 清空是显式行为：用户把 tags 清空 → confirm detail 写「tags: `env=prod,core` → （清空）」。

### C4.3 文件清单

| 文件 | 动作 |
|---|---|
| `src/nacos/driver/normalize.ts` | detail/summary 归一化 `configTags` |
| `src/nacos/driver/NacosDriver.ts` | `NacosConfigPublish.configTags` |
| `src/nacos/driver/writes.ts` | publish form 的 tags 行 |
| `src/document/NacosDraftFileSystemProvider.ts` | `DraftConfigMetadata.configTags` |
| `src/write/publishConfig.ts` / `rollbackConfig.ts` /（C2 的 `cloneConfig.ts`）/ createConfig 流程 | tags 携带 |
| `src/write/editConfigMetadata.ts` | 新增 UI 编排 |
| `src/extension.ts` / `package.json` / nls / l10n | 命令 + 菜单 + 文案 |
| 测试：`writeDrivers.test.ts`、`normalize.test.ts`、`publishConfig.test.ts`、`rollbackConfig.test.ts`、`editConfigMetadata.test.ts`（新） | 见 C4.5 |

### C4.4 实施清单

- [ ] 归一化 + 类型 + form 行（present-but-empty）
- [ ] 方言断言：v1/v2 驱动发 `config_tags`，v3 两驱动发 `configTags`
- [ ] 草稿链路 + 全部发布调用方的 tags 携带排查（publishConfig / rollbackConfig / createConfig / cloneConfig）
- [ ] `editConfigMetadata` 编排（含无变化短路、清空显式化、TODO(C5) 锚点）
- [ ] 命令 / manifest / 菜单 / l10n
- [ ] 全量 vitest 通过
- [ ] live（临时命名空间）：发一条带 tags 的配置 → 列表按 `config_tags` 过滤能命中 → 改 appName → 重读 detail 确认 tags 未被清掉（**这是本 Task 的灵魂断言**）

### C4.5 测试

- publish form：设 tags 时按端点族拼法出现；未设时以 `''` 出现（present-but-empty，断言键存在值为空）
- detail 归一化：有 `configTags` 字符串、缺失、非字符串（容忍为 undefined）
- 「编辑 appName 不动 tags」：mock detail 带 tags，editConfigMetadata 只改 appName，断言发布 form 里 tags 原值仍在
- rollback 携带 tags（历史 detail 有 → 用历史的；没有 → 用当前的）
- 无变化短路：三项都没改则零写请求
- 清空路径：confirm detail 含「（清空）」字样，form 里对应键为 `''`

### C4.6 安全与坑

- **头号坑就是整行 upsert 的隐式清空**：任何一条发布路径漏带 tags/appName/desc，就是那条路径的用户每次发布都清一遍元信息，且没有报错。测试矩阵必须覆盖每条发布路径。
- 列表接口的 `configTags` 字段 3.x 拼法未验证；归一化容忍缺失，UI 不依赖列表有 tags（编辑入口重拉 detail）。
- tags 里含中文/空格合法，form 编码由 `URLSearchParams` 兜底（`toPayload` 注释）；但**逗号是服务端的多值分隔符**，单个 tag 含逗号无法表达——输入校验直接拒绝并说明。

### C4.7 完成判据

- 三项元信息可看可改；任何发布路径都不再隐式清除它们（测试矩阵证明）；tags 过滤在真机对得上号。

---

## Task C5: CAS 发布（casMd5）

### C5.1 现状与问题（TOCTOU 的确切位置）

`src/write/publishConfig.ts` 的时序：`getConfig`（拿 latestDetail，第 49 行附近）→ 冲突警告判定（`draft.baseContent !== serverContent`）→ `confirmWrite`（用户在 modal 前可以停留任意久）→ `client.publishConfig`。**用户盯着 modal 的这段时间里服务端可以被任何人改写**，我们随后的整行发布把它无警告地覆盖。冲突检测只保护「打开草稿到点发布」的前半窗口，不保护「确认到发布」的后半窗口。

`DraftEntry.baseMd5`（`NacosDraftFileSystemProvider.ts`）从 M5 起就被 `initDraft` 写入（`detail.md5`）、被 `markClean` 可选更新——**但没有任何读取方**。本 Task 接通它。

服务端事实（照架构文档的诚实度惯例分级）：

- **有官方文档依据、未真机验证**：2.x `POST /v2/cs/config` 与 2.x 的 v1 `POST /v1/cs/configs`（`ConfigController.publishConfig` 带可选 `casMd5` 参数，约 2.2 起）支持 CAS：casMd5 与存量 md5 不符时发布被拒。3.x `ConfigForm` 亦带 casMd5。
- **确定不支持**：真 1.x 服务器没有 casMd5 参数——而未知参数被**静默丢弃**（§14.2 ①' 同款陷阱），意味着对 1.x 发 casMd5 得到的是**假 CAS**：请求成功但没有任何比较发生。这比失败更糟。

### C5.2 架构决策

**类型（PR-C-α）：**

```ts
// NacosConfigPublish（NacosDriver.ts）
/**
 * 服务端 CAS 锚点：确认框里给用户看过的那份服务端内容的 md5。
 * 设了它，发布只在服务端 md5 仍等于它时成功。
 * V1Driver 不把它交给服务端（1.x 会静默丢弃它造成假 CAS），改为发前最后一秒重读模拟——窗口收窄到毫秒级但不闭合。
 */
casMd5?: string;
```

**按驱动分派（不是按端点族——这是本 Task 与方言规则唯一的分叉点，注释必须写明原因）：**

- `V2Driver` / `V3AdminDriver` / `V3ConsoleDriver`：`publishConfigAt` form 里带 `casMd5`（仅当设置；`''` 不发——空串会被 2.x 当成「与空 md5 比较」而不是「不比较」的风险无从排除，缺席才是明确的「不做 CAS」）。V2 发到 v1 路径但 2.x 服务器的 v1 控制器读 casMd5——**live 必须验证这一条**（用过期 casMd5 发布，期望被拒），验证不过则 V2 退回与 V1 相同的模拟方案。
- `V1Driver`：`publishConfigAt` 前，若 `request.casMd5` 设置，先 `fetchConfigDetail` 重读并比较 md5（detail 的 md5 是真值，§14.9 ②；md5 缺失时比较 content）；不一致抛 `NacosApiError('api-error', ...)`，消息明说「发布前重读发现配置已被修改，本次发布未执行」；一致则立即发布且**不把 casMd5 放进 form**。实现放在 helper 层（`publishConfigAt` 增加 `casSupport: 'server' | 'reread'` 参数，V1 传 `'reread'`），因为只有 helper 同时拿得到 http 与请求。
- 拒绝形状的甄别：CAS 失败时 2.x 答什么（HTTP 200 + `false`？还是带业务 code？）**没有一手证据**——live 验证清单里专门测。在拿到形状之前，UI 层的策略是：发布带 casMd5 被拒（`assertWriteAccepted` 抛 api-error）后，**再读一次服务端 md5**：与 casMd5 不同 → 报「配置在你确认期间被他人修改，发布已被拒绝；请重新打开对比确认」（并刷新文档 provider）；相同 → 原样传播（那是权限等真拒绝）。不新增 `NacosApiError` kind——冲突与拒绝的甄别只有 UI 层有上下文做，且新 kind 会牵动降级判据表。

**UI 接线（`publishConfig.ts`）：**

- `casMd5: latestDetail?.md5`——**用确认框 diff 展示的那份内容的 md5**，恰好闭合「确认 → 发布」窗口。latestDetail 为空（createNew 路径）或 md5 缺失 → 不设 casMd5，保持现有冲突警告行为（诚实降级）。
- `baseMd5` 的接通点：发布成功后 `markClean` 目前只更新 baseContent——增加一次可选的发布后 `getConfig`，把新的服务端 md5 喂给 `markClean(key, draft.content, newMd5)`，使**同一草稿的第二次发布**也有正确的 CAS 锚点链（否则第二次发布的 latestDetail 重读仍然兜底，但 baseMd5 从此过期，留着一个错值比留空更糟）。
- `rollbackConfig` 与 `editConfigMetadata`（C4 的 TODO 锚点）同步接入：casMd5 取各自流程里重读到的 currentDetail.md5。

### C5.3 文件清单

| 文件 | 动作 |
|---|---|
| `src/nacos/driver/NacosDriver.ts` | `NacosConfigPublish.casMd5` |
| `src/nacos/driver/writes.ts` | `publishConfigAt` 的 `casSupport` 参数、form casMd5 行、reread 模拟 |
| 四个 Driver | V1 传 `'reread'`，其余传 `'server'` |
| `src/write/publishConfig.ts` | casMd5 接线、拒绝后甄别、markClean 的 md5 回填 |
| `src/write/rollbackConfig.ts`、`src/write/editConfigMetadata.ts` | casMd5 接线 |
| `src/document/NacosDraftFileSystemProvider.ts` | 无接口变化（markClean 已支持 md5 参数），补注释说明 baseMd5 从此有读者 |
| 测试：`writeDrivers.test.ts`、`publishConfig.test.ts`、`rollbackConfig.test.ts` | 见 C5.5 |

### C5.4 实施清单

- [ ] 类型 + form 行 + `casSupport` 分派
- [ ] V1 reread 模拟（比较 md5，md5 缺失退化为 content 比较；不一致的错误文案）
- [ ] UI 三处接线 + 拒绝后甄别 + markClean md5 回填
- [ ] C4 留下的 TODO(C5) 锚点回填
- [ ] 全量 vitest 通过
- [ ] live（临时命名空间，2.3.2）：① v1 路径带过期 casMd5 发布，记录服务端是否拒绝与拒绝形状（**决定 V2 走 server 还是 reread 的实测依据**）；② 拒绝形状记入架构文档 §14 追加节

### C5.5 测试

- v2/v3 驱动：casMd5 设置时出现在 form；未设置时键不存在（不是空串）
- v1 驱动：casMd5 **从不**出现在 form；设置时先发 GET 重读；md5 不一致抛错且**没有发布请求发出**；一致则发布照旧
- publishConfig：casMd5 取 latestDetail.md5；createNew 路径不设；被拒后重读 md5 不同 → 冲突文案，相同 → 原错误传播
- markClean 回填：发布成功后 baseMd5 更新为发布后重读值；重读失败不阻塞成功提示（这是锦上添花路径，失败降级为不更新）
- rollback / editConfigMetadata 带 casMd5

### C5.6 安全与坑

- **假 CAS 是本 Task 的头号坑**：把 casMd5 交给不认识它的端点，得到的是心理安慰不是保护。V1 的分派与「空串不发」都是为它设的。
- reread 模拟**不闭合**窗口，只收窄——文案与代码注释都不许用「防止」「保证」字样，用「大幅收窄」。
- md5 在**列表**里恒为 null（§14.9 ②），任何实现不得从 summary 取 md5 做 CAS 锚点；锚点只能来自 detail。

### C5.7 完成判据

- v2/v3 发布带服务端 CAS；v1 有最后一秒重读；确认期间被改写的发布被拦下且文案指向重新对比；live 记录了 2.3.2 的 CAS 真实行为。

---

## Task C6: 删除空服务

### C6.1 架构决策

**接口新增（PR-C-β 第二半）：**

```ts
// NacosDriver.ts
deleteService(ref: NacosServiceRef): Promise<void>;
```

| flavor | 路径 | 参数 |
|---|---|---|
| v1 | `DELETE /v1/ns/service` | query = `serviceIdentityParams('v1', ref)`（grouped serviceName） |
| v2 | `DELETE /v2/ns/service` | query = `serviceIdentityParams('v2', ref)` |
| v3-admin | `DELETE /v3/admin/ns/service` | query = v3 拼法 |
| v3-console | `DELETE /v3/console/ns/service` + `onConsoleOrigin()` | **未验证**——§14.5 条目 18 只确认 console 有 naming 的 service controller，delete mapping 是否存在无一手证据。照写；若真机 404 则改为 `missingCapability`（3.x 链条里 admin 在前，普通账号删服务会 admin-403 → console-404 → 最终报错，这个降级终点的文案要可读） |

- DELETE 参数进 query（公理 2）；服务称呼复用 `serviceIdentityParams`（公理 3 + C1 同款理由：写与读对服务的称呼必须一致）。
- **服务端有自己的非空拒绝**（v1/v2 删非空服务答 `service ... is not empty` 类错误，HTTP 400/500，`api-error` 不降级——正确，换 API 族变不出一个空服务），这是兜底；**客户端预检查是主防线**：命令入口重拉 `listInstances`，任何实例（**包括 disabled 的**——下线不等于注销）存在即拒绝并报数量。
- 竞态诚实化：预检查为空 → 确认 → 删除之间可能有实例注册进来，服务端兜底会拒绝；也可能服务被 Nacos 的空服务自动清理（`nacos.naming.empty-service.auto-clean`）抢先删掉——删除时收到「service not found」类错误（v1 是 HTTP 500 `service not found`，v2 是 `{"code":21008}`，§14.8 ④）时，UI 报「服务已不存在（可能已被自动清理）」信息框而非错误——目标状态已达成。
- UI：`atNacos.deleteService` 挂服务节点右键，`when` 用 `viewItem =~ /^atNacos\.service\b/` 减去 readonly 变体，并且**注意 §14.9 条目 36 的教训**：该正则不得命中 `atNacos.serviceInstance`。modal 文案点名 namespace/group/service 三段地址，detail 说明「仅删除服务定义；本插件已确认其无任何注册实例」。

### C6.2 文件清单与实施清单

| 文件 | 动作 |
|---|---|
| `NacosDriver.ts` + 四驱动 + `NacosClient.ts` + resolver 能力名 `service-delete` | 接口与实现 |
| `src/nacos/driver/naming.ts` 或 `writes.ts` | `deleteServiceAt` helper（query 编码 + `assertWriteAccepted`） |
| `src/write/deleteService.ts` | UI 编排（预检查 + confirm + not-found 宽恕） |
| `src/extension.ts` / `package.json` / nls / l10n | 命令 + 菜单 + 文案 |
| `test/nacos/driver/`、`test/write/deleteService.test.ts`（新） | 下述测试 |

- [ ] 接口 + 四驱动 + helper（query 不 form）
- [ ] 预检查（含 disabled 实例计数）、modal、not-found 宽恕分支
- [ ] 命令 / manifest / 菜单（正则不误伤 serviceInstance）/ l10n
- [ ] 全量 vitest 通过
- [ ] live：临时命名空间注册一个临时服务（ephemeral 实例）→ 验证有实例时删除被预检查拒绝 → 注销实例 → 删除成功（或被 auto-clean 抢先，两种结果都记录）

### C6.3 测试

- 四驱动：URL/方法/query 拼法（v1 grouped name 是重点）；v3-console 带 override
- 预检查：1 个 enabled 实例拒绝；1 个 disabled 实例也拒绝（文案含计数）；空放行
- 服务端拒绝（HTTP 200+false / 400 code）不降级、文案传播
- not-found 类错误（v1 500 文本 / v2 21008）走信息框分支
- 只读、取消路径

### C6.4 完成判据

- 空服务可从树上删除；非空服务在客户端与服务端两层都删不掉；live 一轮走通。

---

## Phase C 整体验收标准

- [ ] C1–C6 全部落地，PR 按 §2 分组合入，全量 vitest 绿（预计新增 ≥120 用例）
- [ ] 每条新写路径：`assertWritable` → 重拉最新状态 → `confirmWrite`（modal，必要时 diff）→ `assertWriteAccepted`，四环一个不缺
- [ ] 四驱动零 TODO：每个新能力在每个 flavor 上要么有实现要么有 `missingCapability` 的诚实拒绝
- [ ] 架构文档 §14 追加本阶段的真机验证记录（命名空间 CRUD、casMd5 行为、服务删除、tags 保全）
- [ ] MCP 工具目录、bridgeSchemas、skill 文档在本阶段结束时**与阶段开始时逐字节相同**（写能力零泄漏进 Agent 面——那是 Phase D2 的事，且有自己的闸门设计）
