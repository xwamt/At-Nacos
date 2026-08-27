# AT Nacos Phase D —— 高风险 / 外部依赖项 实现计划

> **Status:** 待执行的实现计划（docs only，本文档不含任何产品代码改动）。
>
> **铁律：D1–D5 每个任务是自己独立的未来 PR。** 不与 Phase C 混、也不互相混。理由各不相同但结论一致：D1 动鉴权层的接口形状（回归面是每一个 HTTP 请求）；D2 打破「MCP 只读」这条从需求阶段就写死的边界（需要独立的评审与回滚单元）；D3 依赖尚未探明的 3.x 服务端行为；D4 小但涉及把密文写盘的产品决策；D5 的主体改动在上游仓库。**任何「顺手带上」都会让回滚变成外科手术。**
>
> **规格真源:** `docs/plans/2026-08-13-at-nacos-architecture.md`（下称「架构文档」），本计划重点引用 §7（鉴权全节，尤其 §7.6 AK/SK）、§4.3（3.x 双端口与强制鉴权）、§12（`src/nacos/**`、`src/mcp/**`、`src/agent/**` 不 import vscode 的分层约定）、§14.3（3.x 未验证清单）。MCP 面的既有决策见 `docs/plans/2026-08-20-nacos-mcp-official-alignment.md` 与 `docs/plans/2026-08-20-nacos-mcp-p1-description-contracts.md`。
>
> **与 Phase C 的关系:** D2 依赖 C1 的「重拉 + 整行」语义与（可选）C5 的 casMd5；其余任务与 C 无硬依赖。D2 动手前 C 必须已合入。

---

## 0. 开工闸门与基线核对（先读这节，再挑任务）

### 0.1 基线

本文档所有 file:line 已于 2026-08-27 用 `git show origin/cursor/nacos-opt-1-8-6a9b:<path>` 逐条核实。除 `src/agent/NacosAgentToolService.ts`、`src/extension.ts`、`package.json` 等 7 个文件外，引用文件在 main 与 opt-1-8 上逐字节一致（清单见 Phase C 计划 §0-A.1）；凡行号取自分叉文件的，条目里已注明两边坐标。开工前重跑：

```bash
git fetch origin cursor/nacos-opt-1-8-6a9b main && git diff --stat origin/main origin/cursor/nacos-opt-1-8-6a9b -- src test package.json
```

### 0.2 每任务的开工闸门（「不满足则不得动工」，PR 描述里逐条勾选）

| Task | 不满足以下条件不得动工 | 双闸门 / 铁门 |
|---|---|---|
| D1 | ① D1.3a 研究清单**全部**拿到一手出处（官方 Java 客户端指定版本的源码行）；② §16.3（换认证方式时旧密码去留的矛盾）已裁决；③ 三个既有策略的测试全绿基线记录在案 | **三个铁门**（D1.1b）：接口扩容 PR 里 `createAuthStrategy` 的 throw **原样保留**；签名实现 PR 必须带锁死的跨实现验证向量；表单的 akSk 选项在真机 MSE 验签通过前**不得出现** |
| D2 | ① Phase C 已合入 main（至少 C1 的 `refetchInstance`——`nacos_set_instance_enabled` 复用它）；② `test/docs/AtNacosMcpSkill.test.ts` 的反向断言改写方案过评审（这是产品承诺变更）；③ Hub 端确认 `risk:'write'` 会触发它自己的写确认 | **双闸门 + 目录闸门**：`allowAgentWrites` 默认 false（叠加 `allowBackgroundAccess` 之上）+ catalog `risk:'write'`；无实例 opt-in 则写工具不进目录；`/invoke` 不信任目录（纵深防御） |
| D3 | ① 写侧：3.x 环境实测灰度三端点前**写侧一行代码不写**（D3.2 末尾三条件）；② 读侧无前置——v1/v2 读 + v3 `missingCapability` 随时可做 | v3 两驱动首版一律诚实拒绝，不打猜测路径 |
| D4 | 无外部前置。唯一决策（密文原文落盘）已在 D4.2 拍板 | 成功提示必须含安全提醒 |
| D5 | 第一步永远是测量（metafile）；**测量数字 < ~100KB 则本地缓解不做** | deep-import `dist/**` 绕过 exports 是永久禁手 |

### 0.3 一 PR 一任务的复述（为什么不许搭车）

D1 动鉴权层接口形状（回归面 = 每一个 HTTP 请求）；D2 改「MCP 只读」产品承诺（独立评审与回滚单元）；D3 写侧依赖未探明的 3.x 服务端行为；D4 是密文落盘的产品决策；D5 主体在上游仓库。**任何两个混进同一 PR，回滚都变成外科手术。** D 内部无顺序依赖（D2 依赖的是 Phase C，不是 D1），可并行认领。

---

## Task D1: AK/SK（MSE SPAS 签名）——独立 PR

### D1.0 现状核对表（against `origin/cursor/nacos-opt-1-8-6a9b`，2026-08-27 核实；这些文件 main 与基线逐字节一致）

| 事实 | 坐标 | 核对结果 |
|---|---|---|
| `'akSk'` 是合法枚举值 | `src/config/schema.ts:4`（`NACOS_AUTH_MODES`）；`.strip()` 注释 `:56-63` 预告「a region for AK/SK」 | ✅ |
| `createAuthStrategy` 对 akSk 直接 throw | `src/nacos/auth/createAuthStrategy.ts:31-35`（throw `:35`；注释原话 "Failing loudly beats degrading to anonymous access" `:32-34`） | ✅ |
| `NacosAuthStrategy` 接口全文只有两个方法，`authHeaders()` 零参数 | `src/nacos/auth/NacosAuthStrategy.ts:1-10`（`authHeaders` `:3`、`refresh` `:9`） | ✅ 无请求上下文 |
| `withAuth` 每 attempt 重新解析 `authHeaders()`；策略抛错传播不重试 | `src/nacos/auth/withAuth.ts:59-86`（注释 `:64-68` 明写 akSk 的 throw 从这里传播） | ✅ throw 的传播路径已被设计接住 |
| header merge 语义：caller 优先、大小写不敏感 | `withAuth.ts:105-137` | ✅ 迁移时原样保留 |
| 403 定义与单次重试 | `withAuth.ts:14`（`FORBIDDEN_STATUS`）、`:30-38`（至多一次的理由） | ✅ |
| 三个既有策略 | `NoAuthStrategy.ts` / `CustomHeaderStrategy.ts` / `UserPasswordStrategy.ts`（同目录） | ✅ 机械迁移对象 |
| SPAS 事实的仓内唯一记录 | 架构文档 §7.6（`2026-08-13-at-nacos-architecture.md:323-325`）：CONFIG 注入 header（`Spas-AccessKey`/`Spas-Signature`/`Timestamp`），NAMING 注入参数（`ak`/`signature`/`data`），HMAC-SHA1 后 Base64，resource 拼装两类资源不同，v4 有区域派生密钥，开源 Server 默认不校验，MSE 也支持用户名密码 | ✅ 这是**全部**已知信息——注意它只有三行，不足以实现 |
| live 测试门控机制 | `test/live/liveServer.test.ts:47-49`（`AT_NACOS_LIVE_URL` 环境变量缺席即 skip） | ✅ MSE live 用例套同款 |
| 日志脱敏入口 | `src/utils/logger.ts:87`（`asRedactedLog`） | ✅ 补签名类词表 |

### D1.1 现状（每一条都有代码坐标）

- `NACOS_AUTH_MODES` 里 `'akSk'` 从 M1 起就是合法枚举值（`src/config/schema.ts` 第 4 行），schema 注释甚至预告了「后期里程碑加 region 字段」——**但只是占位**。
- `createAuthStrategy`（`src/nacos/auth/createAuthStrategy.ts`）对 `case 'akSk'` 的处理是**直接 throw**：
  > `throw new Error('AK/SK authentication is not implemented yet.');`
  >
  > 注释写明这是刻意的：「Failing loudly beats degrading to anonymous access」。M1 的表单也不提供该选项。这个 throw 就是本 Task 要拆除的路标，且拆除前它保护着用户不被假鉴权欺骗——**实现没到能用的程度之前不要先放开表单选项**。
- **根本性障碍：`NacosAuthStrategy.authHeaders()` 没有请求上下文。** 接口全文只有两个方法（`src/nacos/auth/NacosAuthStrategy.ts`）：`authHeaders(): Promise<Record<string, string>>` 与 `refresh(): Promise<boolean>`。SPAS 签名是**按请求**算的——config 请求要签 `tenant` 与 `group`，naming 请求要签 `serviceName`（分组折入形态），两类资源连注入位置都不同（config 进 header，naming 进请求参数，架构文档 §7.6）。一个拿不到 path/tenant/group/serviceName 的策略接口在数学上无法产出签名。**接口扩容是本 Task 的主体工程，签名算法本身反而是小头。**
- MSE 过渡方案已经存在且要保留到本 Task 交付为止：MSE 同时支持用户名密码（§7.6 末句「开源版 Server 默认不校验，MSE 也支持用户名密码」），`customHeader` 模式也可用。README 与实例表单的说明文案里为 MSE 用户指路 `userPassword`，D1 合入前不许删。

### D1.1a 为什么 `authHeaders()` 没有请求上下文，为什么那个 throw 是安全锁（评审共识，动手前逐句读）

**接口为什么长成这样。** M1 设计 `NacosAuthStrategy` 时（`NacosAuthStrategy.ts:1-10`），三种已实现的鉴权（none / customHeader / userPassword）的凭据都是**请求无关**的：一个 token、一组固定 header，对任何 path 任何资源都相同。所以接口只需要 `authHeaders(): Promise<Record<string,string>>`——不收参数，因为没有参数能改变答案。这不是疏漏，是当时的正确最小化。但它对 SPAS 是数学上不可行的：SPAS 签名的输入包含**这一个请求**的 tenant、group（config 族）或分组折入形态的 serviceName（naming 族），签名结果注入的位置也随资源类别变（config 进 header、naming 进请求参数，§7.6）。一个拿不到 path/tenant/group/serviceName 的函数**无法产出**任何请求的合法签名——不是「难」，是输入缺失。所以 D1 的主体工程是接口扩容（`decorate(context)`），签名算法反而是小头。

**throw 为什么是安全锁而不是待办。** `createAuthStrategy.ts:31-35` 的注释原话是「Failing loudly beats degrading to anonymous access, which would leave the user believing an unauthenticated connection was an authenticated one」。展开说：如果 akSk 分支返回 `NoAuthStrategy`（或任何「先凑合」的实现），用户配置了 AK/SK 的实例会**静默匿名连接**——在开源 Nacos 上（默认不校验签名，§7.6）一切读写照常工作，用户完全无法察觉自己的「已鉴权连接」其实什么都没签；直到同一份配置连上真 MSE 才失败，而那时用户排查的方向会是「我的 key 错了」。throw 的传播路径也是设计好的：`withAuth.ts:64-68` 注明策略抛错**原样传播且不重试**——它不是 403，不触发 refresh，不消耗登录尝试，直接把「AK/SK 尚未实现」端到用户面前。**因此：任何中间态 PR（接口扩容、表单重构）都必须原样保留这个 throw**，它只在真签名实现（过了 D1.1b 的第二道铁门）就位的那个 PR 里被替换。

**同理可证的第三条锁：本文档自己也不许提供「凭记忆写的 HMAC」。** 一个拼错 header 名、拼错 resource 连接符、或时间戳单位取错的签名实现，在开源 Nacos 上**全绿**（服务端根本不校验），在 MSE 上全红且报错只有 403——静默错签比不实现更危险，因为它把「没实现」变成了「看起来实现了」。所以 D1.3 的形状草案只作为研究起点，**每一个字节级细节都必须先在 D1.3a 的研究清单里拿到一手出处，才允许写进代码**。

### D1.1b 阶段划分（三个铁门，每道门是一个独立可合入状态）

| 阶段 | 内容 | 铁门（过不去就停在上一阶段） |
|---|---|---|
| **Stage R（研究，零代码）** | 完成 D1.3a 研究清单，产出「签名规格备忘录」追加进架构文档 §7.6（含出处版本号与源码行） | 清单里任何一项没有一手出处 → 不开 Stage 1 |
| **Stage 1（接口扩容 PR）** | D1.2 的 `decorate(context)` 改造 + 三策略机械迁移 + `options.auth` 铺设。**`createAuthStrategy` 的 throw 原样保留**（akSk 分支照抛，只是挪到新接口形状下）；表单不出现 akSk 选项 | 全量测试绿 + 三个旧策略「无视 context」的回归断言在 → 才可合入；此 PR 合入后产品行为**零变化** |
| **Stage 2（签名实现 PR）** | `spasSignature.ts` + `AkSkStrategy.ts` + 拆 throw + SecretStorage 键位。签名向量用**第二实现**（官方 Java 客户端跑出的真实值，或按源码手算并注明步骤）锁死 | 向量测试绿 + **真机 MSE 一次性验签通过**（config 读、naming 读、config 写各至少一发）→ 才可合入；MSE 环境拿不到 → 本 PR 不合，停在 Stage 1 |
| **Stage 3（UI 放开 PR）** | 表单 authMode 下拉解锁 akSk、AK/SK 双栏、帮助文案、README 更新 | 依赖 Stage 2 已合入且 §16.3 已裁决。**顺序不可颠倒：UI 选项永远最后放开**——一个能在表单里选中但不能用的模式，比不存在更糟 |

Stage 1 与 Stage 2 若同窗口完成可合并为一个 PR，但 Stage 3 **永不**与前两者同 PR：放开入口是独立的产品决定，回滚它不应该动鉴权层代码。

### D1.2 接口扩容设计（Stage 1 的全部内容；回归面最大的一步，先定形再动手）

```ts
// src/nacos/auth/NacosAuthStrategy.ts —— 全量替换为：

/** 一次请求里签名所需的全部事实。由 driver 层在发起请求处填写。 */
export interface NacosAuthRequestContext {
  /** 决定签名方言与注入位置：config 走 Spas header，naming 走请求参数。'other' 只签时间戳。 */
  module: 'config' | 'naming' | 'other';
  path: string;
  /** config 签名的 tenant 段。注意：这里永远放 namespaceId 的原始值（1.x/2.x public 即 ''）。 */
  namespaceId?: string;
  /** config 签名的 group 段。 */
  group?: string;
  /** naming 签名的服务名，**分组折入形态**（GROUP@@name），与请求实际发出的拼法一致。 */
  serviceName?: string;
}

/** 一次请求应携带的鉴权装饰。headers 与 query 分开，因为 naming 的签名走参数。 */
export interface NacosAuthDecoration {
  headers: Record<string, string>;
  /** naming 模块的 ak/data/signature。绝大多数策略返回 undefined。 */
  params?: Record<string, string>;
}

export interface NacosAuthStrategy {
  decorate(context: NacosAuthRequestContext): Promise<NacosAuthDecoration>;
  refresh(): Promise<boolean>;
}
```

- **既有三个策略的迁移是机械的**：`NoAuthStrategy` 返回 `{ headers: {} }`；`CustomHeaderStrategy` 返回 `{ headers: this.headers }`；`UserPasswordStrategy` 返回 `{ headers: { Authorization: 'Bearer ...' } }`。三者都无视 context——测试断言这一点（传任意 context 输出相同）。
- **`withAuth`（`src/nacos/auth/withAuth.ts`）的改造**：目前它对每次请求调 `auth.authHeaders()` 并 merge 进 `options.headers`（caller 的 header 优先，大小写不敏感——这套 merge 语义原样保留）。改为读取 `options.auth`（新增于 `NacosRequestOptions`）作为 context，缺席时以 `{ module: 'other', path }` 兜底；`decoration.params` merge 进 `options.query`——**同样 caller 优先**，并且要注意 `NacosHttpClient.buildUrl` 里 `undefined` 值会被跳过的既有语义。403 重试路径照旧：重试的那次**重新 decorate**（时间戳必须新鲜，这与 token 重取是同一个理由——`withAuth` 注释里「authHeaders() 按 attempt 解析」的设计在这里第二次收回报）。
- **`NacosRequestOptions.auth` 的铺设**：这是本 Task 的体力活。逐个 helper 补上下文：
  - config 族：`fetchConfigPage` / `fetchConfigDetail`（`NacosDriver.ts`）、`fetchConfigHistoryPage` / `fetchConfigHistoryDetail` / `fetchConfigListeners` / `fetchListenedConfigs`（`history.ts`）、`publishConfigAt` / `deleteConfigAt`（`writes.ts`）→ `{ module: 'config', path, namespaceId, group }`
  - naming 族：`fetchServiceDetail` / `fetchSubscribers` / `fetchInstances` / `fetchCatalog*` / `fetchServicePage` / `fetchServiceNames`（`naming.ts`）、`updateInstanceHealthAt` → `{ module: 'naming', path, namespaceId, serviceName: groupedServiceName(ref) }`
  - 其余（namespaces / cluster / metrics / probe / login）→ `'other'`
  - **每处的 tenant/group 取值必须与请求参数用的同一来源变量**——签名与参数不一致是 MSE 403 的经典来源，代码评审逐处核对。
- 兼容性备注：`testNacosConnection` 的 `withAuthHeaders`（不重试的那个）同步迁移；`NacosAuthenticator` 若有独立缓存层也一并迁移。全仓 `authHeaders` 调用点在改名后由编译器点名，**不留旧方法别名**。

### D1.3 SPAS 签名模块的形状（Stage 2 的骨架；**本节不是算法规格**）

> ⚠ **本节只定「模块长什么样」，不定「签什么、怎么拼」。** 仓库里关于 SPAS 的一手记录只有架构文档 §7.6 的三行（D1.0 表最后一行），凭它或凭任何人的记忆写出的 HMAC 都是**静默错签**：开源 Nacos 不校验签名，错的实现在自测环境全绿，到 MSE 上只有一个不说原因的 403（见 D1.1a 第三条锁）。resource 的连接符、`Timestamp` header 的大小写、时间戳的单位、naming `data` 的拼接顺序——每一个字节级细节都必须先过 D1.3a 的研究清单拿到出处，才允许出现在代码里。**在那之前，本仓库不得存在任何计算 SPAS 签名的代码。**

Stage 2 拿到规格后的模块形状（只有签名和注入位置这两件事是现在就能定的）：

```ts
// src/nacos/auth/spasSignature.ts —— 纯函数，不 import vscode、不读时钟（时间戳由参数传入）

/** config（CS）模块：签名注入 **header**（§7.6：Spas-AccessKey / Spas-Signature / Timestamp 三件套）。 */
export function spasConfigHeaders(input: {
  accessKey: string; secretKey: string; timestampMs: number;
  namespaceId?: string; group?: string;
}): Record<string, string>;

/** naming（NS）模块：签名注入 **请求参数**（§7.6：ak / signature / data 三件套）。 */
export function spasNamingParams(input: {
  accessKey: string; secretKey: string; timestampMs: number;
  groupedServiceName?: string;
}): Record<string, string>;
```

- 函数体内的每一条拼装规则旁必须有注释标出**出处 + 版本号 + 源码行**（研究备忘录的引用），这是 Stage 2 的评审硬项。
- `AkSkStrategy`（`src/nacos/auth/AkSkStrategy.ts`，架构文档 §12 目录树早已预留此文件名）组合两个纯函数：`decorate(context)` 按 `context.module` 分派；时钟通过构造注入（`now: () => number`，默认 `Date.now`）——**测试才可能锁 fixture**。`refresh()` 恒返回 `false`：签名没有「续期」概念，一个 403 是真拒绝（key 错 / 时钟漂移 / 权限不足），重试同一签名只会重复失败——这恰好符合 `withAuth` 对 `false` 的语义（`withAuth.ts:79-84`，不重试）。
- **`signatureVersion=v4`（区域派生密钥，§7.6 末句）明确排除在 D1 首版之外**：需要 region 输入与第二套派生逻辑，且没有 MSE v4 环境可验。schema 的 `.strip()` 注释（`schema.ts:56-63`）已为将来加 region 字段留了后门。文档与表单文案注明「暂不支持 v4 签名区域」。

### D1.3a 研究清单（Stage R 的全部内容；每项要「出处 + 版本号 + 源码行/文档锚点」）

逐项落档进架构文档 §7.6 的追加备忘录，缺一项不开 Stage 1：

- [ ] **config（CS）族的签名素材与拼装**：官方 Java 客户端（`nacos-client`，选定一个与 2.3.2 服务端同代的版本并记录版本号）中 config 模块的签名适配器（`SpasAdapter` 或其后继）——resource 由 tenant/group 如何拼、连接符是什么、双空/单空时签什么、signContent 与时间戳的连接方式。
- [ ] **config 族的 header 确切拼写**：`Spas-AccessKey` / `Spas-Signature` / `Timestamp` 三个名字的逐字符拼写与大小写（历史上存在 `timeStamp` 拼法的传闻——正因为如此才必须看源码而不是看博客）。
- [ ] **naming（NS）族的参数签名**：`ak` / `data` / `signature` 三个参数的确切名字；`data` 的内容（时间戳与 groupedServiceName 的拼接顺序与分隔符）；serviceName 为空时签什么；签名参数是进 query 还是 form（对 GET 与 PUT 是否不同）。
- [ ] **两族方言的边界**：登录、namespace、cluster 等既不属 CS 也不属 NS 的请求，官方客户端签不签、签什么——这决定 `NacosAuthRequestContext.module: 'other'` 的行为。
- [ ] **时间戳**：单位（毫秒/秒）、时区语义、MSE 的容忍窗口（决定「检查本机时钟」提示的阈值文案）。
- [ ] **MSE 侧验证行为**：MSE 官方文档关于开启鉴权后 SDK 接入的说明；signatureVersion v4 与 v1 的判别方式（确认 v1 默认可用，v4 排除的边界成立）。
- [ ] **对照第二实现**：用官方 Java 客户端（或 nacos-sdk-go / nacos-sdk-python，注明所选）对固定输入跑出真实签名值，作为 D1.6 向量测试的期望值来源——**期望值不允许由被测实现自己生成**。
- [ ] 覆盖研究的反例确认：开源 Nacos `nacos.core.auth.enabled=true` 时是否校验 SPAS（还是仅 token）——决定 live 验证必须用 MSE 而不能用自建服务器冒充。

### D1.4 凭据存储与表单

- **SK 进 SecretStorage，绝不进 globalState**：沿用密码的键位约定（`getPassword(id)` 同款依赖注入形态，`AuthStrategyDependencies` 增加 `getSecretKey(id)`）。AK 不是秘密（等价用户名），存 `NacosInstanceConfig.accessKeyId?: string`（schema 加可选字段，`.strip()` 保证老版本读新记录不炸）。
- 实例表单（`NacosInstanceFormPanel` + webview）：authMode 下拉解锁 `akSk` 选项，出现 AK（明文输入）与 SK（password 型输入）两栏；**切换鉴权模式时旧 SK 的去留必须与 §16.3 的最终裁决一致**（那条债记录了 manager 与表单行为相反——D1 动这里之前先把 16.3 了结，否则又添一处矛盾）。
- 表单帮助文案：「适用于阿里云 MSE。开源 Nacos 默认不校验签名；MSE 也支持用户名密码模式」——过渡指路语从 README 挪进表单，D1 合入后仍保留（它仍然是真话）。

### D1.5 文件清单（按阶段标注）

| 文件 | 动作 | 阶段 |
|---|---|---|
| `src/nacos/auth/NacosAuthStrategy.ts` | 接口扩容（D1.2） | 1 |
| `src/nacos/auth/NoAuthStrategy.ts` / `CustomHeaderStrategy.ts` / `UserPasswordStrategy.ts` | 机械迁移 | 1 |
| `src/nacos/auth/withAuth.ts` | context 读取 + params merge + 重试重签 | 1 |
| `src/nacos/NacosHttpClient.ts` | `NacosRequestOptions.auth` 字段（HttpClient 自身不消费它，只是载体——消费者是 withAuth） | 1 |
| `src/nacos/driver/*.ts`（helper 层全部） | 铺 `options.auth`（D1.2 清单） | 1 |
| `src/nacos/auth/createAuthStrategy.ts` | Stage 1 只改签名形状、**throw 保留**；Stage 2 拆 throw、接 `getSecretKey` | 1+2 |
| `src/nacos/auth/spasSignature.ts`、`src/nacos/auth/AkSkStrategy.ts` | 新增（每条拼装规则带出处注释） | 2 |
| `src/config/schema.ts` | `accessKeyId?` | 2 |
| `src/utils/logger.ts` 词表 | 补 `Spas-Signature` / `signature` / secretKey 模式 | 2 |
| 表单双侧 + nls + l10n | akSk 选项（见 D1.5a） | **3** |
| `README.md` | AK/SK 章节改为「已支持（v4 签名除外）」 | 3 |
| 测试 | 见 D1.6 | 各阶段 |

### D1.5a i18n 字符串清单（Stage 3）

nls（表单 webview 文案由扩展侧渲染，走 `buildWebviewStrings` 同款分工）：

| 英文源串（键） | zh-cn |
|---|---|
| `AccessKey ID` | AccessKey ID |
| `SecretKey` | SecretKey |
| `For Alibaba Cloud MSE. Open-source Nacos does not verify signatures by default; MSE also supports username/password mode. The v4 regional signature is not supported yet.` | 适用于阿里云 MSE。开源 Nacos 默认不校验签名；MSE 也支持用户名密码模式。暂不支持 v4 区域签名。 |
| `The SecretKey for this connection is not stored. Edit the connection and enter it again.` | 该连接的 SecretKey 未存储。请编辑连接并重新输入。 |
| `Nacos answered 403 for an AK/SK signed request. Check the AccessKey, the account's permission, and this machine's clock.` | AK/SK 签名请求被 Nacos 以 403 拒绝。请检查 AccessKey、账号权限与本机时钟。 |

### D1.6 测试（fixture 为主，live 为例外；文件 + describe/it 标题）

**Stage 1（`test/nacos/auth/withAuth.test.ts` 扩展 + 各策略测试改造）：**

```text
describe('withAuth with request contexts')
  it('passes options.auth to the strategy and falls back to module other with the path')
  it('merges decoration params under the caller's query, caller wins')
  it('re-decorates on the 403 retry')                                       // 时间戳新鲜度在 Stage 2 加假时钟断言
describe('the three existing strategies')
  it('answers the same decoration for any context')                          // NoAuth / CustomHeader / UserPassword 各一条
describe('context plumbing across the drivers')                              // 四驱动 × config/naming 各挑一方法
  it('sends module config with the same tenant and group the query carries') // 同源断言
  it('sends module naming with the grouped serviceName the request uses')
describe('createAuthStrategy after the interface widening')
  it('still throws for akSk')                                                // Stage 1 的铁门回归
```

**Stage 2（`test/nacos/auth/spasSignature.test.ts`、`AkSkStrategy.test.ts` 新增）：**

```text
describe('spas signature vectors')                                           // 期望值来自第二实现（D1.3a），注明生成方式
  it.each([...])('signs {caseName} byte-for-byte as the official client does')
  // 用例集至少含：tenant+group、仅 group、双空、中文 tenant、serviceName 含 @@
describe('AkSkStrategy dispatch')
  it('answers headers and no params for module config')
  it('answers params and no headers for module naming')
  it('signs only the timestamp material for module other')                    // 具体形状以研究备忘录为准
  it('gets a later timestamp on the retry decorate')                          // 注入假时钟递增
  it('never asks to retry: refresh answers false')
  it('fails loudly when the stored SecretKey is missing')                     // strip 过的旧记录
describe('redaction')
  it('keeps the secret key and the signature out of the logs')                // asRedactedLog 词表
```

**live（Stage 2 门禁，一次性）**：仅在 `AT_NACOS_LIVE_MSE_URL`（+ `AT_NACOS_LIVE_MSE_AK` / `AT_NACOS_LIVE_MSE_SK`）设置时执行，套 `test/live/liveServer.test.ts:47-49` 的按需跳过机制；CI 与默认本地永远 skip；**不租不借他人 MSE 实例做常规验证**。内容：config 读、config 写（临时命名空间）、naming 读各一发 + 一发故意错 SK 的 403 对照。

### D1.7 安全与坑

- **签名素材与请求参数不同源是最隐蔽的故障**：签了 `tenant=''` 但参数发了 `tenant=public`（或反过来）→ MSE 403，且报错不会告诉你差在哪。D1.2 的「同源变量」评审规则为此而设。
- naming 的 ak/data/signature 走请求参数 → **会进服务端 access log**。signature 是单次 HMAC、data 是时间戳+服务名，可接受；但实现绝不能图省事把 sk 或把 config 的签名也塞进 query。
- 时钟漂移：MSE 校验时间戳窗口。错误分类里给 403 + akSk 模式的场景补一条提示「检查本机时钟」。
- `refresh()` 返回 false 意味着 akSk 实例的 403 不重试——3.x admin→console 降级链（`forbidden` fall-through）不受影响，因为那发生在 resolver 层不是 withAuth 层。测试确认两层互不干扰。
- 拆除 createAuthStrategy 的 throw 之后，**旧配置里 authMode=akSk 但没存 SK 的实例**（理论上不存在，但 strip 过的旧记录可能构造出来）必须 fail loudly：decorate 时抛「未配置 SecretKey」，不得静默匿名。

### D1.7a 非目标

- v4 区域签名（排除理由见 D1.3）；OIDC / STS 临时凭据；按 namespace 粒度的多组 AK/SK；MCP 面暴露任何 akSk 相关信息（`nacos_list_instances` 的返回今天不含 authMode，保持）。

### D1.8 完成判据（按阶段验收）

- **Stage R done when**：架构文档 §7.6 追加备忘录落档，D1.3a 每项带出处版本号与源码行。
- **Stage 1 done when**：`decorate(context)` 全面替换 `authHeaders()`（编译器点名的调用点清零，不留旧别名）；三旧策略「无视 context」回归断言绿；akSk 的 throw 原样在（有测试锁）；全量 vitest 绿且产品行为零变化。
- **Stage 2 done when**：全部签名向量（第二实现生成）逐字节绿；`refresh()===false`；缺 SK fail-loudly；redaction 断言绿；MSE 实测 config 读写 + naming 读 + 错 SK 403 对照通过并记入架构文档 §14 追加节。
- **Stage 3 done when**：表单可选 akSk、SK 进 SecretStorage、§16.3 裁决落实、README/帮助文案更新、旧三模式零回归。

---

## Task D2: MCP 写工具（双闸门）——独立 PR

> **开工条件（§0.2 复述）：** Phase C 已合入 main（至少 C1 的 `refetchInstance` 与 patch 形 `updateInstanceHealth`）；skill 反向断言的改写过评审；Hub 端 `risk:'write'` 的确认行为已确认。三者缺一不动工。

### D2.0 现状核对表（2026-08-27 核实；`NacosAgentToolService.ts` 行号按 opt-1-8——该文件与 main 有分叉，main 上 resolveInstance 同名但行号不同）

| 事实 | 坐标 | 核对结果 |
|---|---|---|
| skill 对 Agent 承诺 MCP 只读 | `skills/at-nacos-mcp/SKILL.md:8-10`（frontmatter「not for publishing or deleting configs (MCP is read-only)」）；`references/tool-selection.md` 首段「All tools are risk: read … MCP does not expose write tools.」 | ✅ |
| 反向断言测试 | `test/docs/AtNacosMcpSkill.test.ts:42-43`（`not.toContain('nacos_publish')` / `'nacos_delete'`）、`:44`（`risk:\s*read`） | ✅ 改写方案见 D2.4 |
| 唯一的实例级闸门不区分读写 | opt-1-8 `src/agent/NacosAgentToolService.ts:169-205`（`resolveInstance`；`allowBackgroundAccess` 检查 `:184-193`） | ✅ |
| Agent 的 client 类型是只读 Pick | opt-1-8 `NacosAgentToolService.ts:41-56`（`NacosApiClientLike`，13 个读方法，无 publish/update） | ✅ 需加宽（见 D2.3a） |
| 错误码集合 | opt-1-8 `NacosAgentToolService.ts:63`（`VALIDATION_ERROR`/`NOT_FOUND`/`INTERNAL_ERROR`/`UNAVAILABLE`） | ✅ 写闸门拒绝用 `UNAVAILABLE`，不加新码 |
| 目录静态发布两处 | `src/mcp/BridgeServer.ts:145`（注册文件）与 `:231-236`（`GET /tools`），均直引 `AT_NACOS_TOOL_CATALOG`（`toolCatalog.ts:23`，13 条全 `risk:'read'`） | ✅ |
| 心跳只刷时间戳，无目录重发 | `BridgeServer.ts`（`heartbeat()` 调用处） | ✅ `republish()` 是新基础设施 |
| `NacosInstanceConfigManager` **无变更事件** | `src/config/NacosInstanceConfigManager.ts`（全文无 EventEmitter/onDidChange） | ✅ `onDidChangeInstances` 需本 Task 补 |
| `allowBackgroundAccess` schema 先例 | `src/config/schema.ts:52` | ✅ `allowAgentWrites` 照抄形状 |
| `assertWritable` 现居 vscode 模块 | `src/write/confirmWrite.ts:27-35`（文件 `:1` `import * as vscode`） | ✅ 需抽 `writable.ts`（vscode-free） |
| `.strict()` schema 惯例与 `describeZodError` | `src/mcp/bridgeSchemas.ts:15-19`、`:524` | ✅ 两工具沿用 |
| redaction 与 formatError | `NacosAgentToolService.ts:8`（`redactSensitiveText`）、`src/utils/errors.ts:10` | ✅ 写路径复用 |

### D2.1 现状与边界的来历

- 「界面可写，MCP 工具全部只读」是**需求阶段的明确决策**（架构文档 §3 读写边界行），M5 计划的安全边界一节重申，skill 文件（`skills/at-nacos-mcp/SKILL.md` frontmatter 第 9–10 行）对 Agent 声明「not for publishing or deleting configs (MCP is read-only)」，且 `test/docs/AtNacosMcpSkill.test.ts` 第 42–43 行**断言 tool-selection 表里不出现 `nacos_publish` / `nacos_delete` 字样**。改这条边界不是加个工具，是改一条产品级承诺——这就是它必须独立 PR、独立评审的原因。
- 现有闸门只有一道：`NacosAgentToolService.resolveInstance` 检查 `allowBackgroundAccess`（`src/agent/NacosAgentToolService.ts` 第 184 行附近），它管的是「Agent 能不能碰这个实例」，不区分读写。
- 目录是静态的：`AT_NACOS_TOOL_CATALOG` 常量在 `BridgeServer.start()` 发布进注册文件（`BridgeServer.ts` 第 145 行）并原样答复 `GET /tools`（第 236 行）。心跳只刷时间戳，**目录变化没有现成的重发机制**——这是本 Task 的基础设施工作量所在。

### D2.2 双闸门设计

**闸门一：每实例 `allowAgentWrites`，默认 false。**

```ts
// src/config/schema.ts
/** Agent 写操作按实例显式开启，且叠加在 allowBackgroundAccess 之上：background 关则本开关无意义。 */
allowAgentWrites: z.boolean().default(false),
```

- 表单里该复选框**从属于** allowBackgroundAccess（父项关闭时禁用并复位），文案明说「允许 Agent 通过 MCP 修改此服务器上的配置与实例状态」。
- `readOnly` 优先级最高：`readOnly && allowAgentWrites` 的组合在 UI 上不可能勾出（readOnly 勾选时写开关禁用），在服务层仍然要挡（防手改 globalState）。

**闸门二：catalog 条目 `risk: 'write'`。**

- `ToolCatalogEntry.risk` 是 Hub 协议字段，现有 13 工具全部 `'read'`。写工具标 `'write'`，Hub 端据此弹**它自己的**写确认——这就是「Agent 有 Hub 写确认」的含义，也是下一条规则的前提。
- **写工具复用 `publishConfig` / `toggleServiceInstanceEnabled` 的语义but绝不复用它们的 VS Code modal**：Agent 调用发生在没有人守着编辑器的场景，`vscode.window.showWarningMessage` 的 modal 会永远悬挂或被误解为 UI 卡死。确认责任移交给 Hub 的 risk 机制——插件侧的责任是把**语义安全**（重拉、整行、类型携带、只读断言）做进不依赖确认框的核心层。

**目录级闸门：无实例 opt-in 则写工具不进目录。**

```ts
// src/mcp/toolCatalog.ts
export function buildToolCatalog(options: { includeWriteTools: boolean }): ToolCatalogEntry[];
// includeWriteTools = 存在至少一个实例满足
//   allowBackgroundAccess && allowAgentWrites && !readOnly
```

- `BridgeServer` 改造：构造时接受 `getCatalog: () => ToolCatalogEntry[]`；`GET /tools` 每次现算；注册文件在实例配置变化时重发（新增 `BridgeServer.republish()`，由 `extension.ts` 在 `NacosInstanceConfigManager` 的变更回调里调用——若 manager 尚无变更事件，本 Task 顺带补一个 `onDidChangeInstances`）。
- **`/invoke` 不信任目录**（纵深防御）：即使写工具不在目录里，直接 POST `/invoke` 打工具名也必须被 `NacosAgentToolService` 的实例级闸门拒绝——目录只是「可发现性」闸门，不是安全闸门。

### D2.3 第一批两个工具（就这两个，删除类工具明确延后）

**永不作为默认 MCP 工具提供的清单（写进 skill 与本文档，双处锁定）：** `nacos_delete_config`、`nacos_delete_namespace`、`nacos_create_namespace`、`nacos_delete_service`、任何用户/角色/权限管理。其中删除类是**永不默认**（未来若真有需求，必须走独立的产品评审、独立的第四道闸门设计，不是本文档的延伸）；`AtNacosMcpSkill.test.ts` 改写后仍保留 `not.toContain('nacos_delete')` 断言把这条锁进 CI。

**`nacos_publish_config`（risk: 'write'）**

- 入参（zod + JSON Schema 双生子，沿 `bridgeSchemas.ts` 惯例 `.strict()`）：`instanceId`(必), `namespaceId?`, `group`(必), `dataId`(必), `content`(必), **`type`(必——描述里写明原因：Nacos 把空 type 存成 text，会重置配置格式；这与驱动层 `requiredType` 的 validation 拒绝一脉相承)**, `appName?`, `description?`, `configTags?`（C4 合入后）, `expectedMd5?`（C5 合入后映射 casMd5）。
- **overwrite 语义必须写进 description**（描述即契约，见 description-contracts 计划）：「Creates the configuration or replaces the whole row — Nacos has no partial update. Omitted appName/description/configTags fall back to the values currently stored (this tool re-reads before writing); to clear one, pass an empty string explicitly.」
- 实现：抽 vscode-free 核心 `src/write/publishConfigCore.ts`——把 `publishConfig.ts` 里「重读 latest → resource-not-found 视为新建 → type/appName/description(/tags) 携带 → (casMd5) → 驱动 publish」的纯逻辑搬进去，UI 的 `publishConfig` 与 Agent 共用；UI 层保留草稿、diff、modal。**`src/agent/**` 与 `src/write/publishConfigCore.ts` 不得 import vscode**（架构文档 §12 分层约定；现 `src/write/*` 均 import vscode，所以是「抽出」不是「引用」）。
- 返回：`{ published: true, created: boolean, dataId, group, namespaceId, newMd5? }`——**不回显 content**（Agent 手里本来就有它发的内容，回显只会把可能的密文再过一遍传输与日志）。

**`nacos_set_instance_enabled`（risk: 'write'）**

- 入参：`instanceId`(必), `namespaceId?`, `group?`(默认 DEFAULT_GROUP，沿 `DEFAULT_SERVICE_GROUP` 惯例), `serviceName`(必), `ip`(必), `port`(必, int), `cluster?`(默认 DEFAULT), `enabled`(必, boolean)。
- 实现：**必须传完整实例对象**——`listInstances` 现查 → 按 ip+port+cluster(+ephemeral) 匹配 → 匹配不到答 `NOT_FOUND`（消息列出现有实例地址帮 Agent 自纠）→ 把**新鲜完整行**交给 `updateInstanceHealth`（C1 之后是 patch 形：`{ enabled }`）。这与 C1 的 `refetchInstance` 是同一逻辑——**复用同一 helper**，Agent 路径不许长出第二份匹配代码。
- description 写明：「Sends the FULL instance row back (weight, metadata, ephemeral included) because Nacos rebuilds the instance from the request; this tool re-reads the instance first so nothing is reset.」——把 `updateInstanceHealthAt` 注释里的服务端事实翻译成 Agent 契约。
- 返回：`{ updated: true, address, enabled, weight, metadataKeys: string[] }`（键名不给值，metadata 值可能敏感）。

**Agent 层闸门（两工具共用）：**

```ts
// NacosAgentToolService 新增
private async resolveWritableInstance(instanceId: string) {
  // 1. resolveInstance 既有检查（存在 + allowBackgroundAccess）
  // 2. allowAgentWrites === true，否则 UNAVAILABLE：
  //    "Nacos instance {label} does not allow Agent writes. Ask the user to enable
  //     'Allow Agent writes' on this connection."
  // 3. assertWritable(instance) —— readOnly 拒绝。
  //    ⚠ assertWritable 现居 src/write/confirmWrite.ts，该模块 import vscode；
  //    先把 assertWritable 挪到新的 src/write/writable.ts（vscode-free），confirmWrite 回头 re-export。
}
```

### D2.3a 确切的类型改动（TypeScript 片段）

```ts
// src/agent/NacosAgentToolService.ts —— 只读 Pick 加宽两个写方法（现 :41-56）
export type NacosApiClientLike = Pick<
  NacosClient,
  | 'listNamespaces' | 'listConfigs' | 'getConfig' | /* …既有 13 个读方法原样… */
  | 'publishConfig'
  | 'updateInstanceHealth'
>;
// createClient 工厂（NacosClientPool 路径）不用改：NacosClient 本来就有这两个方法，
// 收窄发生在 Pick，放宽也只发生在 Pick。

// src/config/NacosInstanceConfigManager.ts —— 补变更通知（为了 manager 的既有测试不引宿主，
// 用轻量回调而不是 vscode.EventEmitter）
export interface NacosInstanceConfigManagerOptions {
  /** Fired after any save/delete changed the stored list. Used to republish the MCP catalog. */
  onDidChangeInstances?: () => void;
}

// src/mcp/toolCatalog.ts —— 目录改为函数（既有常量拆成 READ_TOOLS 与 WRITE_TOOLS 两组内部常量）
export function buildToolCatalog(options: { includeWriteTools: boolean }): ToolCatalogEntry[];

// src/mcp/BridgeServer.ts —— 构造依赖注入目录来源 + 重发
constructor(deps: { /* 既有 */ getCatalog: () => ToolCatalogEntry[] });
async republish(): Promise<void>;   // 重写注册文件（publish 同款 payload，tools 现算），心跳不动
```

`bridgeSchemas.ts` 新增 `nacosPublishConfigSchema` / `nacosSetInstanceEnabledSchema`（`.strict()`）+ 对应 `NACOS_PUBLISH_CONFIG_INPUT_SCHEMA` / `NACOS_SET_INSTANCE_ENABLED_INPUT_SCHEMA` JSON 双生子 + `BRIDGE_SCHEMAS_BY_TOOL_NAME` 两条注册。

### D2.3b i18n 字符串清单

表单（nls + webview strings）：

| 英文源串（键） | zh-cn |
|---|---|
| `Allow Agent writes` | 允许 Agent 写入 |
| `Lets AI agents publish configurations and enable/disable service instances on this server through MCP. Requires background access; ignored while the connection is read-only.` | 允许 AI Agent 通过 MCP 在此服务器上发布配置、上下线服务实例。需要先开启后台访问；连接为只读时本开关无效。 |

Agent 侧错误消息**不走 `t()`**（`src/agent/**` 不 import vscode，§12 分层；错误消息面向模型，保持英文）——`Nacos instance {label} does not allow Agent writes. Ask the user to enable 'Allow Agent writes' on this connection.` 原文即成品。

### D2.4 skill 与文档同步（与代码同 PR，缺一即评审打回）

- `skills/at-nacos-mcp/SKILL.md`：frontmatter 删掉「not for publishing or deleting configs (MCP is read-only)」，替换为诚实版本：「Write tools (publish config, enable/disable instance) exist but appear only when a connection opted in to Agent writes; deleting anything is still not possible via MCP.」正文 Core workflow 补写前守则：写前必 `nacos_get_config` 确认现状、发布后复述 dataId+环境、拿不到写工具时指引用户开 `allowAgentWrites` 而不是重试。
- `skills/at-nacos-mcp/references/tool-selection.md`：补两行工具表（risk: write）。
- `test/docs/AtNacosMcpSkill.test.ts`：**反向断言要改写**——第 42–43 行的 `not.toContain('nacos_publish')` 改为断言写工具行存在且标注 write risk、且「delete」类工具名仍然缺席。
- `README.md` MCP 章节：「13 个只读工具」的措辞更新为「13 读 + 2 写（默认关闭，双闸门）」。

### D2.5 文件清单

| 文件 | 动作 |
|---|---|
| `src/config/schema.ts` | `allowAgentWrites` 默认 false |
| 表单双侧 + nls + l10n | 写开关（从属 background 开关） |
| `src/mcp/toolCatalog.ts` | `buildToolCatalog({includeWriteTools})` + 两个写条目（risk:'write'） |
| `src/mcp/bridgeSchemas.ts` | 两工具 zod + JSON Schema 双生子 + `BRIDGE_SCHEMAS_BY_TOOL_NAME` |
| `src/mcp/BridgeServer.ts` | `getCatalog` 注入、`/tools` 现算、`republish()` |
| `src/write/writable.ts`（新）、`src/write/publishConfigCore.ts`（新） | vscode-free 抽取 |
| `src/write/publishConfig.ts` | 改为调 core（行为零变化，测试保回归） |
| `src/agent/NacosAgentToolService.ts` | `resolveWritableInstance` + 两个 handler |
| `src/extension.ts` | 配置变更 → `republish()`；`NacosInstanceConfigManager` 补变更事件（如无） |
| skill 两文件、README、`test/docs/AtNacosMcpSkill.test.ts` | D2.4 |
| 测试新增：`test/mcp/toolCatalog.test.ts`、`bridgeSchemas.test.ts`、`BridgeServer.test.ts`、`test/agent/NacosAgentToolService.test.ts`、`test/write/publishConfigCore.test.ts` | 见 D2.6 |

### D2.6 测试（文件 + describe/it 标题）

`test/agent/NacosAgentToolService.test.ts`（扩展）：

```text
describe('the write gate matrix')                       // 本 Task 的核心测试，it.each 八组合
  it.each(gateMatrix)('allows only background=true writes=true readOnly=false and refuses %s with UNAVAILABLE naming the switch')
describe('nacos_publish_config')
  it('refuses a missing type with VALIDATION_ERROR before any connection is made')
  it('re-reads the stored row and carries appName, description and tags when omitted')
  it('clears a field when the caller passes an explicit empty string')
  it('reports created true for a new dataId and false for an overwrite')
  it('never echoes the content back in the result')
  it('maps expectedMd5 to casMd5 and surfaces a CAS refusal as a conflict message')   // C5 合入后
describe('nacos_set_instance_enabled')
  it('writes the fresh full row: weight and metadata come from the re-read, not the input')
  it('answers NOT_FOUND listing the candidate addresses when no instance matches')
  it('defaults group to DEFAULT_GROUP and cluster to DEFAULT')
  it('keeps metadata values out of the result, returning key names only')
```

`test/mcp/toolCatalog.test.ts`（新）：

```text
describe('buildToolCatalog')
  it('answers the same 13 read tools as today when no instance opted in')             // 逐字节与旧常量比对
  it('appends the two write tools with risk write when includeWriteTools is true')
  it('never contains a delete-style tool name under either flag')                      // 永不默认清单的 CI 锁
```

`test/mcp/BridgeServer.test.ts`（扩展）：

```text
  it('computes /tools from getCatalog on every request')
  it('rewrites the registry file with the current catalog on republish')
  it('still refuses a write tool invoked directly through /invoke when no instance opted in')  // 纵深防御
```

`test/write/publishConfigCore.test.ts`（新）：

```text
describe('publishConfigCore')
  it('treats resource-not-found as creating from an empty baseline')
  it('carries type, appName, description and tags through the republish')
  it('behaves the same as the UI publishConfig path')                                   // UI 既有测试全数保绿即为证
```

模块边界（`test/docs/` 或 `test/mcp/` 下的轻量读盘测试）：

```text
  it('keeps vscode imports out of src/agent, src/mcp (hubSync excepted), publishConfigCore and writable')
```

skill 一致性：`AtNacosMcpSkill.test.ts` 改写后含 `it('documents the two write tools with risk write and still forbids delete-style tools')`。

**live / 人工验收**：默认安装（零 opt-in）的 `tools/list` 与今天逐字节一致；勾开关后经 Cursor Hub 真实 publish 一次（临时命名空间）且**被 Hub 写确认拦截过一次**——记录截图/文字进 PR 描述。

### D2.7 安全与坑

- **双闸门 + 目录闸门 + Hub risk 确认是四层，缺谁都不行，但也别多**：插件侧不再加自己的「模拟确认」（没有人在场，任何插件侧交互都会挂死调用）。
- 写结果不回显 content、metadata 值——Agent 的输出会进模型上下文与会话记录。
- 删除类（配置删除、命名空间删除、服务删除）**明确不做**，路线图 D2 原文「删除/命名空间删除延后」。skill 里把「MCP 不能删任何东西」作为仍然成立的承诺写清楚。
- 每次工具调用新建客户端（含登录+探测）的既有成本（路线图 B6）在写路径上意味着「重读 + 写」共享同一连接池实例——B6 若先落地，写工具沿用其非交互池；未落地也不阻塞本 Task。
- 结果与错误消息里绝不出现 token/密码（`formatError` + redaction 既有机制覆盖，加用例锁住写路径）。

### D2.8 完成判据

- 双闸门矩阵测试绿；默认安装（零 opt-in）的 `tools/list` 与今天逐字节一致；勾开关后 Cursor 里通过 Hub 走通一次真实 publish（临时命名空间）并被 Hub 写确认拦截过一次（人工验收记录截图/文字进 PR 描述）；skill 与 README 不再含「MCP 只读」的过时承诺。

---

## Task D3: 灰度 / Beta ——独立 PR（本阶段只做 READ 侧）

> **开工条件：** 读侧无外部前置，随时可做。**写侧不满足 D3.2 末尾三条件不得动工**——那不是「建议」，是本 Task 与 §14.3「不要凭调研写死代码」纪律的直接推论。

### D3.0 现状核对表（2026-08-27 核实）

| 事实 | 坐标 | 核对结果 |
|---|---|---|
| 驱动层无任何 beta/gray 方法 | `NacosDriver.ts:215-265` 接口全文 | ✅ |
| 3.x 历史行带 `publishType`/`grayName` 是仓内唯一的 3.x 灰度一手记录 | 架构文档 §6.6 | ✅ 引用属实 |
| `missingCapability` 先例 | `V3ConsoleDriver.ts:175`（`getServerMetrics`） | ✅ v3 双驱动首版照抄 |
| 3.0/3.1 对 v1 CONSOLE_API 默认 410、fall-through 链 | 架构文档 §4.2 表、§5.4 | ✅ 无需特判的依据 |
| 「配置不存在」的响应形状从不长在调研预言的位置 | 架构文档 §14.2 ⓪ | ✅ 「无 beta 行」形状必须实测的依据 |
| diff 底座与虚拟文档 | `src/document/configUri.ts` / `NacosConfigDocumentProvider.ts`（M4） | ✅ `beta=1` 是 URI 加 query，不动 scheme |
| 1.x/2.x beta 端点（`?beta=true` 三方法 + `betaIps` header） | 官方文档/控制台行为，**无真机验证** | ⚠ 2.3.2 live 是本 Task 的验证义务 |

### D3.1 语义分裂的事实（为什么写侧不能现在做）

- **1.x/2.x 的 Beta 模型**：发布时带 HTTP **header** `betaIps: ip1,ip2`（参数与正常发布相同，`POST /v1/cs/configs`），服务端另存一行 beta 配置（`config_info_beta` 表）；查询 beta 行走 `GET /v1/cs/configs?beta=true`（返回 content + betaIps）；停止灰度 `DELETE /v1/cs/configs?beta=true`。beta 行与正式行**并存**，命中 betaIps 的客户端拿 beta 内容。
- **3.x 的 Gray 模型**：beta 被泛化成具名灰度版本——历史行带 `publishType: formal|gray` 与 `grayName`（架构文档 §6.6，这是本仓库关于 3.x 灰度**唯一**的一手记录），发布面变成 publishType=gray + 灰度规则表达式（按标签/IP 等规则路由）。**确切的 API 路径、参数名、规则表达式 JSON 形状，本仓库没有任何一手证据**：无 3.x 环境（§14.3 整节），调研也未覆盖灰度端点。
- 两代模型不只是参数名不同——**数据模型不同**（匿名单 beta 行 vs 具名多灰度版本），归一化层无法在没见过 3.x 响应的情况下设计一个两边都对的领域类型。**写侧在 3.x 形状探明之前动手，产出的必然是猜测性代码**，违反本仓库「不要凭调研写死代码」的既定纪律（§14.3 开头原话）。

### D3.2 本阶段范围：只做 READ，且 v3 诚实降级

**驱动能力 `getBetaConfig`（新方法，四驱动齐改）：**

```ts
// NacosDriver.ts
export interface NacosBetaConfigInfo {
  /** beta/灰度行的内容。 */
  content: string;
  /** 1.x/2.x：betaIps 列表。3.x gray 模型下为空。 */
  betaIps?: string[];
  /** 3.x：灰度版本名。1.x/2.x 恒缺席。 */
  grayName?: string;
  md5?: string;
}
/** 无灰度发布时返回 undefined —— 「没有 beta 行」是常态不是错误。 */
getBetaConfig(ref: NacosConfigRef): Promise<NacosBetaConfigInfo | undefined>;
```

- **v1/v2**：`GET /v1/cs/configs?beta=true`（v1 方言：tenant/group；V2Driver 照 config 惯例走 v1 路径）。响应形状（RestResult 包 `ConfigInfo4Beta`：`content`/`betaIps`/`md5`）**需真机确认**——2.3.2 可验，列入 live 清单。「无 beta 行」的应答形状（空 data？404？200 空体？）同样必须实测——参照 §14.2 ⓪ 的教训，这类「不存在」形状从来不长在调研预言的位置。
- **v3-admin / v3-console**：首版一律 `missingCapability('Nacos 3.x 灰度查询端点尚未在本项目中验证……')`——先例即 `V3ConsoleDriver.getServerMetrics`。**宁可对 3.x 用户说「暂不支持」，不可打一个猜的路径**（猜错的 404 会触发 fall-through 链游走，最终报出误导性的「no flavor could serve」）。
- 3.0/3.1 注意：`?beta=true` 属于 v1 config 路径的 CONSOLE_API 查询形态，大概率被 410 拦（§4.2 表）——410 → fall through 到 v3 驱动 → missingCapability，链条自然给出「3.x 暂不支持」的最终答案，无需特判。

**UI 呈现（读侧的全部产品面）：**

- 配置树节点 tooltip / A7 详情面板追加一行：「灰度发布中 → 192.168.1.10, 192.168.1.11」（有 beta 行时）。取数时机：**打开详情/悬停时按需查，不进列表批量查**（每配置多一发请求，列表批量查会把 namespace 展开的请求数翻倍）。
- 历史面板：3.x 的历史行已带 `publishType`/`grayName`（归一化若尚未透传则顺带补上），渲染成标签——这是 3.x 用户在写侧落地前唯一能看到的灰度信号，也是零风险的。
- 新命令 `atNacos.showBetaConfig`（配置节点右键）：有 beta 行时用只读虚拟文档打开 beta 内容并与正式内容 diff（复用 M4 的 diff 底座——URI 加 `beta=1` query 形态，document provider 分支到 `getBetaConfig`）；无 beta 行给一句话信息框。
- **MCP 不暴露**（读侧也不急——先让人用起来，Agent 面等写侧一并设计）。

**写侧的启动条件（写进本文档，未来 PR 引用）：** ① 拿到 3.x 环境并实测灰度发布/停止/查询三端点的路径与形状，记入架构文档 §14；② 停止灰度（DELETE beta 行）的确认文案与误删防护设计过评审；③ betaIps 输入的校验与「全量 IP 误写成灰度」的反向风险讨论。三者齐备前写侧 PR 不开工。

### D3.3 文件清单与实施清单

| 文件 | 动作 |
|---|---|
| `NacosDriver.ts` + 四驱动 + `NacosClient.ts` + resolver 能力名 `config-beta` | 读能力（v3 双驱动 missingCapability） |
| `src/nacos/driver/normalize.ts` | `NacosBetaConfigInfo` 归一化 + 历史行 `publishType`/`grayName` 透传 |
| `src/document/configUri.ts` / `NacosConfigDocumentProvider.ts` | `beta=1` URI 形态 |
| 树 tooltip / 历史面板 / `showBetaConfig` 命令 + manifest + l10n | 呈现层 |
| `test/nacos/driver/betaConfig.test.ts`（新）等 | 下述测试 |

- [ ] 驱动读能力 + 归一化（betaIps 逗号串拆数组、md5 可缺）
- [ ] 「无 beta 行」两种形状（实测后固化）→ undefined
- [ ] v3 双驱动诚实拒绝 + 链条终点文案可读
- [ ] UI 三处呈现 + diff 命令
- [ ] live（2.3.2 临时命名空间）：curl 手工发一条 beta（header betaIps）→ 插件读出并 diff → 记录响应原文进架构文档
- [ ] 全量 vitest 通过

### D3.3a UI 接线与 i18n

```jsonc
// contributes.commands
{ "command": "atNacos.showBetaConfig", "title": "%atNacos.showBetaConfig.title%" }
// view/item/context（恰好一条；只读命令 → 正则含 readonly，与 showConfigHistory 同款）
{ "command": "atNacos.showBetaConfig", "when": "viewItem =~ /^atNacos\\.config\\b/", "group": "atNacos.inspect@5" }
// commandPalette: when "false"
```

nls：`atNacos.showBetaConfig.title` = Show Gray/Beta Release / 查看灰度发布。

bundle：

| 英文源串（键） | zh-cn |
|---|---|
| `{dataId} has no gray/beta release.` | {dataId} 没有灰度发布。 |
| `Gray release for {betaIps}` | 灰度发布 → {betaIps} |
| `{dataId}: Formal vs Gray Release` | {dataId}：正式版 vs 灰度版 |
| `Gray/beta queries are not supported for Nacos 3.x yet. The 3.x gray model has not been verified in this project.` | Nacos 3.x 的灰度查询暂不支持——3.x 灰度模型尚未在本项目中验证。 |

（最后一条是 `missingCapability` 的消息——它在驱动层，英文为主体、错误提示层照 §16.1 现状展示。）

### D3.4 测试与坑（文件 + describe/it 标题）

`test/nacos/driver/betaConfig.test.ts`（新）：

```text
describe('getBetaConfig on v1 and v2')
  it('asks the v1 config path with beta=true in the v1 dialect')            // tenant + group
  it('normalizes content, comma-separated betaIps and an optional md5')
  it('answers undefined for the no-beta shape')                              // 形状 live 实测后固化
describe('getBetaConfig on 3.x')
  it('refuses with missingCapability on both v3 drivers')
  it('ends the 410 fall-through chain in the honest 3.x refusal')            // 链条终点文案可读
```

`test/document/NacosConfigDocumentProvider.test.ts` / 树与命令测试：

```text
  it('routes a beta=1 uri to getBetaConfig')
  it('diffs the formal content against the beta content with the right titles')
  it('shows the one-sentence message when there is no beta row')
```

坑：**beta 行内容同样含密文**——走与正式内容相同的虚拟文档通道（不落盘、MCP 不可达）；「无 beta」绝不能报错（那是绝大多数配置的常态）；不要把 `beta=true` 加进列表请求（列表接口带全量 content 的老问题——§14.2 ②——会在 beta 维度上翻倍）。

非目标（读侧 PR 里出现即跑偏）：发布/停止灰度（写侧）；灰度规则编辑；MCP 暴露；3.x 灰度路径的任何猜测性实现。

### D3.5 完成判据

- 2.3.2 上 beta 行可见可 diff；3.x 用户得到明确的「暂不支持」而非报错；写侧启动条件三条写入架构文档待办。

---

## Task D4: 导出单条配置到文件 ——独立 PR（zip 延后）

> **开工条件：** 无外部前置。唯一的产品决策（原文落盘、不脱敏、成功提示里告知）已在 D4.2 拍板，实现者不再重开讨论。

### D4.0 现状核对表（2026-08-27 核实）

| 事实 | 坐标 | 核对结果 |
|---|---|---|
| 非 ASCII dataId 的 URI 百分号编码问题 | 架构文档 §16.6 | ✅ 文件名 sanitize 的动机 |
| `getConfig` 的重读语义与 `resource-not-found` | `NacosDriver.ts:410-434`、`:455-461` | ✅ 取数走它，不走编辑器 buffer |
| 配置节点 contextValue 与编辑器标题菜单条件 | `NacosTreeItems.ts:190`（`atNacos.config`）；`nacos:` scheme（`configUri.ts`） | ✅ 两处入口的 `when` 依据 |
| zip 导出端点是控制台半官方、V1/V2 两代 zip 格式、3.x 又换 | 路线图 D4 行 + 调研记录；本仓库无一手验证 | ⚠ 这就是 zip 延后的理由，不要在本 PR 里「顺手」碰 |

### D4.1 范围决策

路线图 D4 原文：「控制台半官方接口，跨版本差；可先做单配置另存为」。所以：

- **做**：`atNacos.exportConfig`——把一条配置的当前服务端内容另存为本地文件。纯客户端组合（`getConfig` + `vscode.window.showSaveDialog` + `vscode.workspace.fs.writeFile`），**不触碰任何导出端点**。
- **不做（显式延后）**：zip 导出/导入。理由值得记录：`GET /v1/cs/configs?export=true` 系列是控制台自用的半官方接口，zip 内部格式有 V1/V2 两代（metadata.yml 差异），3.x 又换了形状，且**导入**是批量写操作——它的确认粒度、冲突策略、命名空间映射都需要独立设计。等有真实需求再立项。

### D4.2 设计细节

- 入口：配置树节点右键 + 已打开的 `nacos:` 虚拟文档编辑器标题菜单（`resourceScheme == nacos`）。
- 取数：**重新 `getConfig`**，不用编辑器 buffer——buffer 可能是历史版本 diff 的一侧或过期内容；导出的承诺是「服务端此刻的内容」。
- 默认文件名：dataId 经 `sanitizeFilename` 处理——dataId 合法地含 `/`（架构文档 §16.6 记录过它对 URI 的影响），`/` 与平台非法字符替换为 `_`；非 ASCII 保留原文（本地文件系统没有百分号编码问题）。
- **内容原文写盘，不脱敏**，但确认这一点是显式产品决策并告知：保存对话框打开前不弹额外确认（多一层点击惩罚正常用户），改为**成功提示里写明**「已导出原文（含未脱敏的敏感值），请注意文件安全」。理由：用户主动导出到自己磁盘，与 MCP 的默认脱敏（防内容进模型上下文）是两个威胁模型；导出一份脱敏文件对「备份/迁移」的核心用途是负价值。
- 编码 UTF-8 无 BOM；写入失败（权限/磁盘）走标准错误提示。
- 顺带的小扩展（同 PR，可选）：历史面板每行加「导出此版本」，复用同一保存函数，取数换 `getConfigHistory`——文件名后缀 `.<nid>`。

### D4.3 文件清单 / 实施清单 / 测试

| 文件 | 动作 |
|---|---|
| `src/document/exportConfig.ts`（新） | 取数 + sanitize + 保存对话框 + 写盘 |
| `src/extension.ts` / `package.json` / nls / l10n | 命令 + 两处菜单 + 文案 |
| `test/document/exportConfig.test.ts`（新） | 下述测试 |

- [ ] `sanitizeFilename` 纯函数（`/`、`\`、`:` 等替换；空串/全非法字符时回退 `config.txt`；非 ASCII 保留）
- [ ] 主流程 + 取消保存对话框零写盘 + 网络失败传播
- [ ] 成功提示含安全提醒字样
- [ ] 全量 vitest 通过

**UI 接线：**

```jsonc
// contributes.commands
{ "command": "atNacos.exportConfig", "title": "%atNacos.exportConfig.title%" }
// view/item/context（恰好一条；只读命令 → 正则含 readonly）
{ "command": "atNacos.exportConfig", "when": "viewItem =~ /^atNacos\\.config\\b/", "group": "atNacos.inspect@6" }
// editor/title（第二入口不在 view/item/context，不触碰 nodeMenu 的「恰好一条」约束）
{ "command": "atNacos.exportConfig", "when": "resourceScheme == nacos", "group": "navigation" }
// commandPalette: when "false"
```

**i18n：** nls `atNacos.exportConfig.title` = Export Configuration to File / 导出配置到文件。bundle：

| 英文源串（键） | zh-cn |
|---|---|
| `Export {dataId}` | 导出 {dataId} |
| `Configuration {dataId} was exported to {path}. The file holds the raw content, including any unredacted secrets - keep it safe.` | 配置 {dataId} 已导出到 {path}。文件为原文内容（含未脱敏的敏感值），请注意文件安全。 |

**测试（`test/document/exportConfig.test.ts`，unit）：**

```text
describe('sanitizeFilename')
  it.each: 'com/example/service.yml' → 'com_example_service.yml'；'订单服务.yaml' 原样保留；
           'a:b?c' → 'a_b_c'；'' 与全非法字符 → 'config.txt'
describe('exportConfig')
  it('re-reads the configuration from the server instead of the editor buffer')
  it('writes the content byte-for-byte, with no trailing newline appended')
  it('makes no fs call when the save dialog is cancelled')
  it('propagates a network failure without touching the disk')
  it('mentions the unredacted-content warning in the success message')
```

**非目标：** zip 导出/导入（理由见 D4.1，需求出现再立项）；导出时脱敏开关（威胁模型不同，见 D4.2）；批量导出整命名空间。

### D4.4 安全与坑

- 唯一的实质安全点就是**密文落盘**，D4.2 已作为显式决策处理；不要日后「顺手」在这里加脱敏开关把简单功能复杂化——需要脱敏导出的场景（分享给别人）等真实需求出现再说。
- 不要用 `document.getText()` 走捷径（错误来源见 D4.2 取数条）。

### D4.5 完成判据

- 任意配置（含中文、含 `/` 的 dataId）可导出，文件内容与服务端逐字节一致；历史版本导出可用（若做）；测试绿。

---

## Task D5: mcp-hub 拆分子路径导出 ——上游任务 + 本地可选缓解，独立 PR

> **开工条件：** 第一步永远是测量（D5.3）。测量数字 < ~100KB（minify 后）→ 本地缓解**不做**，只交上游请求文本 + 数字落档，本 Task 即可关闭。

### D5.0 现状核对表（2026-08-27 于本仓库 node_modules 与源码核实）

| 事实 | 坐标 | 核对结果 |
|---|---|---|
| `@at-series/mcp-hub` 只有 `"."` 与 `"./hub"` 两个导出 | `node_modules/@at-series/mcp-hub/package.json` `exports` 字段 | ✅ 逐字核对：`{".": {types, default: "./dist/index.js"}, "./hub": {default: "./dist/hub.js"}}` |
| `hubSync.ts` 的版本探测是三级回退：sidecar `hub-version.json`（`:10-19`）→ `require('@at-series/mcp-hub/package.json')`（`:22`，**上游 exports 未声明 `./package.json`，此路在严格解析下抛错**）→ `require.resolve('.../hub')` 后路径拼接（`:24-26`） | `src/mcp/hubSync.ts:9-28` | ✅ 兜底已在；但上游请求文本仍应包含「保留 `"./package.json"` 导出」，让主路径而不是兜底路径工作 |
| 扩展主 bundle 是 CJS | `esbuild.config.mjs:15-18`（`entryPoints: ['src/extension.ts']`、`format: 'cjs'`） | ✅ CJS 不可 tree-shake、无 splitting 的前提成立 |
| 从 `"."` 导入的 6 处 | `extension.ts` / `BridgeServer.ts` / `BridgeProtocol.ts` / `McpConfigInstaller.ts` / `hubSync.ts` + type-only 两处（`toolCatalog.ts:1`、`bridgeSchemas.ts`） | ✅ type import 编译期擦除，不构成体积问题 |

### D5.1 问题的准确陈述（已在本仓库核实）

- `@at-series/mcp-hub@0.3.2` 的 `package.json` **只有两个导出**：`"."`（`dist/index.js`，**CJS**——`"type": "commonjs"`）与 `"./hub"`。它的 dependencies 是 `@modelcontextprotocol/sdk`、`js-yaml`、`semver`。
- 本插件从 `"."` 导入的位置共 6 处：`extension.ts`（`detectHostApp`）、`BridgeServer.ts`（`FsBridgePublisher`/token 工具）、`BridgeProtocol.ts`（协议常量）、`McpConfigInstaller.ts`（installer 目标）、`hubSync.ts`（`syncHubBundle`）、以及两处 type-only（`toolCatalog.ts`、`bridgeSchemas.ts`——type import 编译期擦除，不构成问题）。
- esbuild 打 `dist/extension.js`（`format: 'cjs'`，`esbuild.config.mjs`）：**CJS 模块图不可 tree-shake**，`require('@at-series/mcp-hub')` 解析到的 `dist/index.js` 把 installer（js-yaml 消费者）与 sync（semver 消费者）整包带进来——于是 `js-yaml` 与 `semver` 的完整实现躺在每个用户的 `extension.js` 里，即使那个用户从不运行「安装 MCP 配置」命令。这就是路线图 D5 那句「js-yaml/semver 被 CJS 整包打进 extension.js」。
- **这是上游（`../at-series-mcp-hub`，见架构文档 §15 引用路径）的包结构问题，本仓库单方面修不干净**——deep-import `dist/**` 内部文件绕过 exports 字段是脆弱的（上游任何一次内部重组都会破坏我们），不作为方案。

### D5.2 上游请求（本 Task 的主交付物之一：一份可直接提交的请求文本）

向 `at-series-mcp-hub` 提出 export map 拆分（issue/PR 均可，按该仓库协作惯例）：

```jsonc
// 建议的 package.json exports（新旧并存，"." 保留 = 零破坏性）
{
  "exports": {
    ".":          { "types": "./dist/index.d.ts",    "default": "./dist/index.js" },
    "./hub":      { "default": "./dist/hub.js" },
    "./bridge":   { "types": "./dist/bridge.d.ts",   "default": "./dist/bridge.js" },
    "./install":  { "types": "./dist/install.d.ts",  "default": "./dist/install.js" },
    "./sync":     { "types": "./dist/sync.d.ts",     "default": "./dist/sync.js" }
  }
}
```

- 切分原则按**依赖重量**而不是按主题：`./bridge` = FsBridgePublisher + token + 协议常量 + detectHostApp + 全部类型（零第三方依赖，插件激活路径唯一需要的子集）；`./install` = McpInstaller 系（js-yaml 唯一消费者）；`./sync` = syncHubBundle（semver 唯一消费者）。
- 请求文本里附上量化依据（D5.3 的 metafile 数字），并说明消费者侧改造只是 import 路径替换。
- 顺带提请：若上游愿意出双格式（ESM + CJS），esbuild 可直接 tree-shake，子路径都可以省——但这改动更大，作为可选项而非要求。
- 上游版本发布后本仓库跟进 PR：6 处 import 换子路径 + `hubSync.ts` 里 `require('@at-series/mcp-hub/package.json')` 的解析路径复核。exports 字段会挡住未声明的子路径——上游应保留 `"./package.json": "./package.json"` 导出（写进请求文本）；`hubSync.ts:24-26` 的路径拼接兜底虽能扛住缺失，但兜底不该成为常规路径。

### D5.3 本地缓解（可选，先测量后动手）

- [ ] **第一步永远是测量**：`esbuild.config.mjs` 加 `metafile: true` + 一个 `scripts/analyze-bundle.mjs`（读 metafile 打印按输入文件聚合的字节占比）。跑出 js-yaml + semver 在 `dist/extension.js` 里的实际字节数。**若合计 < ~100KB（minify 后），本地缓解到此为止**——记录数字，等上游，不为几十 KB 引入加载复杂度。
- [ ] 超过阈值才做**懒加载第二 bundle**（唯一站得住的本地方案）：
  - 新 esbuild entry `src/mcp/lazy/installAndSync.ts`（re-export `McpConfigInstaller` 所需 + `syncHubBundle`）→ `dist/lazy/mcp-install.js`（platform node / cjs）。
  - `extension.ts` 与 `hubSync.ts` 的调用点改为运行时 `createRequire(__filename)(context.asAbsolutePath('dist/lazy/mcp-install.js'))`——`hubSync.ts` 里已有 createRequire 先例。类型走 `import type`（编译期擦除）。
  - 打包脚本（`scripts/package.mjs` / `.vscodeignore`）确认带上 `dist/lazy/**`。
  - **为什么不是动态 `import()`**：`format: 'cjs'` 下 esbuild 不做 code-splitting（splitting 仅 esm），动态 import 的包仍会被内联；而 VS Code 扩展主入口在 `engines.vscode ^1.85` 上必须是 CJS。这个约束写进代码注释，防止后人「优化」回去。
- 注意 `./hub`（`dist/hub.js`，Hub 运行时 bundle）与本问题无关：它经 `scripts/copy-hub.mjs` 作为独立文件分发，不进 extension.js——不要误伤。

### D5.4 测试与完成判据

- 测试：analyze 脚本对 metafile 的解析有一条冒烟用例；懒加载方案落地时——激活路径（`activate` 全流程夹具）不触发 lazy bundle 加载、`installMcpConfig` 命令首次调用成功加载并复用缓存、bundle 缺失时报可读错误（提示重装扩展）而非裸 MODULE_NOT_FOUND。
- 完成判据（两个层次，允许只完成第一层即关闭本 Task）：
  1. **必达**：测量数字落档（本文档追加一节或 PR 描述）；上游请求已提交，内含 export map 提案、`"./package.json"` 保留条款与量化依据。
  2. **视测量结果**：本地懒加载合入，`dist/extension.js` 体积下降数字记录在 PR；或明确记录「低于阈值，不做本地缓解，等上游」。
- 上游发版后的跟进 PR（import 路径替换）另行开单，不算在本 Task 内。

---

## Phase D 整体纪律复述

- [ ] 五个任务五个 PR，互不搭车；D2 另需 Phase C 先合入；每个 PR 开工前把 §0.2 对应行的「不满足则不得动工」条件逐条勾过
- [ ] 每个 PR 的描述里写明本文档对应小节的「完成判据」核对结果
- [ ] 所有「未真机验证」的路径/形状（D1 的 Spas header 拼写、D3 的 3.x 灰度全部、C 系遗留的 v3 命名空间/服务写端点）在合入时同步记入架构文档 §14 的追加节——**这个仓库的文档诚实度是产品特性**（路线图给「文档诚实度」单独打了分），任何一个「应该能用」都必须写成「未验证」
