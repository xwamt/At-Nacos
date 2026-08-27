# AT Nacos 后续 —— Phase A：把已有 Driver 接到 UI

> **For agentic workers:** TDD，checkbox，不要跳步。不要改 main。
**Depends on:** Phase 0 已合入（createConfig / filterServices / instance menus 等存在）。
**Non-goals:** 命名空间 CRUD、权重编辑、AK/SK、MCP 写工具、publishOnSave、用户权限。

---

## 0. 基线与全局约定

### 0.1 代码基线

本计划所有文件路径与**行号**均以 Phase 0 合入后的代码为准（分支 `cursor/nacos-opt-1-8-6a9b`，即「1–8 项优化」全部合入的状态）。开工前：

- [ ] `git fetch origin cursor/nacos-opt-1-8-6a9b`（或 Phase 0 已合入的 main 等价提交）。
- [ ] 从该基线新建工作分支（不要在 main 上工作，不要直接提交 main）。
- [ ] `npm install && npm test`，确认基线全绿（约 1980 个用例通过、33 个 live 用例 skip），记下确切的用例数（A1/A14 要用）。

> **审计记录（2026-08-27）**：本文全部文件路径、行号、硬编码计数、l10n 键与菜单 `when` 子句已逐条对照 `origin/cursor/nacos-opt-1-8-6a9b`（取文件用 `git show origin/cursor/nacos-opt-1-8-6a9b:<path>`，不 checkout）核验一遍。发现并已就地修正 3 处偏差：A1 的 devDependencies 行号（403-413 → 407-413）、A2 的历史面板列头行号（273 → 272）、A6 的 `opType` trim 位置（normalize.ts:149-159 → :268）。各 Task 头部的 ✅ 行记录了该任务核验到的关键锚点；未标注偏差的行号均与该基线一致。

### 0.2 TDD 工作流（每个 Task 一律如此）

1. 先写/改测试 → `npx vitest run <该测试文件>` 看它**红**。
2. 写最小实现 → 看它**绿**。
3. `npm run typecheck && npm test` 全量回归。
4. 一个 Task 一个 commit，commit message 带 Task 编号（如 `A4: retry on error tree node`）。

### 0.3 三个「计数型」测试的基线与递增

Phase A 新增 3 个命令（A4 `atNacos.retryLoad`、A7 `atNacos.showServiceDetail`、A8 `atNacos.findListenedConfigs`），会触碰以下硬编码计数。**按任务顺序执行时每一步的期望值**：

| 里程碑 | `package.json` `contributes.commands` 条数 | `ExtensionLifecycle.test.ts:36` 命令清单条数 | `ExtensionLifecycle.test.ts:90` `toHaveLength(N)` |
|---|---|---|---|
| 基线（Phase 0 后） | 27 | 27 | 36 |
| A4 完成后 | 28 | 28 | 37 |
| A7 完成后 | 29 | 29 | 38 |
| A8 完成后 | 30 | 30 | 39 |

`test/extension/ExtensionLifecycle.test.ts:82-94` 的注释 “the twenty-seven commands” 也要随之改写（最终 “the thirty commands”）。

其余相关约定（改动前先读一遍这三个测试文件）：

- `test/extension/Manifest.test.ts:56-66` —— 注册的命令必须与 `contributes.commands` 完全一致（自动兜底，新命令忘了注册/忘了 contribute 都会红）。
- `test/extension/Manifest.test.ts:204-208` `nodeMenu()` —— **每个命令在 `view/item/context` 中恰好 1 条**。给同一命令加第二条菜单会直接红。
- `test/extension/Manifest.test.ts:147-171` —— 一份 it.each 清单要求这些命令的 commandPalette `when` 恰为 `'false'`；`Manifest.test.ts:186-191` 还有一条“所有 commandPalette 条目 when 必须是 false”的兜底。A3 要给它开一个显式的例外口子，A4/A7 的新命令要加进 it.each 清单。
- `test/i18n/nls.test.ts:104-128` —— 会扫描 `src/**/*.ts` 里所有 `t('...')` 字面量并要求 `l10n/bundle.l10n.zh-cn.json` 有对应键。**所有新 `t()` 都必须用单引号字面量**（可以放在 switch/case 里，不要放在查表对象的值里——查表值扫不到，但因为该测试只查「代码里有 → bundle 里必须有」，查表值只是失去保护，不会红）。
- `test/i18n/nls.test.ts:48-55` —— 中文翻译必须保留英文源串的全部 `{placeholder}`。
- webview 端所有文案由扩展侧渲染（`buildWebviewStrings` / 服务端拼 HTML），页面脚本只发消息，见 `webview/nacos-consumers/index.ts` 的头注释。新面板保持这个分工。

### 0.4 复用清单（不要重造）

| 模式 | 位置 | 谁用 |
|---|---|---|
| 面板去重 + 关停 | `src/webview/openPanels.ts`（`openOrRevealPanel` / `panelKey` / `disposeOpenPanels`） | A6/A7/A8 |
| 面板骨架（头、节、note、errorNote、`settle`、`messageType`） | `src/webview/panelParts.ts` | A6/A7/A8 |
| 面板「先出壳再取数」+ refresh 整页重渲 | `src/webview/ClusterStatusPanel.ts:80-143` | A7/A8 |
| CSP + JSON 数据块 + 转义 | `src/webview/html.ts` | A7/A8/A13 |
| 每次 open/refresh 重建客户端（`connect` 回调） | `src/extension.ts:501-507`、`ConfigHistoryPanel.open` | A7/A8 |
| 加载遮罩 | `src/utils/notifications.ts` `withLoadingProgress` | A6/A8 |
| 写确认 | `src/write/confirmWrite.ts`（本阶段无新写路径，A6 回滚已有） | — |
| 树缓存：持有 in-flight Promise、失败自淘汰、身份校验 | `src/tree/NacosTreeBase.ts:59-171`、`src/tree/ConfigTreeProvider.ts:250-271` | A4 |
| 客户端池失败自淘汰 | `src/nacos/NacosClientPool.ts:48-55` | A4 |

### 0.5 建议执行顺序

A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9 → A10 → A11 → A12 → A13 → A14（即编号顺序）。A2 的重复键检测测试越早合入，越能保护后面所有改 bundle 的任务；A14 的覆盖率脚本是 A1 中 README 措辞的第二步。

---

## Task A1 — README 诚实性（P0）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：README 5 处原文引用逐字一致；`configLanguage.ts:5-32` 两表确无 TOML；`publishConfig.ts:59` 确为 `draft.baseContent !== serverContent` 全文比对、无 MD5；`test/docs/AtNacosMcpSkill.test.ts` 存在可作读盘样板。唯一修正：devDependencies 实际在 `package.json:407-413`（原写 403-413）。

### 现状（先读）

- `README.md`（全文 121 行）。
- 佐证代码：
  - `src/nacos/driver/configLanguage.ts:5-32` —— `LANGUAGE_BY_TYPE` / `LANGUAGE_BY_SUFFIX` 两张表**都没有 TOML**（yaml/yml/properties/conf/cfg/json/xml/html/htm/txt 而已）。且 `openConfigDocument` 走 `vscode.languages.setTextDocumentLanguage`，VS Code 无内置 `toml` 语言 id，硬加映射会在未装 TOML 扩展的机器上抛 “Unknown language id”，所以**删声明**而不是补映射。
  - `src/write/publishConfig.ts:47-65` —— 冲突检测是 `getConfig` 重拉**全文**后 `draft.baseContent !== serverContent` 的字符串比对，**没有任何 MD5 参与**。
  - `docs/plans/2026-08-13-at-nacos-architecture.md:511` —— “**2.x 相关条目已全部确认；1.x 与 3.x 仍未验证。**”
  - 仓库无任何覆盖率工具（`package.json:407-413` 的 devDependencies 里无 `@vitest/coverage-*`，`vitest.config.ts` 无 coverage 配置），“100% 覆盖率保证”无出处。
  - 用例数：README 写 1890，基线实测约 1980（0.3 步骤记下的数），数字随每次合并漂移，不应硬编码。

### 失实声明清单（原句 → 替换句）

| # | 位置 | 现在的原文（引用） | 替换为 |
|---|---|---|---|
| 1 | `README.md:14` | 「**跨版本全兼容**：全面支持 Nacos **1.x**、**2.x**、**3.x**（包括 3.x Admin API 与 Console API 自动降级与适配）。」 | 「**多版本兼容**：支持 Nacos **1.x**、**2.x** 与 **3.x**（3.x 走 Admin API 与 Console API 自动降级与适配）。其中 2.x 已在真实服务器上完整验证；1.x 与 3.x 的适配按官方 API 文档实现，仍在社区验证中，欢迎反馈。」 |
| 2 | `README.md:23` | 「**智能语言高亮**：根据 Data ID 后缀与内容智能识别 `YAML`、`Properties`、`JSON`、`XML`、`TOML`、`HTML` 等语法。」 | 「**智能语言高亮**：根据配置 `type` 与 Data ID 后缀识别 `YAML`、`Properties`、`JSON`、`XML`、`HTML` 与纯文本。」（删 TOML；顺带把「智能识别内容」这半句收敛成实际行为：type 优先、后缀兜底，见 `configLanguage.ts:36-57`） |
| 3 | `README.md:39` | 「**并发冲突检测**：发布时校验服务端 MD5，发现已被他人修改时提示冲突并提供合并比对。」 | 「**并发冲突检测**：发布前重新拉取服务端最新全文，与打开草稿时的基线全文比对；发现已被他人修改时给出覆盖警告，并在强制 Diff 预览中展示将被覆盖的内容。」 |
| 4 | `README.md:77` | 「`# 运行自动化测试 (1890 单元测试)`」 | 「`# 运行自动化测试`」（数字删掉——它每次合并都过期） |
| 5 | `README.md:115` | 「**自动化测试**：覆盖全量 Driver、Resolver、安全拦截、并发锁、MCP 协议等，包含 **1890** 单元测试与 100% 覆盖率保证。」 | 「**自动化测试**：覆盖 Driver、Resolver、安全拦截、并发控制、MCP 协议等核心路径；用例数量以 `npm test` 的输出为准。」（A14 落地覆盖率脚本后再补一句真实覆盖率，见 A14） |

### 步骤

- [ ] **新建测试** `test/docs/ReadmeHonesty.test.ts`（参考 `test/docs/AtNacosMcpSkill.test.ts` 的读盘方式，用 `readFileSync(resolve(process.cwd(), 'README.md'), 'utf8')`），断言：
  - `expect(readme).not.toContain('TOML')`；
  - `expect(readme).not.toMatch(/100% ?覆盖率|100% coverage/)`；
  - `expect(readme).not.toMatch(/\d{3,}\s*单元测试/)`（禁止硬编码用例数）；
  - `expect(readme).not.toContain('校验服务端 MD5')`；
  - `expect(readme).toContain('社区验证中')`（3.x 状态句必须在）。
- [ ] 跑红。
- [ ] 按上表逐条改 `README.md`。
- [ ] 跑绿；`npm test` 全量回归（`AtNacosMcpSkill.test.ts` 等文档测试不受影响，确认一下）。

### 坑

- 不要顺手改 `CHANGELOG.md:29` 里 v0.1.2 的「1890 个测试用例」——那是**当时**的历史记录，是真的，不许篡改历史条目。
- `README.md:47-60` 的 13 个 MCP 工具清单与 `src/mcp/toolCatalog.ts` 一致（Phase 0 已勘误过），不在本任务范围。

### Done when

- [ ] `test/docs/ReadmeHonesty.test.ts` 绿。
- [ ] README 不再声称：TOML 高亮、MD5 校验、100% 覆盖率、硬编码用例数、3.x「全面支持」。
- [ ] `npm test` 全绿。

---

## Task A2 — l10n 重复键（P0）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：bundle 重复键行号 96/120（Version）、46/177（Delete）与 `"Versions"`（:119）一致；`ClusterStatusPanel.ts:239` 一致；`t('Delete')` 调用点 `extension.ts:1111`、`:1178` 一致。唯一修正：历史面板列头 `t('Version')` 实际在 `ConfigHistoryPanel.ts:272`（原写 273，272 是 `<th>` 行、273 是相邻的 `t('Operation')` 列头）。

### 现状（先读）

`l10n/bundle.l10n.zh-cn.json` 里有两个 JSON 重复键（`JSON.parse` 静默保留**最后**一个）：

| 键 | 出现位置 | 值 | 生效者 | 后果 |
|---|---|---|---|---|
| `"Version"` | `bundle.l10n.zh-cn.json:96` | `"版本"`（集群节点表列头本意） | 被覆盖 | 集群状态面板节点表的「版本」列（`src/webview/ClusterStatusPanel.ts:239`）实际显示成「**版本号**」 |
| `"Version"` | `bundle.l10n.zh-cn.json:120` | `"版本号"`（历史版本表列头本意，`src/webview/ConfigHistoryPanel.ts:272`） | ✅ 生效 | |
| `"Delete"` | `bundle.l10n.zh-cn.json:46` 与 `:177` | 都是 `"删除"` | 后者 | 无可见后果，但重复键本身就是隐患 |

**为什么不能只改 JSON 键名**：`t()` 的键就是英文源串本身（`src/i18n/t.ts:18-20` 直转 `vscode.l10n.t`）。想让两处 UI 得到不同中文，必须让**代码里的英文源串**先分叉，bundle 键跟着分叉。

### 方案

两个 `t('Version')` 调用点改成语义化的英文源：

| 调用点 | 现在 | 改为 | 中文 |
|---|---|---|---|
| `src/webview/ClusterStatusPanel.ts:239`（集群节点表列头，值是节点的 Nacos 版本如 `2.3.2`） | `t('Version')` | `t('Nacos version')` | `"Nacos version": "版本"` |
| `src/webview/ConfigHistoryPanel.ts:272`（历史表列头，值是历史记录 nid） | `t('Version')` | `t('Config version')` | `"Config version": "版本号"` |

然后从 bundle **删掉两行** `"Version"`（96、120），**删掉一行**重复的 `"Delete"`（保留一处即可，`t('Delete')` 的调用点在 `src/extension.ts:1111`、`src/extension.ts:1178`，翻译都是「删除」）。注意 `"Versions"`（`:119`，历史面板的节标题「版本」）是另一个键，**不动**。

### 步骤

- [ ] **先写重复键检测测试**：在 `test/i18n/nls.test.ts` 新增一个 describe（放在文件顶部工具函数之后）。`JSON.parse` 探测不到重复键，需要一个手写 top-level 键扫描器：

```ts
/**
 * 一个扁平 JSON 对象文件里的全部顶层键，按出现顺序、含重复。
 * JSON.parse 会静默丢弃重复键并保留最后一个 —— 集群面板的「版本」列
 * 就是这样被历史面板的「版本号」覆盖的，所以这里自己走一遍字符流。
 */
function topLevelJsonKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === '\\' ? 2 : 1;
      }
      const raw = text.slice(start, index + 1);
      index += 1;
      // 字符串后的第一个非空白是冒号 → 它是键；深度 1 → 顶层键。
      let peek = index;
      while (peek < text.length && /\s/.test(text[peek] as string)) {
        peek += 1;
      }
      if (depth === 1 && text[peek] === ':') {
        keys.push(JSON.parse(raw) as string);
      }
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
    }
    index += 1;
  }
  return keys;
}

describe('l10n JSON files', () => {
  // 扫描器自检：JSON.parse 看不出的重复、转义引号、嵌套里的同名键。
  it('the scanner sees duplicates, escapes and nesting', () => {
    expect(topLevelJsonKeys('{"a": "x", "a": "y"}')).toEqual(['a', 'a']);
    expect(topLevelJsonKeys('{"a": {"a": 1}, "b\\"c": ":"}')).toEqual(['a', 'b"c']);
  });

  it.each(['l10n/bundle.l10n.zh-cn.json', 'package.nls.json', 'package.nls.zh-cn.json'])(
    'declares every key at most once in %s',
    (path) => {
      const keys = topLevelJsonKeys(readFileSync(resolve(process.cwd(), path), 'utf8'));
      const seen = new Set<string>();
      const duplicated = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
      expect(duplicated).toEqual([]);
    }
  );
});
```

  （不要引入 `json5` 依赖——手写扫描器 30 行，零依赖，且能自检。）
- [ ] 跑红：`bundle.l10n.zh-cn.json` 报 `['Version', 'Delete']`。
- [ ] 改 `src/webview/ClusterStatusPanel.ts:239` → `t('Nacos version')`。
- [ ] 改 `src/webview/ConfigHistoryPanel.ts:272` → `t('Config version')`。
- [ ] `l10n/bundle.l10n.zh-cn.json`：删两行 `"Version"`，删一行 `"Delete"`（保留一行），新增 `"Nacos version": "版本"` 与 `"Config version": "版本号"`。
- [ ] 同步已有面板测试：`test/webview/ClusterStatusPanel.test.ts` / `test/webview/ConfigHistoryPanel.test.ts` 若有对 `Version` 文本的断言，改成新源串（fixture 的 `l10n.t` 原样回显英文源）。
- [ ] 跑绿 + 全量回归（`nls.test.ts:124-128` 会自动确认两个新键有中文）。

### Done when

- [ ] 重复键检测对三个 JSON 文件全绿，且扫描器自检用例在。
- [ ] 集群面板列头翻译为「版本」、历史面板列头为「版本号」（分别断言在两个面板测试里）。
- [ ] 全量测试绿。

---

## Task A3 — `publishConfig` 命令面板（P0）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：palette 条目 `package.json:217-220`（`"when": "false"` 在 :219）、editor/title `:242-248`（`resourceScheme == nacos-draft` 在 :245）、无参路径 `extension.ts:760-804`、it.each 数组 `Manifest.test.ts:147-163`（含 `['atNacos.publishConfig']`）全部一致。兜底测试实际在 `:187-192`（注释在 :186），标题为 `writes no commandPalette entry that leaves a command visible`。

### 现状（先读）

- `package.json:217-220`：`commandPalette` 里 `atNacos.publishConfig` 的 `when` 是 `"false"`。
- `src/extension.ts:760-804`：**无参路径已实现**——不带 tree item 调用时，从 `vscode.window.activeTextEditor?.document.uri` 用 `parseDraftUri` 解析出 `instanceId` + `ref`（`src/document/draftUri.ts`，scheme 常量 `NACOS_DRAFT_SCHEME = 'nacos-draft'`）。
- `package.json:242-248`：`editor/title` 已经用 `resourceScheme == nacos-draft` 挂了同一命令，措辞可直接复用。
- 挡路的测试有两处：
  - `test/extension/Manifest.test.ts:147-171`：it.each 清单包含 `['atNacos.publishConfig']`，要求它的 palette `when` 恰为 `['false']`。
  - `test/extension/Manifest.test.ts:186-191`：兜底遍历「所有 commandPalette 条目 when 必须是 `'false'`」。**必须改造这条测试**，为本例外开一个显式白名单。

### 步骤

- [ ] **先改测试** `test/extension/Manifest.test.ts`：
  - 从 `:147-163` 的 it.each 数组删掉 `['atNacos.publishConfig']`。
  - 新增专项测试（放在原 it.each 之后），与 draft scheme 常量绑死防漂移：

```ts
import { NACOS_DRAFT_SCHEME } from '../../src/document/draftUri';

/**
 * publishConfig 是唯一一个活动编辑器就能补全参数的命令：草稿 tab 打开着，
 * 恰好就是「发布」有意义的时刻。palette 只在这时露出它。
 */
it('offers publishConfig in the palette only while a draft editor is active', () => {
  expect(
    (menus.commandPalette ?? [])
      .filter((item) => item.command === 'atNacos.publishConfig')
      .map((item) => item.when)
  ).toEqual([`resourceScheme == ${NACOS_DRAFT_SCHEME}`]);
});
```

  - 改写 `:186-191` 的兜底测试为白名单式：

```ts
/** palette 里可见的命令必须能自己找齐参数；目前只有 publishConfig 能（活动的草稿编辑器）。 */
const PALETTE_VISIBLE_WHEN: ReadonlyMap<string, string> = new Map([
  ['atNacos.publishConfig', `resourceScheme == ${NACOS_DRAFT_SCHEME}`]
]);

it('leaves no commandPalette entry visible unless its arguments can be recovered', () => {
  for (const item of menus.commandPalette ?? []) {
    expect(item.when, item.command).toBe(PALETTE_VISIBLE_WHEN.get(item.command) ?? 'false');
  }
});
```

- [ ] 跑红（package.json 还是 false）。
- [ ] 改 `package.json:219`：`"when": "false"` → `"when": "resourceScheme == nacos-draft"`。
- [ ] **确认功能测试存在**：`test/extension/WriteCommands.test.ts` 里应已有「无参调用 publishConfig 从 activeTextEditor 的 draft URI 解析目标」的用例（Phase 0 的「Ctrl+S 不发布」批次加的）；若没有，补一个——设置 fixture 的 `activeTextEditor` 为 `buildDraftUri(...)` 文档、`run('atNacos.publishConfig')`、断言 `publishConfig` 收到了解析出的 `instance`/`ref`；再补一个「活动编辑器不是草稿时静默 return、不弹错误」。
- [ ] 跑绿 + 全量回归。

### 坑

- `when` 里写 scheme 字面量 `nacos-draft`（package.json 不能引用 TS 常量）；漂移防护靠上面绑常量的测试。
- 不要动 `editor/title` 那条（已正确）；`nodeMenu()` 只查 `view/item/context`，palette 改动不影响它。

### Done when

- [ ] palette 在打开 `nacos-draft:` 草稿 tab 时出现「AT Nacos: 发布配置」，其他时刻不出现（手测一次）。
- [ ] Manifest 白名单测试 + 专项测试绿，全量绿。

---

## Task A4 — 错误节点「重试」（P0）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`ErrorTreeItem` `NacosTreeItems.ts:441-462`；四个产地 `NacosTreeBase.ts:115`/`:135`、`ConfigTreeProvider.ts:213`/`:229`、`ServiceTreeProvider.ts:221`/`:237`/`:251`；`errorNode` 私有方法 `ConfigTreeProvider.ts:243-244`、`ServiceTreeProvider.ts:265-266`；缓存自淘汰 `NacosTreeBase.ts:165-169`、`ConfigTreeProvider.ts:265-269`；池自淘汰 `NacosClientPool.ts:48-55`；`extension.ts:181-189` 注释、Refresh `:369-376`、emitter `NacosTreeBase.ts:56`（protected）——全部一致。Lifecycle 排序清单在 `:36-64`（27 条、字母序），`retryLoad` 的插入位置与字母序吻合。

### 现状（先读）

- `src/tree/NacosTreeItems.ts:441-462`：`ErrorTreeItem` 有 `contextValue = 'atNacos.error'` 和 `ownerId`（只进了 `this.id`，**没有保留为字段**，也没保留父元素引用）。
- 错误节点的四个产地：
  - 根级：`src/tree/NacosTreeBase.ts:115`（`listInstances` 抛错，无 owner）。
  - 实例级：`src/tree/NacosTreeBase.ts:135`（`loadNamespaces` 失败，owner 应是那个 `InstanceTreeItem`——但 `getChildren:88-91` 把 `element.instance` 拆出来传给了 `getInstanceChildren`，元素本身丢了）。
  - 命名空间/分组级：`src/tree/ConfigTreeProvider.ts:213/229`、服务侧 `src/tree/ServiceTreeProvider.ts:221/237/251`（owner 是 Namespace/Group/Service 元素）。
- **关键事实——重试不需要清任何缓存、更不能清池**：
  - `NacosTreeBase.ts:165-169`：namespaceCache 里失败的 Promise 会**自淘汰**（带身份校验）。
  - `ConfigTreeProvider.ts:265-269` / ServiceTreeProvider 同款：pageCache 失败自淘汰。
  - `NacosClientPool.ts:48-55`：工厂失败的 clientPromise 自淘汰；成功缓存的客户端刚被证明可用，清掉纯属浪费一次 login + probe（`src/extension.ts:181-189` 的注释说的就是这个）。
  - 所以「重试」= **对 owner 元素 fire 一次 change**，VS Code 会重新 `getChildren(owner)`，缓存已空自然重取。
- 现状用户只能点视图标题 Refresh（`extension.ts:369-376`），那会 `clientPool.clear()` + 整树重绘、收起全部展开节点——正是要避免的。

### 步骤

- [ ] **测试先行 ①** `test/tree/ConfigTreeProvider.test.ts` 新增用例（沿用该文件现有 fake client 工厂写法）：
  - 「listConfigs 第一次拒绝、第二次成功：第一次 `getChildren(namespace)` 返回 1 个 `ErrorTreeItem`，其 `owner === namespace元素` 且 `scope === 'config'`」。
  - 「`provider.retry(errorItem)`：`onDidChangeTreeData` 监听器恰好收到一次、参数是 owner 元素（不是 undefined）；随后 `getChildren(namespace)` 成功返回分组」。
  - 「实例级失败（listNamespaces 拒绝）：错误节点 `owner` 是 `InstanceTreeItem`；`retry` 后只触发一次带该元素的 change」。
  - 「根级失败（listInstances 抛）：`owner === undefined`；`retry` fire(undefined) 整树重绘」。
- [ ] **测试先行 ②** `test/extension/ExtensionLifecycle.test.ts`：
  - `:36-64` 排序清单插入 `'atNacos.retryLoad'`（排在 `'atNacos.refreshServices'` 之后、`'atNacos.showConfigHistory'` 之前）。
  - `:90` 改 `toHaveLength(37)`，`:84` 注释改 “the twenty-eight commands”。
- [ ] **测试先行 ③** `test/extension/Manifest.test.ts`：
  - `:147-163` it.each 加 `['atNacos.retryLoad']`（palette when false）。
  - 新增节点菜单测试：

```ts
it('offers retry inline on an error node and nowhere else', () => {
  const item = nodeMenu('atNacos.retryLoad');
  expect(item.when).toBe('viewItem == atNacos.error');
  expect(item.group).toBe('inline');
  expect(new ErrorTreeItem('config', 'boom').contextValue).toBe('atNacos.error');
  expect(configNodeValue(false)).not.toBe('atNacos.error');
});
```

  （`ErrorTreeItem` 需要加进该文件的 import。注意 `nodeMenu` 的 `contextValuePattern` 只适用于 `=~` 形式，这里是 `==`，直接字符串断言。）
- [ ] 跑红。
- [ ] **实现 ① `src/tree/NacosTreeItems.ts`**：`ErrorTreeItem` 构造器改为

```ts
constructor(
  readonly scope: NacosTreeScope,
  message: string,
  ownerId?: string,
  /**
   * 渲染出这个错误的那个父元素。重试用它对着单个子树 fire change：
   * 失败的缓存条目都会自淘汰（namespaceCache、pageCache、client pool 皆然），
   * 所以重取只差一次「重新问 owner 要孩子」。根级失败没有 owner，fire(undefined)。
   */
  readonly owner?: NacosTreeItem
) { ... }
```

  （`scope` 从构造参数升级为 `readonly` 字段，extension.ts 靠它路由到正确的 provider。）
- [ ] **实现 ② `src/tree/NacosTreeBase.ts`**：
  - `getChildren`（:84-92）把整个 `element` 传下去：`getInstanceChildren(element)`；`getInstanceChildren` 改签名 `(element: InstanceTreeItem)`，内部用 `element.instance`，`:135` 改为 `new ErrorTreeItem(this.scope, formatError(error), instance.id, element)`。
  - 新增公共方法：

```ts
/**
 * 重试一个错误节点：只对它的 owner fire change。
 * 不清 namespaceCache（失败条目已自淘汰），不动 client pool（失败的
 * clientPromise 已自淘汰、成功的客户端刚被证明可用）。fire(undefined)
 * 只发生在根级错误 —— 那本来就是整树。
 */
retry(item: ErrorTreeItem): void {
  this.onDidChangeTreeDataEmitter.fire(item.owner);
}
```

- [ ] **实现 ③** `src/tree/ConfigTreeProvider.ts:207-245`、`src/tree/ServiceTreeProvider.ts` 对应位置：`errorNode(error, ownerId, owner)` 增加第三参并传 `element`。
- [ ] **实现 ④ `src/extension.ts`**：在 `clearServiceFilterCommand` 之后注册：

```ts
// 重试只重绘失败的那一个子树。视图标题的 Refresh 才是「推倒重来」：
// 清池、整树 —— 强迫用户为一个命名空间的失败付出整棵树折叠的代价，
// 正是这个命令要移除的。
const retryLoadCommand = vscode.commands.registerCommand('atNacos.retryLoad', (item: ErrorTreeItem) => {
  if (!(item instanceof ErrorTreeItem)) {
    return;
  }
  (item.scope === 'config' ? configTreeProvider : serviceTreeProvider).retry(item);
});
```

  import `ErrorTreeItem`（改成值导入），并把 `retryLoadCommand` push 进 `context.subscriptions`（:999-1040 清单里、`clearServiceFilterCommand` 后面）。
- [ ] **实现 ⑤ `package.json`**：
  - `commands` 加：

```json
{
  "command": "atNacos.retryLoad",
  "title": "%atNacos.command.retryLoad.title%",
  "icon": "$(refresh)"
}
```

  - `menus.commandPalette` 加 `{ "command": "atNacos.retryLoad", "when": "false" }`。
  - `menus["view/item/context"]` 加（inline 让刷新图标直接出现在错误节点行内）：

```json
{
  "command": "atNacos.retryLoad",
  "when": "viewItem == atNacos.error",
  "group": "inline"
}
```

  - `package.nls.json` 加 `"atNacos.command.retryLoad.title": "AT Nacos: Retry Load"`；`package.nls.zh-cn.json` 加 `"atNacos.command.retryLoad.title": "AT Nacos: 重试加载"`。
- [ ] 跑绿 + 全量回归。

### 坑

- **不要**在 retry 里调用 `provider.refresh()`（清全部缓存 + fire(undefined) = 折叠整棵树），也不要 `clientPool.evict/clear`。
- `onDidChangeTreeDataEmitter` 是 `protected`（`NacosTreeBase.ts:56`），`retry` 放在基类里正好；不要把 emitter 改 public。
- fire(element) 要求传**同一个元素对象**——所以必须保存 owner 引用，不能事后 new 一个同 id 的元素。
- 两个失败并存（namespace 与其 group）时是两个错误节点、两个不同 `ownerId`（`ConfigTreeProvider.ts:237-245` 注释），owner 也各自不同，互不影响。

### Done when

- [ ] 错误节点行内出现刷新图标；点击后仅该子树 loading 并恢复，其他实例展开状态不变（手测：错误期间展开另一实例，重试后它不收起）。
- [ ] 上述新旧测试与三个计数测试全部绿（37/28/28）。

---

## Task A5 — 连接测试失败中文化（P0）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：七值枚举 `testNacosConnection.ts:69-83`、结构 `:98-106`、「Localizing them is the caller's job」头注释 `:115-123`、`describeConnectionFailure :308+`、config-reason 来源（`case 'validation'` → `reason: 'config'`）`:353-358`、失败分支 `NacosInstanceFormPanel.ts:356-372`、`describeSuccess :375-402`、catch 分支 `:289-297`、nls 单引号正则 `nls.test.ts:74`——全部一致。坑 3 的落点：`webview/nacos-instance-form/index.ts:153` 是 `testStatus.textContent = message` 赋值行。

### 现状（先读）

- `src/nacos/testNacosConnection.ts:69-83`：`NacosConnectionFailureReason` 七值枚举 `'auth' | 'gateway' | 'network' | 'tls' | 'address' | 'config' | 'error'`；`:98-106` `NacosConnectionTestFailure` 结构化字段齐全（`reason`/`kind`/`status`/`triedBaseUrls`/`message`）。`:115-123` 头注释明说：**Messages come back in English…Localizing them is the caller's job**。
- `src/webview/NacosInstanceFormPanel.ts:356-372`：失败分支直接 `{ ok: false, message: result.message }`，旁边注释说明了英文原因并指路「用结构化字段重建」——本任务就是把那条注释兑现。
- 成功分支已中文化（`describeSuccess`，:375-402，switch + `t()` 字面量的样板，照抄结构）。

### 设计

在 `NacosInstanceFormPanel.ts` 内新增（不动 `testNacosConnection.ts`——它的英文 prose 继续服务日志和附录）：

```ts
import type { NacosConnectionTestFailure } from '../nacos/testNacosConnection';

/**
 * 失败结果的用户可读形态：按 reason 套本地化模板指出「该改哪一项」，
 * 服务端拼装出来的英文原文降级为附录 —— 那些句子由地址、状态码和服务器
 * 自己的话拼成，没有可作翻译键的固定源串，但它们是排障时最有用的细节。
 */
function describeFailure(result: NacosConnectionTestFailure): string {
  return `${describeFailureReason(result.reason)}\n${t('Details: {message}', { message: result.message })}`;
}

function describeFailureReason(reason: NacosConnectionTestFailure['reason']): string {
  switch (reason) {
    case 'auth':
      return t('Nacos rejected the credentials this form is holding. Check the authentication mode and the fields it needs.');
    case 'gateway':
      return t('A proxy or gateway in front of Nacos rejected the request. Send its credential with the "Custom headers" mode, or fix the proxy configuration.');
    case 'network':
      return t('The server could not be reached. Check the host and port, whether Nacos is running, and any firewall, proxy or VPN in between.');
    case 'tls':
      return t("The server's TLS certificate was not accepted. Trust it when AT Nacos asks, install the CA that issued it, or use http:// if this server does not serve TLS.");
    case 'address':
      return t('No Nacos API answered at this address. Check the server URL and its context path, which is usually /nacos.');
    case 'config':
      return t('A setting in this form does not match how the server is deployed. The details below say which.');
    case 'error':
      return t('Nacos, or the proxy in front of it, failed on its own. Check the Nacos server log.');
  }
}
```

（switch 全覆盖、无 default：枚举将来加值时 TS 编译期就红。注意 tls 句里的撇号——TS 源里用双引号字符串会逃过 `nls.test.ts:74` 的单引号正则！**必须写成单引号 + `\'` 转义**：`t('The server\'s TLS certificate ...')`，bundle 键则是未转义形态。）

`probeWithFormValues`（:356-372）失败分支改为：

```ts
: { ok: false, message: describeFailure(result) };
```

注意 `:289-297` 还有一个 catch 分支（seam 抛异常/读存储凭据失败），它拿不到结构化结果，维持 `formatError(error)` 原样。

### 文案（加进 `l10n/bundle.l10n.zh-cn.json`）

| 英文源（= bundle 键） | 中文 |
|---|---|
| `Nacos rejected the credentials this form is holding. Check the authentication mode and the fields it needs.` | `Nacos 拒绝了表单中的凭据。请检查认证方式及其所需的字段。` |
| `A proxy or gateway in front of Nacos rejected the request. Send its credential with the "Custom headers" mode, or fix the proxy configuration.` | `Nacos 前面的代理或网关拒绝了请求。请用「自定义请求头」模式携带代理凭据，或修正代理配置。` |
| `The server could not be reached. Check the host and port, whether Nacos is running, and any firewall, proxy or VPN in between.` | `无法连接到服务器。请检查主机与端口、Nacos 是否正在运行，以及两者之间的防火墙、代理或 VPN。` |
| `The server's TLS certificate was not accepted. Trust it when AT Nacos asks, install the CA that issued it, or use http:// if this server does not serve TLS.` | `服务器的 TLS 证书未被接受。可以在 AT Nacos 询问时信任该证书、安装签发它的 CA，或在该服务器不提供 TLS 时改用 http://。` |
| `No Nacos API answered at this address. Check the server URL and its context path, which is usually /nacos.` | `该地址上没有 Nacos API 应答。请检查服务端地址及其上下文路径（通常是 /nacos）。` |
| `A setting in this form does not match how the server is deployed. The details below say which.` | `表单中的某项设置与服务器的部署方式不匹配，具体见下方详细信息。` |
| `Nacos, or the proxy in front of it, failed on its own. Check the Nacos server log.` | `Nacos 或它前面的代理自身出错了。请查看 Nacos 服务端日志。` |
| `Details: {message}` | `详细信息（英文原文）：{message}` |

### 步骤

- [ ] **测试先行** `test/webview/NacosInstanceFormPanel.test.ts`（该文件已有注入 `options.testConnection` seam + fake panel 收集 `postMessage` 的用法，照抄）：用 `it.each` 覆盖七个 reason——seam 返回 `{ ok: false, message: 'Nacos answered at http://x but refused the request with HTTP 403. ...', reason: 'auth', kind: 'forbidden', status: 403, triedBaseUrls: ['http://x/nacos'] }` 之类；断言 posted 的 `connectionTestResult.payload.message`：
  - 以对应 reason 模板开头（fixture 的 `l10n.t` 回显英文源，直接比对英文源串）；
  - 包含英文原文（`toContain('HTTP 403')`）；
  - 换行分隔（`toContain('\n')`）。
  - 再加一条：seam **抛异常**时 message 是 `formatError` 原文（catch 分支不套模板）。
- [ ] 跑红。
- [ ] 按上面设计实现；旧的「英文，且留着」注释（:367-371）删掉或改写成指向 `describeFailure`。
- [ ] bundle 加 8 个键；跑绿（`nls.test.ts` 自动校验齐全 + placeholder）。
- [ ] 全量回归。

### 坑

- `testNacosConnection.ts` 的 `describeConnectionFailure`（:308-378）**不要改**——`test/nacos/testNacosConnection.test.ts` 断言那些英文句子，且它们现在成了附录内容。
- reason=`'config'` 的英文原文（OIDC 拒绝 userPassword 之类，:353-358）本身就是「唯一可操作信息」，所以 config 模板一定要把用户往附录上引。
- webview 页面渲染 message 时是纯文本插入；确认 `webview/nacos-instance-form/index.ts` 对 `\n` 的展示（如果是 `textContent` 单行，把 testStatus 元素 CSS 加 `white-space: pre-line`，改 `webview/nacos-instance-form/index.css`）。

### Done when

- [ ] 中文 UI 下连接测试失败显示「中文诊断 + 英文附录」两段；七种 reason 各有专属句子。
- [ ] 新用例 + `nls.test.ts` + 既有 `testNacosConnection.test.ts` 全绿。

---

## Task A6 — 历史翻页 + 任意两版本互比（P0）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`HISTORY_PAGE_SIZE` `:23`、「One page, deliberately」注释 `:14-22`、`loadConfigHistory :179-190`（`pageNo: 1` 在 :185）、`shownVersions` 选项 `:63`（安全阀消费点 `:155`/`:164`）、消息处理 `:144-172`、`renderVersionSection :235`、表头 `<thead>` `:270-278`（现 5 个有字 `<th>` + 1 个空 `<th>`，共 6 列）、`renderVersion :286`、`buildConfigHistoryUri` `configUri.ts:102-108`、`openConfigVersionDiff` `diffConfig.ts:51-65`、页面脚本刷新按钮 `webview/nacos-config-history/index.ts:44`、事件委托 `:61-82`、`mergePage` `ConfigTreeProvider.ts:312`（去重注释 `:300-311`，调用点 `:294`）、`Load more`/`Loading...` bundle `:69`/`:91`——全部一致。唯一修正：opType trim 的位置（见「坑」）。

### 现状（先读）

- `src/webview/ConfigHistoryPanel.ts:23` `HISTORY_PAGE_SIZE = 100`；`:179-190` `loadConfigHistory` 写死 `pageNo: 1`，一页封顶。`:14-22` 注释解释了「一页、无 Load more」的旧决策——本任务推翻它的后半（补翻页），保留「历史端点服务端钳制 500」的事实。
- Driver 已支持翻页：`src/nacos/driver/NacosDriver.ts:121-125` `NacosConfigHistoryListQuery { pageNo, pageSize }`；`src/nacos/NacosClient.ts:157-159`。
- 安全阀：`ConfigHistoryPanel.ts:56-63` `shownVersions()` ——**页面发来的任何 id 只有出现在当前已渲染条目里才被受理**（id 会变成发往服务器的 `nid`）。翻页后 `shown` 必须包含所有已加载页；两版本互比也必须走它。
- 互比的 URI 基建已在：`src/document/configUri.ts:102-108` `buildConfigHistoryUri(instanceId, ref, nid)`——query 携带 `nid`，两个不同 nid 就是两个不同虚拟文档；`src/document/diffConfig.ts:51-65` 是单边历史 vs 当前的样板。
- 页面脚本 `webview/nacos-config-history/index.ts:61-82`：事件委托 + 只传 id 的既有安全模式，扩展它。
- 消息处理 `ConfigHistoryPanel.ts:144-172`：`refresh` / `rollback` / `diff` 三类，新增 `loadMore` 与 `diffPair`。

### 设计

**扩展侧状态**（`ConfigHistoryPanel.open` 内，替代现在的 `let shown`）：

```ts
// 已加载的全部页，去重合并。页面能问到的版本永远 ⊆ 这里 —— shownVersions()
// 的安全承诺（页面发的 id 会变成发给服务器的 nid）在翻页后依然成立。
let shown: NacosConfigHistoryEntry[] = [];
let pagesLoaded = 0;
let totalCount = 0;
```

- `loadConfigHistory(connect, ref, pageNo)`：加第三参，内部 `client.listConfigHistory({ ...ref, pageNo, pageSize: HISTORY_PAGE_SIZE })`，返回单页 `{ entries, totalCount }`。
- `messageOptions.load()`：重置为第 1 页（refresh 语义 = 从头再来）。
- 新增 `messageOptions.loadMore()`：取 `pagesLoaded + 1` 页，**按 `entry.id` 去重后 append**（两页之间有人发布会移动行，同一 nid 到两次——照抄 `ConfigTreeProvider.ts:300-323` `mergePage` 的注释与手法），更新 `pagesLoaded`/`totalCount`，返回完整快照。
- `ConfigHistorySnapshot` 不变（`entries` 就是累计条目）；`renderVersionSection`（:235-266）当 `totalCount > entries.length` 时，把现有的 note 与一个按钮一起渲染：

```ts
parts.push(
  note(t('Showing the {shown} most recent of {total} versions.', { shown: ..., total: ... })),
  `<button id="loadMoreButton" class="secondary-action" type="button">${escapeAttr(t('Load more'))}</button>`
);
```

  （`'Load more'`/`'Loading...'` 两键 bundle 已有：`bundle.l10n.zh-cn.json:69/91`，直接复用。）
- **两版本互比**：`renderVersion`（:286-308）每行加一个复选框：

```html
<td class="version-pick-cell"><input type="checkbox" class="version-pick" data-version-id="${escapeAttr(entry.id)}" aria-label="..."></td>
```

  表头（:269-283）补一个空 `<th></th>`（列数从 6 → 7）。头部（`renderVersionSection` 表格上方）渲染一个禁用按钮 + 提示：

```html
<div class="compare-bar">
  <button id="comparePairButton" class="secondary-action" type="button" disabled>${escapeAttr(t('Compare selected versions'))}</button>
  <span class="section-note">${escapeAttr(t('Pick two versions to compare them with each other.'))}</span>
</div>
```

- **页面脚本** `webview/nacos-config-history/index.ts`：
  - `#loadMoreButton` click → 置 disabled、文本换 `strings.loadingMore` → `postMessage({ type: 'loadMore' })`（整页重渲，无需恢复）。
  - 复选框 `change`（document 级委托）→ 统计 `.version-pick:checked` 数量，`comparePairButton.disabled = count !== 2`。
  - `#comparePairButton` click → 取两个勾选 id，`postMessage({ type: 'diffPair', ids: [a, b] })`。
  - `ConfigHistoryStrings` 加 `loadingMore` 字段；扩展侧 `buildWebviewStrings({ refresh: 'Refresh', refreshing: 'Refreshing...', loadingMore: 'Loading...' })`。
- **消息处理** `handleConfigHistoryMessage`：

```ts
if (type === 'loadMore') {
  panel.webview.html = options.renderDocument(await configHistoryLoadMoreView(options));
  return true;
}
if (type === 'diffPair') {
  const ids = pairIds(message); // {ids?: unknown} → 恰好两个非空且不相同的 string，否则 undefined
  const shown = options.shownVersions();
  const first = shown.find((entry) => entry.id === ids?.[0]);
  const second = shown.find((entry) => entry.id === ids?.[1]);
  if (first && second && options.openPairDiff) {
    // 列表新→旧：数组下标大的在前（older 在 diff 左侧，left-is-original）。
    const [newer, older] = shown.indexOf(first) < shown.indexOf(second) ? [first, second] : [second, first];
    await options.openPairDiff(older, newer).catch(() => undefined);
  }
  return true;
}
```

  `ConfigHistoryMessageOptions` 加 `loadMore: () => Promise<ConfigHistorySnapshot>` 与 `openPairDiff: (older, newer) => Promise<void>`。面板消息类型自此为五种：`'refresh' | 'rollback' | 'diff' | 'loadMore' | 'diffPair'`（类型判别一律走 `panelParts.ts` 的 `messageType()`）。`pairIds` 是新的本文件私有校验函数——页面消息不可信，形状不对一律回 `undefined`：

```ts
/** 恰好两个非空且互不相同的 string 才透传；其余形状（缺、非数组、长度不对、非 string、相同）一律 undefined。 */
function pairIds(message: unknown): [string, string] | undefined {
  const ids = (message as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.length !== 2) {
    return undefined;
  }
  const [first, second] = ids;
  if (typeof first !== 'string' || typeof second !== 'string' || first === '' || second === '' || first === second) {
    return undefined;
  }
  return [first, second];
}
```
- **diff 打开**（`src/document/diffConfig.ts`，跟在 `openConfigVersionDiff` 后）：

```ts
/** 两个历史版本互比：两侧都是带 nid 的 nacos: 地址，都由文档 provider 只读供给。 */
export async function openConfigHistoryPairDiff(
  instanceId: string,
  ref: NacosConfigRef,
  older: NacosConfigHistoryEntry,
  newer: NacosConfigHistoryEntry
): Promise<void> {
  await vscode.commands.executeCommand(
    'vscode.diff',
    buildConfigHistoryUri(instanceId, ref, older.id),
    buildConfigHistoryUri(instanceId, ref, newer.id),
    t('{dataId}: version {source} compared with version {target}', {
      dataId: ref.dataId,
      source: historyVersionLabel(older),
      target: historyVersionLabel(newer)
    })
  );
}
```

- **接线** `src/extension.ts:564-613` `showConfigHistoryCommand`：`ConfigHistoryPanel.open` 的 options 加

```ts
openPairDiff: (older, newer) =>
  reportDiffFailure(item.config.dataId, 'showConfigHistory', () =>
    openConfigHistoryPairDiff(item.instance.id, item.config, older, newer)
  ),
```

  （复用 `reportDiffFailure` :541-554 的加载遮罩与错误上报。）

### 文案

| 英文源 | 中文 |
|---|---|
| `Compare selected versions` | `对比选中的版本` |
| `Pick two versions to compare them with each other.` | `勾选两个版本即可互相对比。` |
| `{dataId}: version {source} compared with version {target}` | `{dataId}：版本 {source} 与版本 {target} 对比` |

（`Load more`、`Loading...`、`Showing the {shown} most recent of {total} versions.` 已在 bundle。）

### 步骤

- [ ] **测试先行 ①** `test/webview/ConfigHistoryPanel.test.ts`：
  - `loadConfigHistory(connect, ref, 3)` 把 `pageNo: 3` 传到 `listConfigHistory`。
  - `handleConfigHistoryMessage({type:'loadMore'})`：fake `loadMore` 返回两页合并的快照，重渲的 html 同时含两页的版本 id；`shownVersions()` 覆盖两页。
  - 去重：第二页含第一页已有 id 时不重复渲染（html 中该 id 恰出现应有次数）。
  - `diffPair`：两个已展示 id → `openPairDiff` 以（older, newer）顺序调用（构造 `modifiedAt` 或用数组顺序断言）；含未展示 id → 不调用；两 id 相同 → 不调用；ids 非法形状（缺、非数组、非 string）→ 不调用且不抛。
  - 渲染：`totalCount > entries.length` 时含 `loadMoreButton`，等于时不含；每行含 `class="version-pick"` 与 `data-version-id`；含 `comparePairButton`。
- [ ] **测试先行 ②** `test/document/diffConfig.test.ts`：`openConfigHistoryPairDiff` 以两个 `buildConfigHistoryUri`（不同 nid）+ 期望标题调用 `vscode.diff`（该文件已有 executeCommand spy 样板）。
- [ ] 跑红 → 实现（上面设计逐项）→ 跑绿。
- [ ] `webview/nacos-config-history/index.css` 补 `.compare-bar`、`.version-pick-cell` 样式（对齐现有变量,纯样式无测试）。
- [ ] 全量回归。

### 坑（架构文档相关）

- 历史端点是唯一被服务端钳制（500）的分页端点（架构 §10 与 `ConfigHistoryPanel.ts:14-22`）；`HISTORY_PAGE_SIZE=100` 不要加大。
- `opType` 带定宽填充（`'I '`），normalize 层已 trim（`normalize.ts:268` 的 `record.opType.trim()`；字段定义在 `:149-159`）——不要在面板里再 trim。
- 翻页期间有人发布 → 行移位 → 重复 nid：必须按 id 去重（同 `mergePage` 的理由，`ConfigTreeProvider.ts:300-311`）。
- `rollback`/`diff` 单版本路径的 `shownVersions()` 校验（:154-171）不要被重构破坏——它是防页面伪造 nid 的唯一闸门，`diffPair` 也必须走同一 `shown` 数组。
- 整页重渲会丢滚动位置（B10 已知债，本任务不修）；勾选状态也会随 refresh 重置——可接受，注释说明即可。

### Done when

- [ ] >100 版本的配置能一路「加载更多」到底，计数 note 正确。
- [ ] 勾选任意两版本 →「对比选中的版本」→ 原生 diff，左旧右新，标题带两个版本标签。
- [ ] 面板/文档测试新增用例全绿，全量绿。

---

## Task A7 — 服务详情面板（P0）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`getService` `NacosClient.ts:177-179`、`NacosServiceDetail` `normalize.ts:470-477`（`ephemeral?` 注释 :474-475）、`NacosServiceCluster :457-462`、`normalizeServiceDetail :698`（clusterMap 形状注释 :690-697，`normalizeServiceClusters :728-739`）、模板锚点 `ClusterStatusPanel.ts` 先壳后数 `:118`/`:121`、`handle... :130-143`、`load... :150-172`、`render... :187-209`、命令样板 `extension.ts:668-685`、菜单样板 `package.json:305-309`（基线 `showServiceSubscribers` 确为 `atNacos.inspect@1`，与本任务「改成 @2」的前提一致）、esbuild contexts `esbuild.config.mjs:14-53`、Manifest 组测试 `:267-279`/`:286-301`/`:335-344`——全部一致。

### 现状（先读）

- 驱动能力已就绪：`src/nacos/NacosClient.ts:177-179` `getService(ref): Promise<NacosServiceDetail>`；`src/nacos/driver/normalize.ts:470-477` `NacosServiceDetail { protectThreshold, metadata, ephemeral?, clusters }`、`:457-462` `NacosServiceCluster { name, healthCheckerType?, metadata }`。MCP 侧 `nacos_get_service` 早就在用它——UI 一直没画。
- 模板：`src/webview/ClusterStatusPanel.ts`（结构照抄：`open` 先渲壳再取数 :80-123、`handle...Message` 只认 `refresh` :130-143、`load...` 把失败折成文案 :150-172、`render...` 纯函数可测 :187-209）。
- 面板注册样板：`src/extension.ts:668-685` `showServiceSubscribersCommand`（同样从 `ServiceTreeItem` 拿 `instance` + `service`，`connectToInstance` 按 id 回读）。
- 菜单 when 样板：`package.json:305-309`（`viewItem =~ /^atNacos\.service\b/`——`\b` 恰好挡住 `serviceInstance`，`Manifest.test.ts:286-301` 已验证这一点）。
- webview bundle 添加方式：`esbuild.config.mjs:38-54`（一个 context 一个 bundle；`nacos-consumers` 注释示范了「刷新即全部」的页面）。

### 步骤

- [ ] **测试先行 ① 新建** `test/webview/ServiceDetailPanel.test.ts`（模仿 `test/webview/ClusterStatusPanel.test.ts`；建议用例标题——仓库测试标题惯例是英文陈述句）：
  - `it('folds a connect failure into the snapshot error')` / `it('folds a getService failure into the snapshot error')` / `it('carries the detail when the read succeeds')`
  - `it('renders a loading shell before the snapshot arrives')` / `it('renders the error note instead of tables')` / `it('renders protect threshold, ephemerality, metadata and clusters')` / `it('says not reported when the server does not report ephemerality')` / `it('says the service defines no cluster for an empty list')` / `it('escapes metadata values')`
  - `it('answers refresh by re-rendering and nothing else')`
  - `loadServiceDetail`：connect 抛 → `{ error }`；`getService` 抛 → `{ error }`；成功 → `{ detail }`。
  - `renderServiceDetail`：无 snapshot → 含 Loading；有 error → 含错误句；有 detail → 含 `protectThreshold`（按 0-1 小数原样 `formatNumber` 展示，如 `0.5`）、`ephemeral: true → '临时实例（下线即摘除）'` 的英文源、`ephemeral === undefined → not reported`、metadata 表、clusters 表含 `healthCheckerType`；`clusters: []` → 「未定义集群」句；metadata `{}` → 复用 `No metadata.`。
  - XSS：metadata 值含 `<script>` → 输出被 `escapeAttr` 转义。
  - `handleServiceDetailMessage`：`refresh` 重渲返回 true；其他消息返回 false。
- [ ] **测试先行 ② 新建** `test/extension/ServiceDetailCommand.test.ts`（模仿 `ClusterStatusCommand.test.ts` 的 `run()` + `vi.spyOn(ServiceDetailPanel, 'open')`）：
  - 用 `ServiceTreeItem` 节点调 `run('atNacos.showServiceDetail', node)` → `open` 收到 `{ instance: {id,label}, ref: node.service }`。
  - `open` 抛错 → `showErrorMessage` 收到 `Could not open the service detail panel: {message}` 源串。
- [ ] **测试先行 ③** 计数与清单：
  - `ExtensionLifecycle.test.ts`：命令清单加 `'atNacos.showServiceDetail'`（排在 `'atNacos.showConfigListeners'` 之后、`'atNacos.showServiceSubscribers'` 之前），`toHaveLength(38)`，注释 “twenty-nine”。
  - `Manifest.test.ts`：palette 隐藏 it.each 加 `['atNacos.showServiceDetail']`；`:267-279` 「read 命令对只读实例也可见」组测试样式，为它新增一条服务节点版（pattern 匹配 `serviceNodeValue(false/true)`、不匹配 `serviceInstanceValue` 与 `configNodeValue`——直接扩 `:286-301` 那条测试为 it.each `['atNacos.showServiceSubscribers'], ['atNacos.showServiceDetail']`）；`:335-344` 分组测试可把它加进 inspect 组断言。
- [ ] 跑红。
- [ ] **实现 ① 新建** `src/webview/ServiceDetailPanel.ts`（骨架，命名与 ClusterStatusPanel 对齐）：

```ts
export type ServiceDetailClient = Pick<NacosClient, 'getService'>;

export interface ServiceDetailSnapshot {
  detail?: NacosServiceDetail;
  /** 已脱敏；经 formatError。 */
  error?: string;
}

export class ServiceDetailPanel {
  static async open(context: vscode.ExtensionContext, options: {
    instance: { id: string; label: string };
    ref: NacosServiceRef;
    connect: () => Promise<ServiceDetailClient>;
  }): Promise<void> {
    const panel = openOrRevealPanel(
      panelKey('serviceDetail', options.instance.id, options.ref.namespaceId, options.ref.group, options.ref.serviceName),
      () => vscode.window.createWebviewPanel('atNacos.serviceDetail', serviceDetailTitle(options.ref), vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [context.extensionUri] })
    );
    if (!panel) { return; }
    // ...messageOptions / onDidReceiveMessage / 先壳后数，逐行照抄 ClusterStatusPanel.open:95-122，
    // script 指向 dist/webview/nacos-service-detail.js，style 指向 webview/nacos-service-detail/index.css
  }
}
```

  渲染三节（用 `renderPanelHeader`/`renderPanelSection`/`note`/`errorNote`/`notReported`）：
  1. **基本信息**（`<dl class="metric-grid">` 复用集群面板的描述列表手法）：保护阈值（`t('Protect threshold')`，值 0-1 原样 + 辅助句）、临时性（`t('Ephemeral')`：`true → t('ephemeral (instances are removed when they go down)')`、`false → t('persistent (instances stay registered while down)')`、`undefined → notReported()`——1.x 不上报，`normalize.ts:474-475`）。
  2. **服务元数据**（`t('Service metadata')`）：空 → 复用已有键 `No metadata.`；否则 key/value 两列表。
  3. **集群**（`t('Clusters')`）：列 = 名称（复用 `Cluster`）/ 健康检查（`t('Health check')`，`healthCheckerType` 缺省 `notReported()`）/ 元数据；空数组 → `t('This service defines no cluster.')`。
- [ ] **实现 ② 新建页面** `webview/nacos-service-detail/index.ts`：整文件复制 `webview/nacos-consumers/index.ts`（刷新按钮即全部行为），仅改接口名注释；`index.css` 复制 `webview/nacos-cluster-status/index.css` 里用到的 `.panel-*`、`.metric-grid`、表格样式子集。
- [ ] **实现 ③** `esbuild.config.mjs`：`contextConfigs` 数组追加：

```js
esbuild.context({
  ...common,
  entryPoints: ['webview/nacos-service-detail/index.ts'],
  outfile: 'dist/webview/nacos-service-detail.js',
  platform: 'browser',
  format: 'iife',
  target: 'chrome114'
})
```

- [ ] **实现 ④** `src/extension.ts`：紧挨 `showServiceSubscribersCommand`（:668-685）注册 `showServiceDetailCommand`，内容照抄（`ServiceDetailPanel.open`，错误句换成 `t('Could not open the service detail panel: {message}', { message })`），push 进 subscriptions。
- [ ] **实现 ⑤** `package.json`：
  - commands 加 `{ "command": "atNacos.showServiceDetail", "title": "%atNacos.command.showServiceDetail.title%" }`。
  - commandPalette 加 `when: "false"` 条目。
  - view/item/context 加（恰 1 条，inspect 组、排在订阅者前面）：

```json
{
  "command": "atNacos.showServiceDetail",
  "when": "viewItem =~ /^atNacos\\.service\\b/",
  "group": "atNacos.inspect@1"
}
```

    同时把 `showServiceSubscribers` 的 group 改为 `atNacos.inspect@2`（详情比订阅者更常用）。
  - `package.nls.json`：`"atNacos.command.showServiceDetail.title": "AT Nacos: Show Service Detail"`；zh-cn：`"AT Nacos: 查看服务详情"`。
- [ ] 文案入 bundle（见下表）。
- [ ] 跑绿；`npm run build` 确认新 bundle 产出 `dist/webview/nacos-service-detail.js`；全量回归。

### 文案

| 英文源 | 中文 |
|---|---|
| `Service: {serviceName}` | `服务详情：{serviceName}` |
| `What {serviceName} in group {group} is configured as, on {instance}.` | `{instance} 上分组 {group} 中 {serviceName} 的服务配置。` |
| `Overview` | `基本信息` |
| `Protect threshold` | `保护阈值` |
| `The fraction of healthy instances below which Nacos starts returning unhealthy instances too.` | `健康实例占比低于该值时，Nacos 会把不健康实例也一并返回给调用方。` |
| `Ephemeral` | `实例类型` |
| `ephemeral (instances are removed when they go down)` | `临时实例（失联即摘除）` |
| `persistent (instances stay registered while down)` | `持久实例（失联仍保留注册）` |
| `Service metadata` | `服务元数据` |
| `Clusters` | `集群` |
| `Health check` | `健康检查` |
| `This service defines no cluster.` | `该服务未定义任何集群。` |
| `AT Nacos could not read this service: {message}` | `AT Nacos 无法读取该服务：{message}` |
| `Could not open the service detail panel: {message}` | `无法打开服务详情面板：{message}` |

（`Cluster`、`No metadata.`、`not reported`、`Refresh`、`Refreshing...`、`Loading...` 均已在 bundle，直接复用。）

### 坑（架构文档）

- 服务详情响应形状分裂：1.x `clusterMap` 是数组、2.x/3.x 是对象且服务名字段叫 `serviceName`（架构 §「服务详情」、`normalize.ts:728-739`）——已在 normalize 层抹平，面板**只消费 `NacosServiceDetail`**，不要碰原始响应。
- 3.0/3.1 v1 服务详情默认 410（架构 §4.2 表），resolver 会自动落到 v3 driver——面板无须感知，但失败句要走 `errorNote` 而不是空白。
- `protectThreshold` 是 0-1 分数，**不要**在本任务把它渲染成百分比（与 A10 的 cpu/mem 不同，Nacos 控制台也按小数展示）；用辅助句解释即可。

### Done when

- [ ] 服务节点右键出现「查看服务详情」（可写与只读实例都出现，注册的服务实例节点不出现）。
- [ ] 面板展示保护阈值 / 实例类型 / 元数据 / 集群健康检查，Refresh 可用，二开重复点击只 reveal。
- [ ] 计数测试（38/29/29）、新面板与命令测试全绿。

---

## Task A8 — 按 IP 反查监听（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`listListenedConfigs` `NacosClient.ts:169-171`、`NacosListenedConfigQuery` `NacosDriver.ts:137-141`、`NacosListenedConfig` `normalize.ts:169-173`、实例挑选样板 `extension.ts:1052-1079`、命名空间样板 `diffConfig.ts:205-243`（`namespaceChoiceLabel :241`）、palette 可见样板 `Manifest.test.ts:178-184`、`nacos-consumers` bundle `esbuild.config.mjs:49-50`（页面刷新按钮 `webview/nacos-consumers/index.ts:46`）、`askForNewConfigRef` `extension.ts:1138+`——全部一致。命令注册插入点：`uninstallMcpConfigCommand` 在 `:949`，新命令放它后面即可。

### 现状（先读）

- 驱动/MCP 已通：`src/nacos/NacosClient.ts:169-171` `listListenedConfigs(query)`；`src/nacos/driver/NacosDriver.ts:137-141` `NacosListenedConfigQuery { namespaceId, ip, aggregation? }`；返回 `NacosListenedConfig { group, dataId, md5 }[]`（`normalize.ts:168-173`）。MCP 工具 `nacos_list_listened_configs` 在 `src/mcp/toolCatalog.ts`；driver 测试在 `test/nacos/driver/listenedConfigs.test.ts`。UI 没有任何入口。
- 表格/面板复用对象：`src/webview/ConfigListenersPanel.ts`（正向面板，列头 `Client`/`Version held`）与 `webview/nacos-consumers/index.ts`（刷新即全部的共享 bundle，`esbuild.config.mjs:46-54` 注释明说一 bundle 多面板）。
- 实例挑选样板：`src/extension.ts:1052-1079` `pickInstanceForClusterStatus`（0 个引导添加、1 个不问、多个 quick pick）；命名空间挑选样板：`src/document/diffConfig.ts:205-243`（`namespaceChoiceLabel` 处理 1.x 默认命名空间空 id/空名）。
- 命令无参、自己问全参数 → **palette 可见**（类比 `installMcpConfig`，`Manifest.test.ts:173-184`）。

### 交互流程

`atNacos.findListenedConfigs`（palette 触发）：

1. 选连接（复用 pick 样板；0 个 → 「尚未添加任何 Nacos 连接」+ 添加按钮；1 个直用）。
2. `withLoadingProgress` 内 `getOrCreateClient(instance)` → `listNamespaces()` → quick pick 选命名空间（label 用 `namespaceLabel` 同款处理，description 放 id；**public 在 1.x/2.x 的 id 是空串**，pick 返回什么就传什么，不要换成 `'public'`——架构 §「命名空间 id」）。
3. `showInputBox` 要 IP（prompt `t('Client IP to look up')`，placeholder `t('e.g. 10.0.0.15')`，`validateInput` 空 → `t('An IP address is required.')`；trim 后空同样中止——参照 `askForNewConfigRef` :1138-1149 对 Escape/空值的处理）。
4. `ListenedConfigsPanel.open(context, { instance: {id,label}, namespaceId, namespaceLabel, ip, connect: () => connectToInstance(...) })`。

### 面板 `src/webview/ListenedConfigsPanel.ts`（新建）

- `panelKey('listenedConfigs', instance.id, namespaceId, ip)`（同 IP 重复查询 reveal）。
- viewType `'atNacos.listenedConfigs'`；script/style 直接指向**现成的** `dist/webview/nacos-consumers.js` / `webview/nacos-consumers/index.css`（本任务**不加** esbuild entry——页面行为与监听者/订阅者面板完全一致，正是那个 bundle 注释预留的场景）。
- `ListenedConfigsClient = Pick<NacosClient, 'listListenedConfigs'>`；load 走 `settle` 不 reject；渲染：
  - 标题 `t('Listened configurations: {ip}')`；描述 `t('The configurations client {ip} is long-polling in namespace {namespace}, on {instance}.')`。
  - 表：`t('Group')` / `Data ID`（不译，直接写死文本 `Data ID`——它是 Nacos 术语，两个语言都这么叫，不进 bundle）/ 复用 `t('Version held')`（md5，空串 → `notReported()`）。
  - 空列表 → `t('Nacos reported no configuration listened by this client. Only a client long-polling this server appears here, and an IP that never read a configuration never will.')`。
  - 失败 → `t('AT Nacos could not read the configurations this client listens to: {message}')`。

### 步骤

- [ ] **测试先行 ① 新建** `test/webview/ListenedConfigsPanel.test.ts`（模板 `ConfigListenersPanel.test.ts`）：load 把 `{ namespaceId, ip }` 原样传给 `listListenedConfigs`；成功渲染行（group/dataId/md5）；md5 空串 → not reported；空列表句；错误句；`refresh` 消息重渲、其他消息 false；XSS：dataId 含 `<img>` 被转义。建议用例标题：`it('passes the namespace and ip through to the client')`、`it('renders one row per listened configuration')`、`it('says not reported for an empty md5')`、`it('explains an empty answer instead of showing an empty table')`、`it('folds a client failure into the error note')`、`it('answers refresh and ignores other messages')`、`it('escapes hostile data ids')`。
- [ ] **测试先行 ② 新建** `test/extension/FindListenedConfigsCommand.test.ts`（模板 `ClusterStatusCommand.test.ts`）：
  - 单实例 + 单命名空间 + 输入 IP → `ListenedConfigsPanel.open` 收到正确参数（spyOn open；client 用 `startTestHttpServer` 或直接 mock `getOrCreateClient` 路径——该文件样板用真 HTTP fixture，跟随现状）。
  - Escape 掉 IP 输入框 → open 不被调用、无错误弹窗。
  - 0 实例 → 信息提示 + 添加按钮路径。
  - 失败 → `Could not look up the configurations listened by {ip}: {message}`。
- [ ] **测试先行 ③** 计数与清单：`ExtensionLifecycle.test.ts` 清单加 `'atNacos.findListenedConfigs'`（排在 `'atNacos.filterServices'` 后、`'atNacos.installMcpConfig'` 前），`toHaveLength(39)`，注释 “thirty”；`Manifest.test.ts:178-184` 的「palette 可见」it.each 加 `['atNacos.findListenedConfigs']`。
- [ ] 跑红 → 实现（面板 → 命令注册 :949 之后 → subscriptions push → package.json）→ 跑绿。
- [ ] `package.json`：commands 加 `{ "command": "atNacos.findListenedConfigs", "title": "%atNacos.command.findListenedConfigs.title%" }`；**不加** commandPalette 条目（可见）；**不加** view/item/context（`nodeMenu` 约定只对有节点菜单的命令生效，没有菜单就不会被查）。nls：en `"AT Nacos: Find Configurations by Listener IP"` / zh `"AT Nacos: 按 IP 反查监听配置"`。
- [ ] 全量回归。

### 文案

| 英文源 | 中文 |
|---|---|
| `Select the Nacos instance to search on` | `选择要在哪个 Nacos 连接上反查` |
| `Select the namespace to look in` | `选择要查询的命名空间` |
| `Client IP to look up` | `要反查的客户端 IP` |
| `e.g. 10.0.0.15` | `例如 10.0.0.15` |
| `An IP address is required.` | `IP 地址不能为空。` |
| `Listened configurations: {ip}` | `监听的配置：{ip}` |
| `The configurations client {ip} is long-polling in namespace {namespace}, on {instance}.` | `{instance} 上命名空间 {namespace} 中客户端 {ip} 正在长轮询的配置。` |
| `Group` | `分组` |
| `Nacos reported no configuration listened by this client. Only a client long-polling this server appears here, and an IP that never read a configuration never will.` | `Nacos 没有返回该客户端监听的任何配置。只有正在对这台服务器长轮询的客户端才会出现在这里，从未读取过配置的 IP 不会出现。` |
| `AT Nacos could not read the configurations this client listens to: {message}` | `AT Nacos 无法读取该客户端监听的配置：{message}` |
| `Could not look up the configurations listened by {ip}: {message}` | `无法反查 {ip} 监听的配置：{message}` |

（zh 里用「连接」而非「实例」——与 A12 的术语决定保持一致，避免同 PR 内新旧不一。）

### 坑（架构文档）

- 端点三分裂：1.x/2.x `/v1/cs/listener`、3.x Admin `/v3/admin/cs/listener`、Console `/v3/console/cs/config/listener/ip`，且要兼容 `listenersStatus` 响应形状——**driver 已全部抹平**（CHANGELOG v0.1.2、`listenedConfigs.test.ts`），面板只消费归一化数组。
- 3.x `aggregation` 默认 true（driver 缺省），不要在 UI 传 false——多节点集群会只看到打到的那台。
- IP 不做格式强校验（IPv6、主机名形态的客户端标识都存在），只查非空——校验交给服务器。

### Done when

- [ ] palette 运行「按 IP 反查监听配置」，选连接 → 选命名空间 → 输 IP → 面板列出该 IP 监听的配置及 md5。
- [ ] 计数测试（39/30/30）与新用例全绿。

---

## Task A9 — 标题栏瘦身（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：view/title 12 条在 `package.json:321-382`（每视图 6 个 navigation 图标）、`Manifest.test.ts:106-114`/`:116-124` 两组 it.each、`:130-137` 集群测试、`:93-100` 的 `/view == ([\w.]+)/` 正则、fixture `executeCommand` `test-fixtures/vscode.ts:381`、filter 命令 `extension.ts:378-394`/`:396-412`——全部一致。`rg "setContext" src/` 确为空。

### 现状（先读）

- `package.json:321-382`：每个视图标题塞了 **6 个** navigation 图标（add@1 / refresh@2 / filter@3 / clear-filter@4 / cluster@5 / manage@6）。清除过滤在无过滤时也常驻；集群/管理是低频操作。
- `setContext` 没被用过（`rg "setContext" src/` 为空）；test fixture 已有 `commands.executeCommand`（`test-fixtures/vscode.ts:381`，回 undefined，可 spy）。
- 过滤状态只能经命令变化：`src/extension.ts:378-394`（filterConfigs / clearConfigFilter）、`:396-412`（services 侧）。
- 会红的测试：`Manifest.test.ts:106-124` 两组 it.each 断言 clear-filter 的 `when` 恰为 `'view == atNacos.configs'` / `'view == atNacos.services'`。

### 设计

1. **「清除过滤」仅在过滤生效时显示**：两个 context key `atNacos.configFilterActive` / `atNacos.serviceFilterActive`。
   - `src/extension.ts` `activate` 里（tree provider 建好后）定义并立即调用一次：

```ts
// 过滤只会经这两个命令变化，所以 context 在命令处同步即可。
// setContext 是 window 级状态，激活时先归零，免得上个会话残留。
const syncFilterContexts = (): void => {
  void vscode.commands.executeCommand('setContext', 'atNacos.configFilterActive', configTreeProvider.getFilter() !== undefined);
  void vscode.commands.executeCommand('setContext', 'atNacos.serviceFilterActive', serviceTreeProvider.getFilter() !== undefined);
};
syncFilterContexts();
```

   - 四个命令 handler（filterConfigs/clearConfigFilter/filterServices/clearServiceFilter）末尾各补 `syncFilterContexts();`。
   - `package.json` 两条 clear 的 when 改为：

```json
{ "command": "atNacos.clearConfigFilter", "when": "view == atNacos.configs && atNacos.configFilterActive", "group": "navigation@4" }
{ "command": "atNacos.clearServiceFilter", "when": "view == atNacos.services && atNacos.serviceFilterActive", "group": "navigation@4" }
```

2. **集群/管理移入 `...` 溢出菜单**：view/title 里 4 条（cluster×2、manage×2）的 group 从 `navigation@5/6` 改为非 navigation 组（VS Code 规则：非 navigation 组进溢出菜单）：

```json
{ "command": "atNacos.openClusterStatus", "when": "view == atNacos.configs", "group": "atNacos.manage@1" }
{ "command": "atNacos.manageInstances",  "when": "view == atNacos.configs", "group": "atNacos.manage@2" }
```

（services 视图同款两条。）

### 步骤

- [ ] **测试先行 ①** `Manifest.test.ts`：
  - `:106-114` / `:116-124` 两组 it.each 改为携带期望 when 的三元组：

```ts
it.each([
  ['atNacos.filterConfigs', '$(filter)', 'view == atNacos.configs'],
  ['atNacos.clearConfigFilter', '$(clear-all)', 'view == atNacos.configs && atNacos.configFilterActive']
])('puts %s on the configurations view title with an icon', (command, icon, when) => { ... expect(whens).toEqual([when]); });
```

  - `:130-137` 集群测试补一条断言：cluster/manage 的每个 view/title 条目 `expect(item.group?.startsWith('navigation')).toBe(false)`（新增独立测试 `keeps the cluster and manage actions in the overflow menu`）。
  - `:93-100` 的 view 匹配正则 `/view == ([\w.]+)/` 对 `A && B` 形式仍能取到 view id，不用改。
- [ ] **测试先行 ②** `ExtensionLifecycle.test.ts` 新增：

```ts
it('mirrors the configuration filter into a context key the title bar reads', async () => {
  const executed = vi.spyOn(fixtureCommands, 'executeCommand');
  activate(extensionContext());
  fixtureWindow.__setInputBoxResults(['application-uat']);

  await fixtureCommands.__getRegisteredCommands().get('atNacos.filterConfigs')?.();

  expect(executed).toHaveBeenCalledWith('setContext', 'atNacos.configFilterActive', true);

  await fixtureCommands.__getRegisteredCommands().get('atNacos.clearConfigFilter')?.();

  expect(executed).toHaveBeenLastCalledWith('setContext', 'atNacos.configFilterActive', false);
});
```

  （service 侧对称一条；再加一条「activate 时两个 key 都被置 false」。）
- [ ] 跑红 → 实现（extension.ts + package.json）→ 跑绿。
- [ ] 手测：无过滤时标题只有 4 个图标 + `...`；设过滤出现 clear-all；`...` 里有「查看集群状态 / 管理连接」。
- [ ] 全量回归。

### 坑

- Escape 关闭输入框（typed === undefined）不改过滤，也就不该改 context——`syncFilterContexts` 读 `getFilter()` 现值，天然正确。
- `setContext` 是全 window 共享命名空间，键必须带 `atNacos.` 前缀。
- 测试直接调 `provider.setFilter()` 的既有用例（`ExtensionLifecycle.test.ts:125-230`）不走命令、不会触发 setContext——它们断言的是 provider 行为，不受影响；新加的 context 断言只走命令路径。

### Done when

- [ ] 清除过滤按钮只在过滤生效时可见；集群/管理进溢出菜单。
- [ ] Manifest 与 Lifecycle 的新旧断言全绿。

---

## Task A10 — 集群 CPU/内存显示为百分比（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`renderMetricGrid` `ClusterStatusPanel.ts:342-358`、`formatNumber :381-392`（doc 注释确实解释 cpu/mem）、`NacosServerMetrics` `normalize.ts:516-526`、`CPU`/`Memory` bundle `:114`/`:116`——全部一致。

### 现状（先读）

- `src/webview/ClusterStatusPanel.ts:342-358` `renderMetricGrid`：八项指标全走 `renderNumber` → `formatNumber`（:381-392：四位小数去尾零）。`cpu`/`mem` 是 **0-1 比率**（注释原话：`0.09375`、三分之一内存到达时是 `0.3333333333333333`），当前显示 `0.0938` / `0.3333`——用户读不出这是 9.4% 和 33.3%。
- `load` 是系统负载（不是比率），`serviceCount` 等是整数——**只有 cpu/mem 两项改**。
- 类型：`normalize.ts:516-526` `NacosServerMetrics.cpu?/mem?: number`。

### 步骤

- [ ] **测试先行** `test/webview/ClusterStatusPanel.test.ts` 新增：
  - metrics `{ status:'UP', cpu: 0.09375, mem: 0.3333333333333333, load: 0.72, serviceCount: 12 }` → 渲染 html 含 `9.38%`、`33.33%`，且 `load` 仍为 `0.72`（不带 %）、`serviceCount` 为 `12`。
  - `cpu: 0` → `0%`；`cpu: 1` → `100%`；`cpu: undefined` → not reported。
- [ ] 跑红。
- [ ] 实现：`ClusterStatusPanel.ts` 加：

```ts
/**
 * cpu 与 mem 在所有版本上都是 0-1 的占用比率（0.09375 = 9.375%）。
 * 乘 100 保留两位再去尾零：0.09375 → 9.38%，0.3333… → 33.33%，0 → 0%。
 * load 不走这里 —— 它是系统负载，不是比率。
 */
function renderRatio(value: number | undefined): string {
  return value === undefined ? notReported() : escapeAttr(`${Number((value * 100).toFixed(2))}%`);
}
```

  `renderMetricGrid` 的两行改为 `[t('CPU'), renderRatio(metrics.cpu)]`、`[t('Memory'), renderRatio(metrics.mem)]`；`formatNumber` 的 doc 注释（:381-389）删掉关于 cpu/mem 的那半段（职责已移走）。
- [ ] 跑绿 + 全量回归（A2 若已完成，此文件里 `t('Nacos version')` 已存在，别互相回退）。

### 坑

- 不要防御「server 送 >1 的值」——1 以上照乘（150%），那是服务器的答案；发明钳制反而撒谎。
- `%` 是数字符号不是文案，不进 bundle；`CPU`/`Memory` 键已存在（`bundle.l10n.zh-cn.json:114/116`）不动。

### Done when

- [ ] 集群面板 CPU/内存显示 `9.38%` 式百分比，负载与计数原样。
- [ ] 新用例绿，全量绿。

---

## Task A11 — 只读在深层节点可见（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：实例节点 description `NacosTreeItems.ts:111-115`、readonly contextValue 分叉 `:47-49`、`ConfigTreeItem.tooltip` 赋值 `:196`、`ServiceTreeItem.tooltip :293-304`、`instanceTooltip :381-395`（多行 string 先例 `:394`）、分组派生说明 `:167-170`、写菜单 `package.json:271-284`（publishConfig 节点菜单在 :276）、Manifest `instance(readOnly)` 工厂 `:210-260`、菜单钉死测试 `:368-388`——全部一致。

### 现状（先读）

- 只读的可见提示只有实例节点一处：`src/tree/NacosTreeItems.ts:111-115`（description「只读」）。深层节点只是**少了菜单**：配置节点 contextValue 变 `.readonly` 导致编辑/发布/删除菜单消失（`:47-49` + `package.json:271-284`），但 tooltip（`:196`）只说「分组 {group} 下的 {dataId}」——用户看到的是「功能缺失」而不是「被只读拦了」。
- 同样盲区：服务节点 tooltip（`:293-304`）、服务实例节点 tooltip（`instanceTooltip` :381-395，上线/下线菜单被 `.readonly` 隐藏）。

### 步骤

- [ ] **测试先行 新建** `test/tree/NacosTreeItems.test.ts`（构造器直测，套 `Manifest.test.ts:210-260` 的 `instance(readOnly)` 工厂写法）：
  - 只读实例的 `ConfigTreeItem.tooltip` 含 `The connection holding this configuration is read-only`（fixture 回显英文源）；可写实例不含。
  - 只读实例的 `ServiceTreeItem.tooltip` 含服务版句子；可写不含。
  - 只读实例的 `ServiceInstanceTreeItem.tooltip` 含实例版句子；可写不含；且原有健康/元数据行仍在（`toContain('This instance is healthy.')`）。
- [ ] 跑红。
- [ ] 实现 `src/tree/NacosTreeItems.ts`：
  - `ConfigTreeItem` 构造器（:196 之后）：

```ts
if (instance.readOnly) {
  // 菜单被 .readonly 上下文值藏起来了；节点得自己说为什么，
  // 否则「没有编辑项」读起来像功能缺失而不是刻意拦截。
  this.tooltip = `${this.tooltip}\n${t('The connection holding this configuration is read-only, so editing, publishing and deleting are disabled here.')}`;
}
```

  - `ServiceTreeItem` 构造器（tooltip 赋值后）同款 append：`t('The connection holding this service is read-only, so its instances cannot be enabled or disabled here.')`。
  - `ServiceInstanceTreeItem` 构造器（:341 之后）append：`t('The connection holding this instance is read-only, so it cannot be enabled or disabled here.')`（放构造器而不是 `instanceTooltip`——那个纯函数拿不到 `instance.readOnly`，不值得为此改签名）。
- [ ] bundle 加三键（下表）；跑绿 + 全量回归。

### 文案

| 英文源 | 中文 |
|---|---|
| `The connection holding this configuration is read-only, so editing, publishing and deleting are disabled here.` | `该配置所属连接为只读，编辑、发布与删除在此均不可用。` |
| `The connection holding this service is read-only, so its instances cannot be enabled or disabled here.` | `该服务所属连接为只读，无法在此上线或下线它的实例。` |
| `The connection holding this instance is read-only, so it cannot be enabled or disabled here.` | `该实例所属连接为只读，无法在此上线或下线。` |

### 坑

- `ConfigTreeItem.tooltip` 现在是 string（不是 MarkdownString），`\n` 在 VS Code hover 中换行生效——保持 string，别升级 MarkdownString（`ServiceInstanceTreeItem` 的多行 tooltip `:394` 就是这么干的）。
- 不要动 contextValue / 菜单逻辑——那套已被 `Manifest.test.ts:368-388` 钉死。
- 分组/命名空间节点不加（它们只有「新建配置」一个写菜单，且 `.readonly` 已隐藏；tooltip 空间留给已有的分组派生说明 `:167-170`）。

### Done when

- [ ] 只读连接下 hover 配置/服务/服务实例节点，均出现「所属连接为只读…」说明行。
- [ ] 新建的 NacosTreeItems 测试绿，全量绿。

---

## Task A12 — 术语：「连接」vs「服务实例」（P1）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：改动清单 ② 里全部 bundle 行号（:2、:3、:14、:16、:18、:19、:37、:38、:45、:48-52、:78、:85、:132、:143、:172、:173、:187）与键值逐条比对一致；`package.nls.zh-cn.json` 六个键的旧值一致（welcome 两键确用「实例」）。「明确不改」清单里的 ② 类键也全部存在。

### 决策（保守）

「实例」在中文 UI 里三义：① 插件里保存的一条 Nacos 服务器连接（`NacosInstanceConfig`）；② 服务下注册的实例（`NacosInstance`）；③ 口语里的“Nacos 实例=一台部署”。整改口径：

- **① 一律改叫「连接」**（个别指向主机本体的句子用「服务器」）。
- **② 保持「实例」**（上线/下线实例、实例健康——Nacos 官方中文术语）。
- **只改 zh-cn 翻译值。不改**：英文源串/键、`NacosInstance`/`NacosInstanceConfig`/`InstanceTreeItem` 等类型名、`atNacos.addInstance` 等命令 id、contextValue、panelKey、日志文本。英文 UI 维持 “Instance”（Nacos 英文文档也这么叫），故 `package.nls.json` 不动。

### 改动清单 ①：`package.nls.zh-cn.json`（键不变，仅值）

| 键 | 旧值 | 新值 |
|---|---|---|
| `atNacos.command.addInstance.title` | `AT Nacos: 添加实例` | `AT Nacos: 添加连接` |
| `atNacos.command.manageInstances.title` | `AT Nacos: 管理实例` | `AT Nacos: 管理连接` |
| `atNacos.command.editInstance.title` | `AT Nacos: 编辑实例` | `AT Nacos: 编辑连接` |
| `atNacos.command.deleteInstance.title` | `AT Nacos: 删除实例` | `AT Nacos: 删除连接` |
| `atNacos.welcome.configs` | `尚未配置任何 Nacos 实例。\n[添加实例](command:atNacos.addInstance)` | `尚未添加任何 Nacos 连接。\n[添加连接](command:atNacos.addInstance)` |
| `atNacos.welcome.services` | `尚未配置任何 Nacos 实例。添加后即可浏览其中注册的服务。\n[添加实例](command:atNacos.addInstance)` | `尚未添加任何 Nacos 连接。添加后即可浏览其中注册的服务。\n[添加连接](command:atNacos.addInstance)` |

**不改**：`enableServiceInstance` / `disableServiceInstance`（上线实例/下线实例——②类）。

### 改动清单 ②：`l10n/bundle.l10n.zh-cn.json`（键=英文源，不变；仅中文值）

| 英文键（行号） | 新中文值 |
|---|---|
| `Add Nacos Instance`（:2） | `添加 Nacos 连接` |
| `Edit Nacos Instance: {label}`（:3） | `编辑 Nacos 连接：{label}` |
| `Read-only instance`（:14） | `只读连接` |
| `Test Connection`（:16） | （已是「测试连接」，不动，列出仅为完整性） |
| `Save Instance`（:18） | `保存连接` |
| `Add Instance`（:19） | `添加连接` |
| `Delete Nacos instance "{label}"?`（:45） | `确定删除 Nacos 连接「{label}」吗？` |
| `No Nacos instances configured yet.`（:48） | `尚未添加任何 Nacos 连接。` |
| `Select a Nacos instance to edit or delete`（:49） | `选择要编辑或删除的 Nacos 连接` |
| `Could not open the Nacos instance form: {message}`（:50） | `无法打开 Nacos 连接表单：{message}` |
| `Could not manage Nacos instances: {message}`（:51） | `无法管理 Nacos 连接：{message}` |
| `Could not delete the Nacos instance: {message}`（:52） | `无法删除 Nacos 连接：{message}` |
| `Select a Nacos instance to show the cluster status of`（:85） | `选择要查看集群状态的 Nacos 连接` |
| `The Nacos instance {label} is no longer configured. It was probably deleted while this view stayed open.`（:132） | `Nacos 连接 {label} 已不在列表中，多半是在这个视图保持打开期间被删除了。` |
| `This configuration belongs to a Nacos instance that is no longer configured. ...`（:78） | `该配置所属的 Nacos 连接已不在列表中，多半是在这个编辑器保持打开期间被删除了。` |
| `Select the Nacos instance to compare with`（:143） | `选择要对比的 Nacos 连接` |
| `The Nacos instance {label} is configured as read-only. Modifying configurations or service instances is disabled for this server.`（:187） | `Nacos 连接 {label} 已被配置为只读。该服务器禁止修改配置或服务实例。` |
| `Lets Agents read this instance over MCP even when no panel is open.`（:38） | `允许 Agent 通过 MCP 读取该连接，即使没有打开任何面板。` |
| `Hides every action that would write to this server.`（:37） | （已用「服务器」，不动） |
| `Nacos instance {host}:{port} presented a TLS certificate that has not been seen before....`（:172） | 开头改为 `Nacos 服务器 {host}:{port} 出示了…`（其余保持，占位符不动） |
| `SECURITY WARNING: The TLS certificate for Nacos instance {host}:{port} has CHANGED...`（:173） | `安全警告：Nacos 服务器 {host}:{port} 的 TLS 证书…`（其余保持） |

**明确不改的（②类，逐条核对后保留「实例」）**：`Enable Instance` / `Disable Instance` / `Enable instance {address}...` / `Disable instance {address}...` / `Instance {address} is now enabled...` / `Instance {address} is now disabled...` / `This instance is healthy.` / `This instance is unhealthy.` / `This instance is disabled, so Nacos hands it to no caller.` / `instance count not reported` / `{serviceName} in group {group}: {healthy} of {total} instances healthy.` / `Instances`（集群指标「实例数」）/ `Enabling the instance...` / `Disabling the instance...` / `Could not update instance state for {address}: {message}` / `enabled` / `disabled`。

另：若 A5/A8/A11 先落地，它们新增的中文已直接用「连接」，无需返工；A12 执行时用 `rg "实例" l10n/bundle.l10n.zh-cn.json package.nls.zh-cn.json` 逐行过一遍，防漏防误伤。

### 步骤

- [ ] **测试先行** 在 `test/i18n/nls.test.ts` 新增一条术语约束测试（防回归）：

```ts
/**
 * 「实例」在中文里三义。约定：保存的服务器条目叫「连接」，服务下注册的
 * 节点才叫「实例」。这里锁死最容易复发的几个键。
 */
it.each([
  ['Add Nacos Instance', '连接'],
  ['No Nacos instances configured yet.', '连接'],
  ['Enable Instance', '实例'],
  ['This instance is healthy.', '实例']
])('translates %s with the agreed term %s', (key, term) => {
  expect(bundle[key], key).toContain(term);
});
it('never calls the saved connection 实例 in the manifest', () => {
  expect(chinese['atNacos.command.addInstance.title']).toContain('连接');
  expect(chinese['atNacos.welcome.configs']).not.toContain('实例');
});
```

- [ ] 跑红 → 按两张清单逐行改 → 跑绿。
- [ ] 核对 `nls.test.ts:48-55` placeholder 测试仍绿（所有 `{label}`/`{host}` 等原样保留）。
- [ ] 手测中文 UI：欢迎页、命令面板、管理 quick pick、删除确认框全部读「连接」；服务实例右键仍是「上线实例/下线实例」。

### 坑

- **只动值，不动键**——动键会让 `t()` 查不到翻译静默回退英文（`nls.test.ts` 会红，但别依赖它兜底）。
- `README.md`/`CHANGELOG.md` 里的「实例」不在本任务（README 属 A1 语境，历史 CHANGELOG 不改）。
- fixture 的 `l10n.t` 回显英文，所以**没有任何现有测试断言中文值**（`ClusterStatusCommand.test.ts:73-75` 断言的是英文 placeHolder）——zh-only 改动零测试破坏，这正是保守方案的价值。

### Done when

- [ ] 两张清单全部落地；新术语测试绿；全量绿。

---

## Task A13 — webview `lang`（P2）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：`html.ts:34` 写死 `<html lang="en">`、`:1` 已 import vscode、`escapeAttr :92`、CSP `:37`；fixture `env` 在 `test-fixtures/vscode.ts:491-495` 且只有 `clipboard`、无 `language`——全部一致。

### 现状（先读）

- `src/webview/html.ts:33-34`：`renderWebviewHtml` 写死 `<html lang="en">`——中文 UI 下屏幕阅读器/翻译插件拿到错误语言标签。
- `html.ts:1` 已 `import * as vscode from 'vscode'`；`vscode.env.language` 即 UI 语言（`'en'`、`'zh-cn'`…）。
- test fixture 的 `env` 只有 `clipboard`（`test-fixtures/vscode.ts:491-495`），**没有 `language`**——需要补。

### 步骤

- [ ] **测试先行** `test/webview/html.test.ts` 新增：
  - 默认（fixture `env.language = 'en'`）：输出含 `<html lang="en">`。
  - 把 `(env as { language: string }).language = 'zh-cn'` 后再调 `renderWebviewHtml` → 含 `<html lang="zh-cn">`；用 try/finally 恢复 `'en'`。
  - 恶意值兜底：`language = '"><script>'` → 输出不含裸 `<script>`（经 `escapeAttr`）。
- [ ] `test-fixtures/vscode.ts:491-495`：`env` 加 `language: 'en'`（可写属性，测试可改）。
- [ ] 跑红。
- [ ] 实现 `src/webview/html.ts`：

```ts
// 每次渲染时读，而不是模块级常量：显示语言变更会触发窗口重载，
// 但测试要能在同一进程里切语言。
return `<!DOCTYPE html>
<html lang="${escapeAttr(vscode.env.language || 'en')}">
...
```

- [ ] 跑绿 + 全量回归（所有面板测试都经 `renderWebviewHtml`，确认没有硬编码断言 `lang="en"` 的旧用例——基线没有，若 A6/A7 加了整页 snapshot 断言注意别写死）。

### Done when

- [ ] zh-cn 显示语言下所有 webview `<html lang="zh-cn">`；html 测试三连绿。

---

## Task A14 — 覆盖率脚本（P2）

> ✅ 已核对 2026-08-27（基线 `origin/cursor/nacos-opt-1-8-6a9b`）：scripts `package.json:395-402`（无覆盖率项）、devDependencies `:407-413`（vitest `^3.2.0`，无 `@vitest/coverage-*`）、`vitest.config.ts` 全 9 行无 coverage、`.gitignore` 已含 `coverage/`——全部一致。

### 现状（先读）

- `package.json:395-413`：scripts 无覆盖率项；devDependencies 无 `@vitest/coverage-*`（vitest 是 `^3.2.0`）。
- `vitest.config.ts`（全 9 行）：无 coverage 配置。
- `.gitignore` 已含 `coverage/`（无需再加）。
- README「100% 覆盖率」已由 A1 删除；本任务补上**真话**。

### 步骤

- [ ] `npm install -D @vitest/coverage-v8@^3.2.0`（**主次版本必须与 vitest 对齐**，否则运行时报 provider 版本不匹配）。
- [ ] `package.json` scripts 加：`"test:coverage": "vitest run --coverage"`。
- [ ] `vitest.config.ts`：

```ts
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // 只统计扩展主机侧源码。webview/ 下的页面脚本跑在浏览器里、
      // 刻意零逻辑（见各 index.ts 头注释），不计入以免稀释数字；
      // 这一取舍要在 README 里写明。
      include: ['src/**/*.ts'],
      reporter: ['text', 'html']
    }
  },
  resolve: {
    alias: { vscode: resolve(process.cwd(), 'test-fixtures/vscode.ts') }
  }
});
```

- [ ] 跑 `npm run test:coverage`，记录 text reporter 的总行覆盖率（All files 行）。
- [ ] `README.md` 「架构与测试」节，把 A1 的临时句补全为（用**实测数字**替换 `NN.N`）：

  「**自动化测试**：覆盖 Driver、Resolver、安全拦截、并发控制、MCP 协议等核心路径。`npm test` 运行全部用例；`npm run test:coverage` 生成覆盖率报告（当前 `src/` 行覆盖率约 **NN.N%**，随版本变化以本地运行为准；webview 页面脚本运行于浏览器端、刻意不含逻辑，不计入统计）。」

- [ ] `test/docs/ReadmeHonesty.test.ts`（A1 建的）补一条：`expect(readme).toContain('test:coverage')`；确认原有「无 100%」断言仍绿（写的是实测数字 + “约”，不会撞正则——若实测恰为 100.0%，写「>99%」并在测试里放行该写法）。
- [ ] `npm test` 全量回归（coverage 配置不影响普通 `vitest run`）。

### 坑

- 别把 `webview/**` 悄悄排除却不解释——README 里那句括号说明就是「诚实」的一部分。
- coverage html 报告目录 `coverage/` 已被忽略，别提交产物。
- CI（B11）不存在，数字只能标「本地运行为准」，不要写成保证。

### Done when

- [ ] `npm run test:coverage` 可用并输出报告；README 数字为实测值；ReadmeHonesty 测试绿。

---

## 收尾总检查

- [ ] `npm run typecheck`、`npm test`、`npm run build` 三绿。
- [ ] 计数终值核对：`contributes.commands` 30、`ExtensionLifecycle` 清单 30、subscriptions 39。
- [ ] `l10n/bundle.l10n.zh-cn.json` 无重复键（A2 测试守着），新键全部有中文。
- [ ] 手测清单（中文 UI + 一台 2.x 真机为佳）：
  - [ ] 错误节点行内重试，只刷新失败子树（A4）。
  - [ ] 连接测试失败出中文诊断 + 英文附录（A5）。
  - [ ] 历史面板翻页、任意两版本互比（A6）。
  - [ ] 服务详情面板四块信息 + Refresh（A7）。
  - [ ] 按 IP 反查出监听配置表（A8）。
  - [ ] 标题栏 4 图标 + 溢出菜单；过滤时出现清除按钮（A9）。
  - [ ] 集群 CPU/内存百分比（A10）；只读 tooltip（A11）；「连接」术语（A12）；webview lang（A13）。
- [ ] 每个 Task 独立 commit，push 到工作分支；不碰 main。
