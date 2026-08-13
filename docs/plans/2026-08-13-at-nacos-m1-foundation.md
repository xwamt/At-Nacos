# AT Nacos M1 —— 骨架、鉴权与版本适配 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `at-nacos-series` 插件骨架，实现连接一个任意版本（1.x / 2.x / 3.x）的 Nacos 实例、完成鉴权、探测服务端版本，并在侧边栏树中列出命名空间。

**Architecture:** 领域层（`src/nacos/**`）不依赖 `vscode`，通过结构化接口注入存储与日志。HTTP 层直接封装 `node:http`/`node:https` 以支持 TLS TOFU 指纹校验。版本差异由四个 Driver（v1 / v2 / v3-admin / v3-console）吸收，`NacosCapabilityResolver` 按 404 / 410 / 403 沿 fallback 链降级并缓存结果。

**Tech Stack:** TypeScript 5.9（strict）、esbuild、vitest、zod、`@at-series/mcp-hub`（M6 才接入，M1 只装依赖）

**规格真源：** `docs/plans/2026-08-13-at-nacos-architecture.md`。本计划中所有 API 路径、参数名、响应形状的依据都在该文档第 6、7、8、9 节，实现前必读。

---

## 前置条件

- [ ] **P1：确认目录位置。** 仓库必须在 `/Users/clkj/项目/at/at-nacos-series`，与 `at-series-mcp-hub` 同级。`file:../at-series-mcp-hub/packages/mcp-hub` 依赖靠这个相对路径解析。
- [ ] **P2：确认 hub 已构建。** 运行 `ls ../at-series-mcp-hub/packages/mcp-hub/dist/hub.js`，不存在则先在 hub 仓库执行 `npm ci && npm run build && npm run build:hub`。
- [ ] **P3：向用户索取真机环境。** 需要至少一个可访问的 Nacos 地址与账号，理想情况 1.x / 2.x / 3.x 各一个。Task 9 的真机验证清单依赖它。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `package.json` | 插件清单，`contributes` 用 `%key%` 占位符指向 nls |
| `package.nls.json` / `package.nls.zh-cn.json` | 静态贡献点文案（命令 title、view name、配置描述） |
| `l10n/bundle.l10n.zh-cn.json` | 运行时文案的中文包 |
| `src/i18n/t.ts` | `vscode.l10n.t` 薄封装 + webview 文案字典构造 |
| `src/config/schema.ts` | zod schema，实例配置的唯一形状定义 |
| `src/config/NacosInstanceConfigManager.ts` | globalState + SecretStorage 的 CRUD |
| `src/nacos/NacosApiError.ts` | 错误类型与分类，fallback 判据的基础 |
| `src/nacos/NacosHttpClient.ts` | node:http/https 封装，TOFU，超时，错误分类 |
| `src/nacos/NacosCertTrustStore.ts` | TLS 指纹三态存储 |
| `src/nacos/createInteractiveCertVerifier.ts` | 交互式指纹确认（唯一 import vscode 的领域文件） |
| `src/nacos/auth/NacosAuthStrategy.ts` | 鉴权策略接口 |
| `src/nacos/auth/NoAuthStrategy.ts` | 无鉴权 |
| `src/nacos/auth/UserPasswordStrategy.ts` | 登录、token 缓存、TTL 刷新、403 重登 |
| `src/nacos/auth/CustomHeaderStrategy.ts` | 固定请求头 |
| `src/nacos/auth/createAuthStrategy.ts` | 工厂 |
| `src/nacos/auth/withAuth.ts` | 给 HTTP 客户端套上鉴权头注入与 403 重试（Task 13） |
| `src/nacos/probe/resolveBaseUrl.ts` | context-path 探测 |
| `src/nacos/probe/probeServerState.ts` | 版本探测 + console 端口发现 |
| `src/nacos/driver/NacosDriver.ts` | Driver 接口与领域模型 |
| `src/nacos/driver/normalize.ts` | 响应归一化与参数名映射 |
| `src/nacos/driver/V1Driver.ts` 等四个 | 各版本实现 |
| `src/nacos/NacosCapabilityResolver.ts` | fallback 链与能力缓存 |
| `src/nacos/NacosClient.ts` | 上层唯一门面 |
| `src/nacos/testNacosConnection.ts` | 表单「测试连接」探针 |
| `src/tree/NacosTreeItems.ts` | 所有 TreeItem 子类 |
| `src/tree/ConfigTreeProvider.ts` / `ServiceTreeProvider.ts` | 两棵树 |
| `src/webview/NacosInstanceFormPanel.ts` | 实例表单 |
| `src/extension.ts` | composition root |

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `vitest.config.ts`, `.gitignore`, `.gitattributes`, `.vscodeignore`
- Create: `test-fixtures/vscode.ts`（从模板复制）

- [ ] **Step 1: 初始化仓库与依赖**

```bash
cd /Users/clkj/项目/at/at-nacos-series
git init
npm init -y
npm install zod@^3.25.76 "@at-series/mcp-hub@file:../at-series-mcp-hub/packages/mcp-hub"
npm install -D @types/node@^20.19.0 @types/vscode@^1.85.0 esbuild@^0.25.0 typescript@^5.9.0 vitest@^3.2.0
```

- [ ] **Step 2: 写 `tsconfig.json`**

与三个兄弟插件逐字节相同：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "rootDir": ".",
    "types": ["node", "vscode", "vitest/globals"]
  },
  "include": ["src", "webview", "test", "*.ts", "*.mjs"]
}
```

- [ ] **Step 3: 写 `vitest.config.ts`**

```ts
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', globals: true, include: ['test/**/*.test.ts'] },
  resolve: {
    alias: { vscode: resolve(process.cwd(), 'test-fixtures/vscode.ts') }
  }
});
```

- [ ] **Step 4: 复制 vscode mock**

```bash
cp ../at-grafana-series/test-fixtures/vscode.ts test-fixtures/vscode.ts
```

该文件（约 275 行）手写实现了 `TreeItem`、`EventEmitter`、`Uri`、`ThemeIcon`、`ThemeColor`、`window.*`、`commands`、`workspace` 等，无需改动即可用。**唯一需要补的是 `l10n` 命名空间**，在 Task 3 补。

- [ ] **Step 5: 写 `esbuild.config.mjs`**

```js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  // 生产不出 sourcemap：.vscodeignore 会剥掉 **/*.map，留下的只是悬空引用。
  sourcemap: watch,
  minify: !watch
};

const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode']
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/nacos-instance-form/index.ts'],
    outfile: 'dist/webview/nacos-instance-form.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114'
  })
];

const contexts = await Promise.all(contextConfigs);
if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
```

- [ ] **Step 6: 写 `.gitignore` / `.gitattributes` / `.vscodeignore`**

```bash
cp ../at-grafana-series/.gitattributes .gitattributes
cp ../at-grafana-series/.gitignore .gitignore
cp ../at-grafana-series/.vscodeignore .vscodeignore
```

`.vscodeignore` 中把 `media` 相关注释里的 `at-grafana` 改成 `at-nacos`。**不要给 `media/**` 加排除规则**——图标必须进 VSIX。

- [ ] **Step 7: 验证脚手架**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 无输出（通过）；vitest 报 `No test files found`（此时还没测试，属正常）。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "chore: scaffold at-nacos-series with esbuild + vitest"
```

---

## Task 2: 复制可复用的工具层

**Files:**
- Create: `src/utils/{errors,nonce,notifications,logger,redaction}.ts`
- Create: `src/webview/html.ts`
- Test: `test/utils/redaction.test.ts`

- [ ] **Step 1: 复制五个工具文件与 webview 外壳**

```bash
mkdir -p src/utils src/webview
for f in errors nonce notifications logger redaction; do
  cp ../at-grafana-series/src/utils/$f.ts src/utils/$f.ts
done
cp ../at-grafana-series/src/webview/html.ts src/webview/html.ts
```

- [ ] **Step 2: 把 logger 的类型改名**

在 `src/utils/logger.ts` 中把 `AtGrafanaLog` 全部替换为 `AtNacosLog`。`LogSink` 接口、`createRedactedLog`、`asRedactedLog`、`noopLog` 保持不变。

- [ ] **Step 3: 删掉 webview 外壳里的 iframe 部分**

`src/webview/html.ts` 中删除 `renderEmbedWebviewHtml`、`buildEmbedWebviewOptions`、`buildRecommendedCsp` 三个导出——Nacos 插件不嵌入原生控制台，保留它们只会让人以为可以那样做。保留 `renderWebviewHtml` 与 `WebviewAsset`。

- [ ] **Step 4: 写脱敏模式的失败测试**

Grafana 的 `redaction.ts` 匹配的是 `glsa_` / `glc_` 这类 Grafana 凭据，对 Nacos 无用。Nacos 要脱敏的是 accessToken（JWT）、密码、以及**配置内容里的密钥**。

`test/utils/redaction.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../../src/utils/redaction';

describe('redactSensitiveText', () => {
  it('redacts a JWT access token', () => {
    const text = 'accessToken=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuYWNvcyJ9.abc123';
    expect(redactSensitiveText(text)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redactSensitiveText(text)).toContain('[REDACTED]');
  });

  it('redacts a bearer header value', () => {
    expect(redactSensitiveText('authorization: Bearer eyJhbGciOi.xxx.yyy')).toBe(
      'authorization: Bearer [REDACTED]'
    );
  });

  it('redacts spring datasource passwords found in config content', () => {
    const text = 'spring.datasource.password=hunter2';
    expect(redactSensitiveText(text)).toBe('spring.datasource.password=[REDACTED]');
  });

  it('is idempotent so double-redaction does not mangle the marker', () => {
    const once = redactSensitiveText('spring.datasource.password=hunter2');
    expect(redactSensitiveText(once)).toBe(once);
  });
});
```

- [ ] **Step 5: 运行测试确认失败**

Run: `npx vitest run test/utils/redaction.test.ts`
Expected: FAIL —— JWT 与 `spring.datasource.password` 两条未被脱敏。

- [ ] **Step 6: 改写 `src/utils/redaction.ts` 的模式表**

删除 `GRAFANA_TOKEN_PATTERN`、`LEGACY_API_KEY_PATTERN`、`EMBED_TOKEN_PATH_PATTERN`，新增：

```ts
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const NACOS_SECRET_FIELD_PATTERN =
  /((?:^|[.\w-]*\b)(?:password|passwd|pwd|secret|secretkey|accesskey|token|credential|privatekey)\s*[=:]\s*)(\S+)/gi;
```

`redactSensitiveText` 的替换链（顺序重要——JWT 必须在通用字段模式之前，否则 `accessToken=eyJ...` 会先被后者吃掉后无法再匹配）：

```ts
export function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(JWT_PATTERN, '[REDACTED]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(NACOS_SECRET_FIELD_PATTERN, '$1[REDACTED]');
}
```

幂等性由 `[REDACTED]` 不匹配 `\S+` 之外的任何模式保证——注意 `NACOS_SECRET_FIELD_PATTERN` 的 `(\S+)` **会**匹配 `[REDACTED]` 本身，但替换结果相同，所以幂等成立。

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run test/utils/redaction.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 8: 提交**

```bash
git add src/utils src/webview test/utils
git commit -m "feat: port shared utils with Nacos-specific redaction patterns"
```

---

## Task 3: i18n 基础设施

**Files:**
- Create: `package.nls.json`, `package.nls.zh-cn.json`, `l10n/bundle.l10n.zh-cn.json`
- Create: `src/i18n/t.ts`
- Modify: `test-fixtures/vscode.ts`
- Test: `test/i18n/t.test.ts`

**为什么先做**：`vscode.l10n.t()` 在 webview 里不可用，文案必须在生成 HTML 时注入。这个机制如果后补，每个 webview 都要重写一遍。

- [ ] **Step 1: 给 vscode mock 补 l10n**

在 `test-fixtures/vscode.ts` 末尾追加：

```ts
export const l10n = {
  // 测试里不做真实翻译：返回带占位符替换的原串，断言的是 key 与参数，不是译文。
  t(message: string, ...args: unknown[]): string {
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      const record = args[0] as Record<string, unknown>;
      return message.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in record ? String(record[key]) : match
      );
    }
    return message.replace(/\{(\d+)\}/g, (match, index: string) => {
      const value = args[Number(index)];
      return value === undefined ? match : String(value);
    });
  }
};
```

- [ ] **Step 2: 写 `src/i18n/t.ts` 的失败测试**

`test/i18n/t.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildWebviewStrings, t } from '../../src/i18n/t';

describe('t', () => {
  it('passes the message through with named placeholders substituted', () => {
    expect(t('Delete instance "{label}"?', { label: 'prod' })).toBe('Delete instance "prod"?');
  });
});

describe('buildWebviewStrings', () => {
  it('resolves every requested key into a plain dictionary', () => {
    const strings = buildWebviewStrings({
      save: 'Save',
      cancel: 'Cancel'
    });
    expect(strings).toEqual({ save: 'Save', cancel: 'Cancel' });
  });

  it('produces a JSON-embeddable dictionary with no prototype pollution vector', () => {
    const strings = buildWebviewStrings({ save: 'Save' });
    expect(Object.getPrototypeOf(strings)).toBeNull();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run test/i18n/t.test.ts`
Expected: FAIL with "Cannot find module '../../src/i18n/t'"

- [ ] **Step 4: 实现 `src/i18n/t.ts`**

```ts
import * as vscode from 'vscode';

/**
 * 运行时文案的唯一入口。直接转发给 `vscode.l10n.t`，存在的意义是让
 * 调用点只依赖本模块——将来若要把这套 i18n 基础设施搬到其它 AT 插件，
 * 只需替换这一个文件，而不用改上百个调用点。
 */
export function t(message: string, args?: Record<string, unknown>): string {
  return args === undefined ? vscode.l10n.t(message) : vscode.l10n.t(message, args);
}

/**
 * Webview 侧拿不到 `vscode.l10n`（它只存在于扩展主机）。文案必须在生成
 * HTML 时翻译好、以 JSON 注入到页面。返回无原型对象，这样序列化进
 * `<script>` 时不会带上 Object.prototype 的键。
 */
export function buildWebviewStrings(source: Record<string, string>): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  for (const [key, message] of Object.entries(source)) {
    result[key] = t(message);
  }
  return result;
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/i18n/t.test.ts`
Expected: PASS（3 个测试）

- [ ] **Step 6: 建立 nls 文件**

`package.nls.json`（英文，默认）：

```json
{
  "atNacos.displayName": "AT Nacos",
  "atNacos.description": "Browse Nacos configurations, services, and cluster status inside VS Code, with Agent (MCP) integration via AT Series.",
  "atNacos.viewsContainer.title": "AT Nacos",
  "atNacos.view.configs.name": "Configurations",
  "atNacos.view.services.name": "Services",
  "atNacos.command.addInstance.title": "AT Nacos: Add Instance",
  "atNacos.command.manageInstances.title": "AT Nacos: Manage Instances",
  "atNacos.command.refreshConfigs.title": "AT Nacos: Refresh Configurations",
  "atNacos.command.refreshServices.title": "AT Nacos: Refresh Services"
}
```

`package.nls.zh-cn.json`：

```json
{
  "atNacos.displayName": "AT Nacos",
  "atNacos.description": "在 VS Code 中浏览 Nacos 配置、服务与集群状态，并通过 AT Series 集成 Agent (MCP)。",
  "atNacos.viewsContainer.title": "AT Nacos",
  "atNacos.view.configs.name": "配置管理",
  "atNacos.view.services.name": "服务列表",
  "atNacos.command.addInstance.title": "AT Nacos: 添加实例",
  "atNacos.command.manageInstances.title": "AT Nacos: 管理实例",
  "atNacos.command.refreshConfigs.title": "AT Nacos: 刷新配置",
  "atNacos.command.refreshServices.title": "AT Nacos: 刷新服务"
}
```

`l10n/bundle.l10n.zh-cn.json`（运行时文案，key 就是英文原串）：

```json
{
  "Add Nacos Instance": "添加 Nacos 实例",
  "Edit Nacos Instance: {label}": "编辑 Nacos 实例：{label}",
  "Label": "名称",
  "Server URL": "服务端地址",
  "Console URL (Nacos 3.x, optional)": "控制台地址（Nacos 3.x，可选）",
  "Authentication": "认证方式",
  "No authentication": "无鉴权",
  "Username and password": "用户名密码",
  "Custom headers": "自定义请求头",
  "Username": "用户名",
  "Password": "密码",
  "Leave blank to keep the saved password.": "留空表示沿用已保存的密码。",
  "Read-only instance": "只读实例",
  "Allow Agent background access": "允许 Agent 后台访问",
  "Test Connection": "测试连接",
  "Testing connection...": "正在测试连接…",
  "Save Instance": "保存实例",
  "Add Instance": "添加实例",
  "Saving...": "保存中…",
  "Label is required.": "名称不能为空。",
  "A valid Nacos server URL is required.": "请填写有效的 Nacos 服务端地址。",
  "Connected to Nacos {version} ({mode}).": "已连接 Nacos {version}（{mode}）。",
  "Delete Nacos instance \"{label}\"?": "确定删除 Nacos 实例「{label}」吗？",
  "Delete": "删除",
  "Edit": "编辑",
  "No Nacos instances configured yet.": "尚未配置任何 Nacos 实例。",
  "Select a Nacos instance to edit or delete": "选择要编辑或删除的 Nacos 实例",
  "public": "public（默认命名空间）"
}
```

- [ ] **Step 7: 在 package.json 声明 l10n 目录**

`package.json` 顶层加 `"l10n": "./l10n"`。

- [ ] **Step 8: 提交**

```bash
git add package.nls.json package.nls.zh-cn.json l10n src/i18n test/i18n test-fixtures/vscode.ts package.json
git commit -m "feat: add portable i18n infrastructure with webview string injection"
```

---

## Task 4: 实例配置 schema 与 ConfigManager

**Files:**
- Create: `src/config/schema.ts`, `src/config/NacosInstanceConfigManager.ts`
- Test: `test/config/schema.test.ts`, `test/config/NacosInstanceConfigManager.test.ts`

- [ ] **Step 1: 写 schema 的失败测试**

`test/config/schema.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseNacosInstanceConfig, parseNacosInstanceConfigList } from '../../src/config/schema';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'prod',
  serverUrl: 'http://nacos.example.com:8848/nacos',
  authMode: 'userPassword' as const,
  username: 'nacos',
  readOnly: true,
  allowBackgroundAccess: false,
  createdAt: 1,
  updatedAt: 2
};

describe('parseNacosInstanceConfig', () => {
  it('accepts a full config', () => {
    expect(parseNacosInstanceConfig(base).label).toBe('prod');
  });

  it('strips a trailing slash from serverUrl so path joins stay predictable', () => {
    const parsed = parseNacosInstanceConfig({ ...base, serverUrl: 'http://h:8848/nacos///' });
    expect(parsed.serverUrl).toBe('http://h:8848/nacos');
  });

  it('rejects a serverUrl without an http(s) scheme', () => {
    expect(() => parseNacosInstanceConfig({ ...base, serverUrl: 'nacos.example.com' })).toThrow();
  });

  it('rejects an unknown authMode', () => {
    expect(() => parseNacosInstanceConfig({ ...base, authMode: 'kerberos' })).toThrow();
  });

  it('defaults readOnly to false when absent so existing records keep working', () => {
    const { readOnly, ...withoutReadOnly } = base;
    expect(parseNacosInstanceConfig(withoutReadOnly).readOnly).toBe(false);
  });

  it('parses an empty list', () => {
    expect(parseNacosInstanceConfigList([])).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/config/schema.test.ts`
Expected: FAIL with "Cannot find module '../../src/config/schema'"

- [ ] **Step 3: 实现 `src/config/schema.ts`**

```ts
import { z } from 'zod';

export const NACOS_AUTH_MODES = ['none', 'userPassword', 'customHeader', 'akSk'] as const;
export type NacosAuthMode = (typeof NACOS_AUTH_MODES)[number];

const httpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/\/+$/, ''))
  .refine((value) => /^https?:\/\//i.test(value), 'URL must start with http:// or https://');

export const nacosInstanceConfigSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** 含 context-path，例如 http://host:8848/nacos 或 http://host:8848 */
    serverUrl: httpUrlSchema,
    /** Nacos 3.x 的独立 console 端口，例如 http://host:8080。留空则由探测阶段自动发现。 */
    consoleUrl: httpUrlSchema.optional(),
    authMode: z.enum(NACOS_AUTH_MODES),
    username: z.string().trim().optional(),
    /** 只读实例：UI 上彻底禁用写按钮，防止误连生产。 */
    readOnly: z.boolean().default(false),
    /** Agent 无人值守访问按实例 opt-in，默认关闭。 */
    allowBackgroundAccess: z.boolean().default(false),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strip();

export const nacosInstanceConfigListSchema = z.array(nacosInstanceConfigSchema);

export type NacosInstanceConfig = z.infer<typeof nacosInstanceConfigSchema>;

export function parseNacosInstanceConfig(value: unknown): NacosInstanceConfig {
  return nacosInstanceConfigSchema.parse(value);
}

export function parseNacosInstanceConfigList(value: unknown): NacosInstanceConfig[] {
  return nacosInstanceConfigListSchema.parse(value);
}
```

用 `.strip()` 而非 Grafana 的 `.strict()`：本插件后续里程碑还会往配置里加字段（如 AK/SK 的 region），`.strict()` 会让降级安装的旧版本读不了新数据。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/config/schema.test.ts`
Expected: PASS（6 个测试）

- [ ] **Step 5: 写 ConfigManager 的失败测试**

`test/config/NacosInstanceConfigManager.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { NacosInstanceConfigManager } from '../../src/config/NacosInstanceConfigManager';
import type { ExtensionMemento, SecretStore } from '../../src/config/NacosInstanceConfigManager';

function createMemento(): ExtensionMemento {
  const store = new Map<string, unknown>();
  return {
    get<T>(key: string, defaultValue: T): T {
      return (store.get(key) as T) ?? defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    }
  };
}

function createSecrets(): SecretStore & { snapshot(): Map<string, string> } {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key);
    },
    async store(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    snapshot: () => store
  };
}

describe('NacosInstanceConfigManager', () => {
  let manager: NacosInstanceConfigManager;
  let secrets: ReturnType<typeof createSecrets>;

  beforeEach(() => {
    secrets = createSecrets();
    manager = new NacosInstanceConfigManager(createMemento(), secrets);
  });

  it('creates an instance and stores the password in SecretStorage, not globalState', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });
    const listed = await manager.listInstances();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('hunter2');
    expect(await manager.getPassword(created.id)).toBe('hunter2');
  });

  it('keeps the stored password when update passes undefined', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });
    await manager.updateInstance(created.id, { label: 'prod-renamed' });
    expect(await manager.getPassword(created.id)).toBe('hunter2');
  });

  it('clears the stored password when update passes an empty string', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });
    await manager.updateInstance(created.id, {}, { password: '' });
    expect(await manager.getPassword(created.id)).toBe('');
  });

  it('deletes every secret belonging to a removed instance', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'customHeader',
      customHeaders: { 'X-Gateway-Token': 'abc' }
    });
    await manager.deleteInstance(created.id);
    expect(await manager.listInstances()).toEqual([]);
    expect(secrets.snapshot().size).toBe(0);
  });

  it('round-trips custom headers through SecretStorage', async () => {
    const created = await manager.createInstance({
      label: 'gw',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'customHeader',
      customHeaders: { 'X-Gateway-Token': 'abc' }
    });
    expect(await manager.getCustomHeaders(created.id)).toEqual({ 'X-Gateway-Token': 'abc' });
  });

  it('sorts instances by label so tree order is stable across writes', async () => {
    await manager.createInstance({ label: 'zeta', serverUrl: 'http://h:8848', authMode: 'none' });
    await manager.createInstance({ label: 'alpha', serverUrl: 'http://h:8849', authMode: 'none' });
    expect((await manager.listInstances()).map((i) => i.label)).toEqual(['alpha', 'zeta']);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run test/config/NacosInstanceConfigManager.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 7: 实现 `src/config/NacosInstanceConfigManager.ts`**

```ts
import { randomUUID } from 'node:crypto';
import {
  parseNacosInstanceConfig,
  parseNacosInstanceConfigList,
  type NacosAuthMode,
  type NacosInstanceConfig
} from './schema';

const INSTANCES_KEY = 'atNacos.instances';
const PASSWORD_PREFIX = 'atNacos.password.';
const HEADERS_PREFIX = 'atNacos.headers.';

export interface ExtensionMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface NacosInstanceSecrets {
  password?: string;
  customHeaders?: Record<string, string>;
}

export interface CreateNacosInstanceInput extends NacosInstanceSecrets {
  label: string;
  serverUrl: string;
  consoleUrl?: string;
  authMode: NacosAuthMode;
  username?: string;
  readOnly?: boolean;
  allowBackgroundAccess?: boolean;
}

export type UpdateNacosInstanceInput = Partial<
  Pick<
    CreateNacosInstanceInput,
    'label' | 'serverUrl' | 'consoleUrl' | 'authMode' | 'username' | 'readOnly' | 'allowBackgroundAccess'
  >
>;

export class NacosInstanceConfigManager {
  constructor(
    private readonly globalState: ExtensionMemento,
    private readonly secrets: SecretStore
  ) {}

  async listInstances(): Promise<NacosInstanceConfig[]> {
    return parseNacosInstanceConfigList(this.globalState.get<unknown[]>(INSTANCES_KEY, []));
  }

  async getInstance(id: string): Promise<NacosInstanceConfig | undefined> {
    return (await this.listInstances()).find((instance) => instance.id === id);
  }

  async createInstance(input: CreateNacosInstanceInput): Promise<NacosInstanceConfig> {
    const now = Date.now();
    const instance = parseNacosInstanceConfig({
      id: randomUUID(),
      label: input.label.trim(),
      serverUrl: input.serverUrl.trim(),
      consoleUrl: input.consoleUrl?.trim() || undefined,
      authMode: input.authMode,
      username: input.username?.trim() || undefined,
      readOnly: input.readOnly ?? false,
      allowBackgroundAccess: input.allowBackgroundAccess ?? false,
      createdAt: now,
      updatedAt: now
    });
    await this.persist(instance, input);
    return instance;
  }

  async updateInstance(
    id: string,
    patch: UpdateNacosInstanceInput,
    secrets: NacosInstanceSecrets = {}
  ): Promise<NacosInstanceConfig> {
    const existing = await this.getInstance(id);
    if (!existing) {
      throw new Error(`Unknown Nacos instance: ${id}`);
    }
    const updated = parseNacosInstanceConfig({
      ...existing,
      ...patch,
      label: (patch.label ?? existing.label).trim(),
      serverUrl: (patch.serverUrl ?? existing.serverUrl).trim(),
      updatedAt: Date.now()
    });
    await this.persist(updated, secrets);
    return updated;
  }

  async deleteInstance(id: string): Promise<void> {
    const instances = await this.listInstances();
    await this.globalState.update(
      INSTANCES_KEY,
      instances.filter((instance) => instance.id !== id)
    );
    await this.secrets.delete(this.passwordKey(id));
    await this.secrets.delete(this.headersKey(id));
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.secrets.get(this.passwordKey(id));
  }

  async getCustomHeaders(id: string): Promise<Record<string, string> | undefined> {
    const raw = await this.secrets.get(this.headersKey(id));
    if (raw === undefined) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isStringRecord(parsed) ? parsed : undefined;
    } catch {
      // A corrupt secret must not take down the tree; treat it as absent.
      return undefined;
    }
  }

  passwordKey(id: string): string {
    return `${PASSWORD_PREFIX}${id}`;
  }

  headersKey(id: string): string {
    return `${HEADERS_PREFIX}${id}`;
  }

  /**
   * `undefined` 表示「保持已存凭据不变」，空字符串才表示「清空」。编辑表单
   * 的密码框留空时走前者，这是 AT 系列所有插件的共同约定。
   */
  private async persist(instance: NacosInstanceConfig, secrets: NacosInstanceSecrets): Promise<void> {
    const instances = await this.listInstances();
    const next = [...instances.filter((entry) => entry.id !== instance.id), instance].sort((a, b) =>
      a.label.localeCompare(b.label)
    );
    await this.globalState.update(INSTANCES_KEY, next);
    if (secrets.password !== undefined) {
      await this.secrets.store(this.passwordKey(instance.id), secrets.password);
    }
    if (secrets.customHeaders !== undefined) {
      await this.secrets.store(this.headersKey(instance.id), JSON.stringify(secrets.customHeaders));
    }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run test/config`
Expected: PASS（12 个测试）

- [ ] **Step 9: 提交**

```bash
git add src/config test/config
git commit -m "feat: add Nacos instance config schema and SecretStorage-backed manager"
```

---

## Task 5: 错误分类与 HTTP 客户端

**Files:**
- Create: `src/nacos/NacosApiError.ts`, `src/nacos/NacosHttpClient.ts`
- Create: `src/nacos/NacosCertTrustStore.ts`, `src/nacos/createInteractiveCertVerifier.ts`
- Test: `test/nacos/NacosApiError.test.ts`, `test/nacos/NacosHttpClient.test.ts`, `test/nacos/testHttpServer.ts`

**关键点**：错误分类直接决定 fallback 行为，必须把 404 / 410 / 403 分成三个不同的 kind，而不是像 Grafana 那样把所有非 2xx 都归为 `api-error`。

- [ ] **Step 1: 写错误分类的失败测试**

`test/nacos/NacosApiError.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { classifyHttpStatus, NacosApiError } from '../../src/nacos/NacosApiError';

describe('classifyHttpStatus', () => {
  it('maps 404 to not-found so the resolver tries the next driver', () => {
    expect(classifyHttpStatus(404)).toBe('not-found');
  });

  it('maps 410 to api-deprecated (Nacos 3.0/3.1 compatibility switch is off)', () => {
    expect(classifyHttpStatus(410)).toBe('api-deprecated');
  });

  it('maps 403 to forbidden — Nacos never returns 401 for its own auth failures', () => {
    expect(classifyHttpStatus(403)).toBe('forbidden');
  });

  it('maps 401 to gateway-auth because it implies a proxy in front of Nacos', () => {
    expect(classifyHttpStatus(401)).toBe('gateway-auth');
  });

  it('maps other 4xx/5xx to api-error', () => {
    expect(classifyHttpStatus(500)).toBe('api-error');
    expect(classifyHttpStatus(400)).toBe('api-error');
  });

  it('maps 2xx to undefined so success is not an error kind', () => {
    expect(classifyHttpStatus(200)).toBeUndefined();
  });
});

describe('NacosApiError', () => {
  it('reports whether the resolver should fall through to the next driver', () => {
    expect(new NacosApiError('not-found', 'x', 404).shouldFallThrough()).toBe(true);
    expect(new NacosApiError('api-deprecated', 'x', 410).shouldFallThrough()).toBe(true);
    expect(new NacosApiError('forbidden', 'x', 403).shouldFallThrough()).toBe(true);
    expect(new NacosApiError('api-error', 'x', 500).shouldFallThrough()).toBe(false);
    expect(new NacosApiError('network', 'x').shouldFallThrough()).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/nacos/NacosApiError.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 `src/nacos/NacosApiError.ts`**

```ts
export type NacosApiErrorKind =
  | 'network'
  | 'tls'
  /** HTTP 403 —— Nacos 自身的鉴权失败或权限不足。Nacos 从不返回 401。 */
  | 'forbidden'
  /** HTTP 401 —— Nacos 不会产生，出现即说明前面挂了反向代理或网关。 */
  | 'gateway-auth'
  /** HTTP 404 —— 该版本没有此端点（如 3.2+ 已删除的 v1/v2）。 */
  | 'not-found'
  /** HTTP 410 —— Nacos 3.0/3.1 的 API 兼容开关处于关闭状态。 */
  | 'api-deprecated'
  /** 其它非 2xx，或 HTTP 200 但 body 的 code 字段表示业务失败。 */
  | 'api-error'
  | 'invalid-response'
  /** 发请求前的客户端侧校验失败。 */
  | 'validation'
  | 'response-too-large';

/** 需要沿 fallback 链尝试下一个 driver 的错误种类。见架构文档 §5.4。 */
const FALL_THROUGH_KINDS: ReadonlySet<NacosApiErrorKind> = new Set([
  'not-found',
  'api-deprecated',
  'forbidden'
]);

export class NacosApiError extends Error {
  constructor(
    public readonly kind: NacosApiErrorKind,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'NacosApiError';
  }

  shouldFallThrough(): boolean {
    return FALL_THROUGH_KINDS.has(this.kind);
  }
}

export function classifyHttpStatus(status: number): NacosApiErrorKind | undefined {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  switch (status) {
    case 401:
      return 'gateway-auth';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 410:
      return 'api-deprecated';
    default:
      return 'api-error';
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/nacos/NacosApiError.test.ts`
Expected: PASS（7 个测试）

- [ ] **Step 5: 复制 TLS TOFU 两件套并改名**

```bash
mkdir -p src/nacos
cp ../at-grafana-series/src/grafana/GrafanaCertTrustStore.ts src/nacos/NacosCertTrustStore.ts
cp ../at-grafana-series/src/grafana/createInteractiveCertVerifier.ts src/nacos/createInteractiveCertVerifier.ts
```

在这两个文件中把 `Grafana` 替换为 `Nacos`、`atGrafana.trustedCertFingerprints` 替换为 `atNacos.trustedCertFingerprints`、`AtGrafanaLog` 替换为 `AtNacosLog`。逻辑（三态 `unknown`/`trusted`/`changed`、指纹变更时 fail-closed）不改。

- [ ] **Step 6: 写 HTTP 客户端的失败测试与测试服务器**

`test/nacos/testHttpServer.ts`：

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestHttpServer {
  origin: string;
  requests: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  close(): Promise<void>;
}

export async function startTestHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void
): Promise<TestHttpServer> {
  const requests: TestHttpServer['requests'] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body
      });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
```

`test/nacos/NacosHttpClient.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { NacosApiError } from '../../src/nacos/NacosApiError';
import { NacosHttpClient } from '../../src/nacos/NacosHttpClient';
import { startTestHttpServer, type TestHttpServer } from './testHttpServer';

let server: TestHttpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('NacosHttpClient', () => {
  it('joins a path onto a base URL that already carries a context path', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
    await client.requestJson('GET', '/v1/console/server/state');
    expect(server.requests[0]?.url).toBe('/nacos/v1/console/server/state');
  });

  it('attaches auth headers supplied by the caller', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await client.requestJson('GET', '/x', { headers: { authorization: 'Bearer abc' } });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer abc');
  });

  it('classifies HTTP 410 as api-deprecated', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 410;
      response.end('{"status":410,"error":"Gone"}');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('GET', '/v1/cs/configs')).rejects.toMatchObject({
      kind: 'api-deprecated',
      status: 410
    });
  });

  it('classifies HTTP 404 as not-found', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 404;
      response.end('not found');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('GET', '/v1/cs/configs')).rejects.toMatchObject({
      kind: 'not-found'
    });
  });

  it('treats HTTP 200 with a non-success body code as an api-error, not a fallback trigger', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":20004,"message":"resource not found","data":null}');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    const error = await client.requestJson('GET', '/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('api-error');
    expect((error as NacosApiError).shouldFallThrough()).toBe(false);
  });

  it('accepts code 200 as success because Nacos 1.x RestResult uses HTTP-style codes', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":200,"message":null,"data":[{"namespace":""}]}');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(client.requestJson('GET', '/v1/console/namespaces')).resolves.toMatchObject({
      code: 200
    });
  });

  it('returns raw text for endpoints that answer with plain config content', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end('server.port=8080');
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    const result = await client.requestRaw('GET', '/v1/cs/configs');
    expect(result.text).toBe('server.port=8080');
    expect(result.status).toBe(200);
  });

  it('sends a urlencoded form body with the password out of the query string', async () => {
    server = await startTestHttpServer((_request, response) => response.end('{}'));
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await client.requestJson('POST', '/v1/auth/login', {
      query: { username: 'nacos' },
      form: { password: 'hunter2' }
    });
    const request = server.requests[0];
    expect(request?.url).toBe('/v1/auth/login?username=nacos');
    expect(request?.url).not.toContain('hunter2');
    expect(request?.body).toBe('password=hunter2');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });
});
```

- [ ] **Step 7: 运行测试确认失败**

Run: `npx vitest run test/nacos/NacosHttpClient.test.ts`
Expected: FAIL with "Cannot find module '../../src/nacos/NacosHttpClient'"

- [ ] **Step 8: 实现 `src/nacos/NacosHttpClient.ts`**

以 `at-grafana-series/src/grafana/GrafanaHttpClient.ts` 为骨架（TOFU 的 `attachCertVerification` / `verifyCertFingerprint` / `settled` 守卫 / 早停逻辑逐字保留，只把类型名从 `Grafana*` 改成 `Nacos*`），并做这四处 Nacos 特有的改动：

1. **构造参数去掉 `token`，改成每次请求传 `headers`。** 鉴权由 `NacosAuthenticator` 在上层注入，因为 token 会在运行中刷新，不能固化在客户端实例上。
2. **新增 `requestRaw`**，返回 `{ status, text, contentType }`。Nacos 1.x 取配置内容返回纯文本，`requestJson` 会解析失败。
3. **新增 `form` 选项**，序列化为 `application/x-www-form-urlencoded`。登录接口需要它。
4. **`parseJsonResponse` 改用 `classifyHttpStatus`**，并增加「HTTP 200 但 body.code 非成功值」的判定。

关键片段：

```ts
import { classifyHttpStatus, NacosApiError, type NacosApiErrorKind } from './NacosApiError';

export interface NacosHttpClientOptions {
  baseUrl: string;
  certVerifier?: NacosCertVerifier;
  timeoutMs?: number;
  log?: AtNacosLog;
}

export interface NacosRequestOptions {
  query?: Record<string, string | undefined>;
  /** JSON 请求体。与 `form` 互斥。 */
  body?: unknown;
  /** application/x-www-form-urlencoded 请求体。与 `body` 互斥。 */
  form?: Record<string, string>;
  headers?: Record<string, string>;
  maxResponseBytes?: number;
  /** 覆盖 baseUrl，用于 Nacos 3.x 的独立 console 端口。 */
  baseUrlOverride?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Nacos 的两套成功码：v2/v3 用 0，1.x 的 RestResult 用 HTTP 风格的 200。 */
const SUCCESS_CODES: ReadonlySet<number> = new Set([0, 200]);

function parseJsonResponse<T>(status: number, text: string, target: URL): T {
  const kind = classifyHttpStatus(status);
  if (kind !== undefined) {
    throw new NacosApiError(kind, describeFailure(kind, status, text, target), status);
  }
  if (text.length === 0) {
    return undefined as T;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NacosApiError(
      'invalid-response',
      `Nacos returned a non-JSON response for ${target.pathname}.`
    );
  }
  // 1.x 的一部分接口在业务失败时仍返回 HTTP 200，错误藏在 body.code 里。
  // 这类失败明确不触发 driver 降级——换个版本的路径也是同样的业务错误。
  if (isRecord(parsed) && typeof parsed.code === 'number' && !SUCCESS_CODES.has(parsed.code)) {
    const message = typeof parsed.message === 'string' ? parsed.message : 'unknown error';
    throw new NacosApiError(
      'api-error',
      `Nacos returned code ${parsed.code} for ${target.pathname}: ${message}`,
      status
    );
  }
  return parsed as T;
}

/** 把分类结果翻译成用户能看懂、且指向下一步动作的一句话。 */
function describeFailure(
  kind: NacosApiErrorKind,
  status: number,
  text: string,
  target: URL
): string {
  const detail = extractErrorMessage(text);
  switch (kind) {
    case 'api-deprecated':
      return `Nacos rejected ${target.pathname} as a deprecated API (HTTP 410). This server is Nacos 3.0/3.1 with the v1/v2 compatibility switch turned off.`;
    case 'not-found':
      return `Nacos has no endpoint at ${target.pathname} (HTTP 404).`;
    case 'forbidden':
      return `Nacos denied the request to ${target.pathname} (HTTP 403)${detail ? `: ${detail}` : '. The credential may be expired, or the account may lack permission for this API.'}`;
    case 'gateway-auth':
      return `Something in front of Nacos returned HTTP 401 for ${target.pathname}. Nacos itself never answers 401, so check the reverse proxy or gateway.`;
    default:
      return `Nacos returned HTTP ${status} for ${target.pathname}${detail ? `: ${detail}` : '.'}`;
  }
}

/** v2/v3 的错误体是 `{code,message,data}`；1.x 常常只有纯文本。 */
function extractErrorMessage(text: string): string | undefined {
  if (text.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === 'string' && parsed.message.length > 0) {
      return parsed.message;
    }
  } catch {
    // 非 JSON body（1.x 的纯文本错误，或 Spring 的 410 错误页）。
    // 截断后原样带出，比丢掉有用。
    return text.slice(0, 200);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

`buildUrl` 需要处理 `baseUrlOverride`，且**必须保留 base 上已有的 context-path**。Grafana 的实现用 `new URL(path, `${base}/`)` 已经满足（因为 base 带尾部斜杠时相对路径会追加而非替换），但 `path` 必须去掉前导斜杠，否则会被当作绝对路径覆盖掉 `/nacos`：

```ts
private buildUrl(path: string, options: NacosRequestOptions): URL {
  const base = (options.baseUrlOverride ?? this.baseUrl).replace(/\/+$/, '');
  const target = new URL(path.replace(/^\/+/, ''), `${base}/`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) {
        target.searchParams.set(key, value);
      }
    }
  }
  return target;
}
```

- [ ] **Step 9: 运行测试确认通过**

Run: `npx vitest run test/nacos/NacosHttpClient.test.ts`
Expected: PASS（8 个测试）

- [ ] **Step 10: 提交**

```bash
git add src/nacos test/nacos
git commit -m "feat: add Nacos HTTP client with fallback-aware error classification"
```

---

## Task 6: 鉴权策略

**Files:**
- Create: `src/nacos/auth/NacosAuthStrategy.ts`, `NoAuthStrategy.ts`, `UserPasswordStrategy.ts`, `CustomHeaderStrategy.ts`, `createAuthStrategy.ts`
- Test: `test/nacos/auth/UserPasswordStrategy.test.ts`, `test/nacos/auth/createAuthStrategy.test.ts`

- [ ] **Step 1: 写 UserPasswordStrategy 的失败测试**

`test/nacos/auth/UserPasswordStrategy.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import { UserPasswordStrategy } from '../../../src/nacos/auth/UserPasswordStrategy';

function createLoginClient(responses: unknown[]) {
  const calls: { method: string; path: string; options: unknown }[] = [];
  let index = 0;
  return {
    calls,
    async requestJson(method: string, path: string, options: unknown) {
      calls.push({ method, path, options });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }
  };
}

describe('UserPasswordStrategy', () => {
  it('logs in against the v3 endpoint first', async () => {
    const client = createLoginClient([{ accessToken: 'tok', tokenTtl: 18000 }]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await strategy.authHeaders();
    expect(client.calls[0]?.path).toBe('/v3/auth/user/login');
  });

  it('falls back to the v1 login endpoint on 404', async () => {
    const client = createLoginClient([
      new NacosApiError('not-found', 'no v3 login', 404),
      { accessToken: 'tok', tokenTtl: 18000 }
    ]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    const headers = await strategy.authHeaders();
    expect(client.calls[1]?.path).toBe('/v1/auth/login');
    expect(headers.authorization).toBe('Bearer tok');
  });

  it('sends the username as a query param and the password as a form field', async () => {
    const client = createLoginClient([{ accessToken: 'tok', tokenTtl: 18000 }]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await strategy.authHeaders();
    expect(client.calls[0]?.options).toMatchObject({
      query: { username: 'nacos' },
      form: { password: 'hunter2' }
    });
  });

  it('reuses a cached token instead of logging in on every request', async () => {
    const client = createLoginClient([{ accessToken: 'tok', tokenTtl: 18000 }]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await strategy.authHeaders();
    await strategy.authHeaders();
    expect(client.calls).toHaveLength(1);
  });

  it('re-logs in once the token passes 80% of its advertised ttl', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(0);
    const client = createLoginClient([{ accessToken: 'tok', tokenTtl: 100 }]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await strategy.authHeaders();
    now.mockReturnValue(81_000);
    await strategy.authHeaders();
    expect(client.calls).toHaveLength(2);
    now.mockRestore();
  });

  it('discards the cached token on refresh so the next call re-authenticates', async () => {
    const client = createLoginClient([
      { accessToken: 'tok1', tokenTtl: 18000 },
      { accessToken: 'tok2', tokenTtl: 18000 }
    ]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await strategy.authHeaders();
    expect(await strategy.refresh()).toBe(true);
    expect((await strategy.authHeaders()).authorization).toBe('Bearer tok2');
  });

  it('surfaces an actionable message when the server runs an OIDC auth plugin', async () => {
    const client = createLoginClient([
      new NacosApiError(
        'api-error',
        "Nacos returned code 23000: Current Nacos auth plugin type is not 'nacos' or 'nacos-ldap', don't support login API.",
        200
      )
    ]);
    const strategy = new UserPasswordStrategy(client as never, () =>
      Promise.resolve({ username: 'nacos', password: 'hunter2' })
    );
    await expect(strategy.authHeaders()).rejects.toThrow(/OIDC|external identity provider/i);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/nacos/auth`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现策略接口与三个策略**

`src/nacos/auth/NacosAuthStrategy.ts`：

```ts
export interface NacosAuthStrategy {
  /** 每个请求都要附加的头。实现可在此内部完成登录与刷新。 */
  authHeaders(): Promise<Record<string, string>>;
  /**
   * 收到 HTTP 403 后调用。返回 true 表示凭据已刷新、调用方应重试一次；
   * 返回 false 表示这个策略无法自行恢复（例如无鉴权模式）。
   */
  refresh(): Promise<boolean>;
}
```

`src/nacos/auth/NoAuthStrategy.ts`：

```ts
import type { NacosAuthStrategy } from './NacosAuthStrategy';

export class NoAuthStrategy implements NacosAuthStrategy {
  async authHeaders(): Promise<Record<string, string>> {
    return {};
  }

  async refresh(): Promise<boolean> {
    return false;
  }
}
```

`src/nacos/auth/CustomHeaderStrategy.ts`：

```ts
import type { NacosAuthStrategy } from './NacosAuthStrategy';

export class CustomHeaderStrategy implements NacosAuthStrategy {
  constructor(private readonly headers: Record<string, string>) {}

  async authHeaders(): Promise<Record<string, string>> {
    return { ...this.headers };
  }

  async refresh(): Promise<boolean> {
    // 静态头无法自行刷新；403 是真实的权限问题。
    return false;
  }
}
```

`src/nacos/auth/UserPasswordStrategy.ts`：

```ts
import { NacosApiError } from '../NacosApiError';
import type { NacosHttpClient } from '../NacosHttpClient';
import type { NacosAuthStrategy } from './NacosAuthStrategy';

const LOGIN_V3_PATH = '/v3/auth/user/login';
const LOGIN_V1_PATH = '/v1/auth/login';
/** 提前重登的比例：token 走到 TTL 的这个分数后就换新的。 */
const REFRESH_RATIO = 0.8;
/** 服务端没给 tokenTtl 时的兜底（Nacos 默认 18000 秒）。 */
const DEFAULT_TTL_SECONDS = 18_000;

export interface NacosCredentials {
  username: string;
  password: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface LoginResponse {
  accessToken?: string;
  tokenTtl?: number;
}

export class UserPasswordStrategy implements NacosAuthStrategy {
  private cached: CachedToken | undefined;
  private inFlight: Promise<CachedToken> | undefined;

  constructor(
    private readonly http: Pick<NacosHttpClient, 'requestJson'>,
    private readonly loadCredentials: () => Promise<NacosCredentials>
  ) {}

  async authHeaders(): Promise<Record<string, string>> {
    const token = await this.token();
    return { authorization: `Bearer ${token.accessToken}` };
  }

  async refresh(): Promise<boolean> {
    this.cached = undefined;
    return true;
  }

  private async token(): Promise<CachedToken> {
    const cached = this.cached;
    if (cached && Date.now() < cached.expiresAtMs) {
      return cached;
    }
    // 去重：树的多个节点并发展开时，只发一次登录请求。
    if (!this.inFlight) {
      this.inFlight = this.login().finally(() => {
        this.inFlight = undefined;
      });
    }
    const token = await this.inFlight;
    this.cached = token;
    return token;
  }

  private async login(): Promise<CachedToken> {
    const credentials = await this.loadCredentials();
    // username 走 query、password 走 form body：与官方 Java 客户端
    // HttpLoginProcessor 一致，避免密码落进 Tomcat access log。
    const options = {
      query: { username: credentials.username },
      form: { password: credentials.password }
    };

    let response: LoginResponse;
    try {
      response = await this.http.requestJson<LoginResponse>('POST', LOGIN_V3_PATH, options);
    } catch (error) {
      if (!isMissingEndpoint(error)) {
        throw toFriendlyLoginError(error);
      }
      response = await this.http
        .requestJson<LoginResponse>('POST', LOGIN_V1_PATH, options)
        .catch((v1Error: unknown) => {
          throw toFriendlyLoginError(v1Error);
        });
    }

    if (typeof response?.accessToken !== 'string' || response.accessToken.length === 0) {
      throw new NacosApiError('invalid-response', 'Nacos login did not return an accessToken.');
    }
    const ttlSeconds = typeof response.tokenTtl === 'number' ? response.tokenTtl : DEFAULT_TTL_SECONDS;
    return {
      accessToken: response.accessToken,
      expiresAtMs: Date.now() + ttlSeconds * REFRESH_RATIO * 1000
    };
  }
}

/** v3 登录端点缺失的两种表现：3.x 之前是 404，某些反代会给 501。 */
function isMissingEndpoint(error: unknown): boolean {
  return error instanceof NacosApiError && (error.status === 404 || error.status === 501);
}

function toFriendlyLoginError(error: unknown): unknown {
  if (error instanceof NacosApiError && /don't support login API/i.test(error.message)) {
    return new NacosApiError(
      'validation',
      'This Nacos server uses an external identity provider (OIDC/LDAP plugin) and does not accept username/password login. Switch the instance to "Custom headers" and paste a bearer token issued by your IdP.'
    );
  }
  return error;
}
```

`src/nacos/auth/createAuthStrategy.ts`：

```ts
import type { NacosInstanceConfig } from '../../config/schema';
import type { NacosHttpClient } from '../NacosHttpClient';
import { CustomHeaderStrategy } from './CustomHeaderStrategy';
import type { NacosAuthStrategy } from './NacosAuthStrategy';
import { NoAuthStrategy } from './NoAuthStrategy';
import { UserPasswordStrategy } from './UserPasswordStrategy';

export interface AuthStrategyDependencies {
  http: Pick<NacosHttpClient, 'requestJson'>;
  getPassword(id: string): Promise<string | undefined>;
  getCustomHeaders(id: string): Promise<Record<string, string> | undefined>;
}

export async function createAuthStrategy(
  instance: NacosInstanceConfig,
  deps: AuthStrategyDependencies
): Promise<NacosAuthStrategy> {
  switch (instance.authMode) {
    case 'none':
      return new NoAuthStrategy();
    case 'customHeader':
      return new CustomHeaderStrategy((await deps.getCustomHeaders(instance.id)) ?? {});
    case 'userPassword':
      return new UserPasswordStrategy(deps.http, async () => ({
        username: instance.username ?? '',
        password: (await deps.getPassword(instance.id)) ?? ''
      }));
    case 'akSk':
      // M1 不实现；表单在 Task 11 中也不提供这个选项。留一个明确的错误
      // 而不是静默降级成无鉴权，后者会让用户以为连上了其实是匿名访问。
      throw new Error('AK/SK authentication is not implemented yet.');
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/nacos/auth`
Expected: PASS（7 个测试）

- [ ] **Step 5: 写 createAuthStrategy 的测试并运行**

`test/nacos/auth/createAuthStrategy.test.ts` 覆盖四个分支：`none` 返回空头、`customHeader` 返回存储的头、`userPassword` 返回带 Bearer 的头、`akSk` 抛出「未实现」。

Run: `npx vitest run test/nacos/auth`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/nacos/auth test/nacos/auth
git commit -m "feat: add Nacos auth strategies with token caching and v3-to-v1 login fallback"
```

---

## Task 7: 版本与 context-path 探测

**Files:**
- Create: `src/nacos/probe/probeServerState.ts`, `src/nacos/probe/resolveBaseUrl.ts`
- Test: `test/nacos/probe/probeServerState.test.ts`, `test/nacos/probe/resolveBaseUrl.test.ts`

- [ ] **Step 1: 写探测的失败测试**

`test/nacos/probe/probeServerState.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import { parseServerState, probeServerState } from '../../../src/nacos/probe/probeServerState';

describe('parseServerState', () => {
  it('reads a Nacos 2.x bare map', () => {
    const state = parseServerState({
      version: '2.2.3',
      auth_enabled: 'true',
      standalone_mode: 'standalone'
    });
    expect(state).toMatchObject({ version: '2.2.3', majorVersion: 2, authEnabled: true, startupMode: 'standalone' });
  });

  it('reads startup_mode as well as standalone_mode because 2.5 renamed the key', () => {
    expect(parseServerState({ version: '2.5.2', startup_mode: 'cluster' }).startupMode).toBe('cluster');
  });

  it('unwraps a Result-wrapped 3.x response', () => {
    const state = parseServerState({ code: 0, message: 'success', data: { version: '3.2.3' } });
    expect(state.version).toBe('3.2.3');
    expect(state.majorVersion).toBe(3);
  });

  it('reads a bare 3.x response because the docs and source disagree on wrapping', () => {
    expect(parseServerState({ version: '3.2.3', startup_mode: 'standalone' }).majorVersion).toBe(3);
  });

  it('treats auth_enabled as a string, not a boolean', () => {
    expect(parseServerState({ version: '2.2.3', auth_enabled: 'false' }).authEnabled).toBe(false);
    expect(parseServerState({ version: '2.2.3' }).authEnabled).toBe(false);
  });

  it('rejects a payload with no version anywhere', () => {
    expect(() => parseServerState({ hello: 'world' })).toThrow();
  });
});

describe('probeServerState', () => {
  it('prefers the v3 admin state endpoint', async () => {
    const paths: string[] = [];
    const state = await probeServerState({
      async requestJson(_method: string, path: string) {
        paths.push(path);
        return { code: 0, data: { version: '3.2.3' } };
      }
    } as never);
    expect(paths[0]).toBe('/v3/admin/core/state');
    expect(state.majorVersion).toBe(3);
  });

  it('falls back to the v1 console state endpoint when v3 is missing', async () => {
    const paths: string[] = [];
    const state = await probeServerState({
      async requestJson(_method: string, path: string) {
        paths.push(path);
        if (path === '/v3/admin/core/state') {
          throw new NacosApiError('not-found', 'no v3', 404);
        }
        return { version: '2.2.3' };
      }
    } as never);
    expect(paths).toEqual(['/v3/admin/core/state', '/v1/console/server/state']);
    expect(state.majorVersion).toBe(2);
  });

  it('retries v3 when the v1 endpoint answers 410 (3.0/3.1 with console compat off)', async () => {
    const paths: string[] = [];
    let v3Attempts = 0;
    const state = await probeServerState({
      async requestJson(_method: string, path: string) {
        paths.push(path);
        if (path === '/v3/admin/core/state') {
          v3Attempts += 1;
          if (v3Attempts === 1) {
            throw new NacosApiError('network', 'transient', undefined);
          }
          return { code: 0, data: { version: '3.1.2' } };
        }
        throw new NacosApiError('api-deprecated', 'gone', 410);
      }
    } as never);
    expect(state.version).toBe('3.1.2');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/nacos/probe`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: 实现 `src/nacos/probe/probeServerState.ts`**

```ts
import { NacosApiError } from '../NacosApiError';
import type { NacosHttpClient } from '../NacosHttpClient';

export interface NacosServerState {
  version: string;
  majorVersion: number;
  startupMode: 'standalone' | 'cluster' | 'unknown';
  /** 只反映 `nacos.core.auth.enabled`。3.x 上为 false 也不代表 admin/console 免鉴权。 */
  authEnabled: boolean;
  raw: Record<string, string>;
}

const V3_STATE_PATH = '/v3/admin/core/state';
const V1_STATE_PATH = '/v1/console/server/state';

/**
 * 3.x 的响应形状存在争议：源码是 `Result<Map<String,String>>`（带包装），
 * 官方文档示例是裸 map。两种都接受，先看顶层再看 data。
 */
export function parseServerState(payload: unknown): NacosServerState {
  const raw = unwrap(payload);
  const version = raw.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new NacosApiError('invalid-response', 'Nacos server state did not report a version.');
  }
  const majorVersion = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(majorVersion)) {
    throw new NacosApiError('invalid-response', `Unrecognized Nacos version string: ${version}`);
  }
  // 2.5 把 standalone_mode 改名成了 startup_mode。用版本号选 key 会在
  // 改名的分界版本上出错，所以两个都读。
  const mode = raw.startup_mode ?? raw.standalone_mode;
  return {
    version,
    majorVersion,
    startupMode: mode === 'standalone' || mode === 'cluster' ? mode : 'unknown',
    authEnabled: raw.auth_enabled === 'true',
    raw
  };
}

function unwrap(payload: unknown): Record<string, string> {
  if (!isRecord(payload)) {
    throw new NacosApiError('invalid-response', 'Nacos server state was not an object.');
  }
  if (typeof payload.version === 'string') {
    return toStringRecord(payload);
  }
  if (isRecord(payload.data)) {
    return toStringRecord(payload.data);
  }
  throw new NacosApiError('invalid-response', 'Nacos server state did not report a version.');
}

export async function probeServerState(
  http: Pick<NacosHttpClient, 'requestJson'>
): Promise<NacosServerState> {
  try {
    return parseServerState(await http.requestJson('GET', V3_STATE_PATH));
  } catch (v3Error) {
    if (!shouldTryOlderState(v3Error)) {
      throw v3Error;
    }
  }

  try {
    return parseServerState(await http.requestJson('GET', V1_STATE_PATH));
  } catch (v1Error) {
    // 410 意味着这是 3.0/3.1 且 console 兼容开关关闭 —— v3 一定存在，
    // 第一次 v3 失败必然是别的原因（网络抖动等），值得再试一次。
    if (v1Error instanceof NacosApiError && v1Error.kind === 'api-deprecated') {
      return parseServerState(await http.requestJson('GET', V3_STATE_PATH));
    }
    throw v1Error;
  }
}

function shouldTryOlderState(error: unknown): boolean {
  return error instanceof NacosApiError && (error.shouldFallThrough() || error.kind === 'invalid-response');
}
```

`isRecord` 与 `toStringRecord` 已在 Task 5 中提取到 `src/nacos/jsonGuards.ts`，直接 import，**不要重新定义**。注意 `toStringRecord` 的签名是 `(value: unknown) => Record<string, string> | undefined`，对非对象返回 `undefined` 而非抛错，所以 `unwrap` 里要处理这个分支。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/nacos/probe/probeServerState.test.ts`
Expected: PASS（9 个测试）

- [ ] **Step 5: 写 context-path 与 console 端口探测的测试**

`test/nacos/probe/resolveBaseUrl.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { parseConsoleHint, candidateBaseUrls } from '../../../src/nacos/probe/resolveBaseUrl';

describe('candidateBaseUrls', () => {
  it('keeps an explicit context path as the only candidate', () => {
    expect(candidateBaseUrls('http://h:8848/nacos')).toEqual(['http://h:8848/nacos']);
  });

  it('tries /nacos before the bare origin when no context path was given', () => {
    expect(candidateBaseUrls('http://h:8848')).toEqual(['http://h:8848/nacos', 'http://h:8848']);
  });

  it('strips trailing slashes before building candidates', () => {
    expect(candidateBaseUrls('http://h:8848///')).toEqual(['http://h:8848/nacos', 'http://h:8848']);
  });
});

describe('parseConsoleHint', () => {
  it('extracts the console port and path from the 3.x path tip filter response', () => {
    expect(parseConsoleHint('Nacos Console default port is 8080, and the path is /.')).toEqual({
      port: 8080,
      path: '/'
    });
  });

  it('returns undefined for a 1.x/2.x console HTML response', () => {
    expect(parseConsoleHint('<!DOCTYPE html><html><head><title>Nacos</title>')).toBeUndefined();
  });
});
```

- [ ] **Step 6: 运行测试确认失败，然后实现 `src/nacos/probe/resolveBaseUrl.ts`**

```ts
export function candidateBaseUrls(input: string): string[] {
  const trimmed = input.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  // 用户已经给了 context-path（路径非空），照单全收——猜测只会帮倒忙。
  if (url.pathname !== '/' && url.pathname !== '') {
    return [trimmed];
  }
  return [`${url.origin}/nacos`, url.origin];
}

const CONSOLE_HINT_PATTERN = /Nacos Console default port is (\d+), and the path is (\S+?)\.?$/m;

export interface NacosConsoleHint {
  port: number;
  path: string;
}

/**
 * Nacos 3.x 的 `NacosConsolePathTipFilter` 会对 `{base}/` 返回一行 text/plain
 * 提示。命中它等于同时确认了「这是 3.x」和「console 在哪个端口」。
 * 1.x/2.x 在同一路径返回控制台 HTML，匹配不上。
 */
export function parseConsoleHint(body: string): NacosConsoleHint | undefined {
  const match = CONSOLE_HINT_PATTERN.exec(body.trim());
  if (!match) {
    return undefined;
  }
  const port = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(port)) {
    return undefined;
  }
  return { port, path: match[2] ?? '/' };
}
```

Run: `npx vitest run test/nacos/probe`
Expected: PASS（14 个测试）

- [ ] **Step 7: 提交**

```bash
git add src/nacos/probe test/nacos/probe
git commit -m "feat: probe Nacos version, context path, and 3.x console port"
```

---

## Task 8: Driver 抽象与四个命名空间实现

**Files:**
- Create: `src/nacos/driver/NacosDriver.ts`, `normalize.ts`, `V1Driver.ts`, `V2Driver.ts`, `V3AdminDriver.ts`, `V3ConsoleDriver.ts`
- Test: `test/nacos/driver/normalize.test.ts`, `test/nacos/driver/namespaceDrivers.test.ts`

**M1 只实现 `listNamespaces`。** 接口里其余方法在后续里程碑补齐，此时不声明——声明了却不实现会让 TypeScript 强迫写一堆 `throw new Error('not implemented')` 的死代码。

- [ ] **Step 1: 写归一化的失败测试**

`test/nacos/driver/normalize.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { normalizeNamespace, publicNamespaceId, namespaceParamName } from '../../../src/nacos/driver/normalize';

describe('publicNamespaceId', () => {
  it('is an empty string on 1.x and 2.x', () => {
    expect(publicNamespaceId(1)).toBe('');
    expect(publicNamespaceId(2)).toBe('');
  });

  it('is the literal "public" on 3.x', () => {
    expect(publicNamespaceId(3)).toBe('public');
  });
});

describe('namespaceParamName', () => {
  it('uses tenant for the 1.x config module', () => {
    expect(namespaceParamName(1, 'config')).toBe('tenant');
  });

  it('uses namespaceId for the 1.x naming module even though config uses tenant', () => {
    expect(namespaceParamName(1, 'naming')).toBe('namespaceId');
  });

  it('uses namespaceId everywhere on 3.x', () => {
    expect(namespaceParamName(3, 'config')).toBe('namespaceId');
    expect(namespaceParamName(3, 'naming')).toBe('namespaceId');
  });
});

describe('normalizeNamespace', () => {
  it('normalizes a 1.x/2.x entry with an empty namespace id', () => {
    expect(
      normalizeNamespace({
        namespace: '',
        namespaceShowName: 'public',
        namespaceDesc: null,
        quota: 200,
        configCount: 3,
        type: 0
      })
    ).toEqual({
      namespaceId: '',
      displayName: 'public',
      description: undefined,
      quota: 200,
      configCount: 3,
      type: 0
    });
  });

  it('normalizes a 3.x entry where the public namespace has a literal id', () => {
    expect(
      normalizeNamespace({
        namespace: 'public',
        namespaceShowName: 'public',
        namespaceDesc: 'Default Namespace',
        quota: 200,
        configCount: 0,
        type: 0
      }).namespaceId
    ).toBe('public');
  });

  it('rejects an entry with no namespace field', () => {
    expect(() => normalizeNamespace({ namespaceShowName: 'x' })).toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败，然后实现 `src/nacos/driver/normalize.ts`**

```ts
import { NacosApiError } from '../NacosApiError';

export type NacosModule = 'config' | 'naming' | 'console';

export interface NacosNamespace {
  /** 1.x/2.x 的 public 是空字符串，3.x 是字面量 'public'。原样保留，不做归一。 */
  namespaceId: string;
  displayName: string;
  description?: string;
  quota?: number;
  configCount?: number;
  type: number;
}

/**
 * 1.x/2.x 里 public 的 id 是空字符串；传 `tenant=public` 会被当成一个
 * 名叫 "public" 的自定义命名空间，查出来是空的。3.x 统一成了字面量。
 */
export function publicNamespaceId(majorVersion: number): string {
  return majorVersion >= 3 ? 'public' : '';
}

/**
 * 1.x 的 config 模块用 `tenant`，同一版本的 naming 模块却用 `namespaceId`。
 * 这是最经常写错的地方，所以集中在这里映射，不允许在 driver 里硬编码。
 */
export function namespaceParamName(majorVersion: number, module: NacosModule): 'tenant' | 'namespaceId' {
  if (majorVersion >= 3) {
    return 'namespaceId';
  }
  return module === 'config' ? 'tenant' : 'namespaceId';
}

export function normalizeNamespace(entry: unknown): NacosNamespace {
  if (!isRecord(entry) || typeof entry.namespace !== 'string') {
    throw new NacosApiError('invalid-response', 'Nacos returned a malformed namespace entry.');
  }
  return {
    namespaceId: entry.namespace,
    displayName: typeof entry.namespaceShowName === 'string' ? entry.namespaceShowName : entry.namespace,
    description: typeof entry.namespaceDesc === 'string' ? entry.namespaceDesc : undefined,
    quota: typeof entry.quota === 'number' ? entry.quota : undefined,
    configCount: typeof entry.configCount === 'number' ? entry.configCount : undefined,
    type: typeof entry.type === 'number' ? entry.type : 0
  };
}

/** v2/v3 的 `{code,message,data}` 与 1.x 的裸响应统一取值。 */
export function unwrapData<T>(payload: unknown): T {
  if (isRecord(payload) && 'data' in payload && 'code' in payload) {
    return payload.data as T;
  }
  return payload as T;
}
```

`isRecord` 从 Task 5 建立的 `src/nacos/jsonGuards.ts` import，**不要重新定义**。

Run: `npx vitest run test/nacos/driver/normalize.test.ts`
Expected: PASS（8 个测试）

- [ ] **Step 3: 写四个 driver 的失败测试**

`test/nacos/driver/namespaceDrivers.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { V1Driver } from '../../../src/nacos/driver/V1Driver';
import { V2Driver } from '../../../src/nacos/driver/V2Driver';
import { V3AdminDriver } from '../../../src/nacos/driver/V3AdminDriver';
import { V3ConsoleDriver } from '../../../src/nacos/driver/V3ConsoleDriver';

function stubHttp(payload: unknown) {
  const calls: { path: string; options?: { baseUrlOverride?: string } }[] = [];
  return {
    calls,
    async requestJson(_method: string, path: string, options?: { baseUrlOverride?: string }) {
      calls.push({ path, options });
      return payload;
    }
  };
}

describe('namespace drivers', () => {
  it('V1Driver reads /v1/console/namespaces and accepts code 200', async () => {
    const http = stubHttp({
      code: 200,
      data: [{ namespace: '', namespaceShowName: 'public', quota: 200, configCount: 1, type: 0 }]
    });
    const namespaces = await new V1Driver(http as never).listNamespaces();
    expect(http.calls[0]?.path).toBe('/v1/console/namespaces');
    expect(namespaces[0]?.namespaceId).toBe('');
  });

  it('V2Driver reads /v2/console/namespace/list', async () => {
    const http = stubHttp({
      code: 0,
      data: [{ namespace: '', namespaceShowName: 'public', type: 0 }]
    });
    await new V2Driver(http as never).listNamespaces();
    expect(http.calls[0]?.path).toBe('/v2/console/namespace/list');
  });

  it('V3AdminDriver reads /v3/admin/core/namespace/list on the server base url', async () => {
    const http = stubHttp({
      code: 0,
      data: [{ namespace: 'public', namespaceShowName: 'public', type: 0 }]
    });
    const namespaces = await new V3AdminDriver(http as never).listNamespaces();
    expect(http.calls[0]?.path).toBe('/v3/admin/core/namespace/list');
    expect(http.calls[0]?.options?.baseUrlOverride).toBeUndefined();
    expect(namespaces[0]?.namespaceId).toBe('public');
  });

  it('V3ConsoleDriver targets the separate console origin', async () => {
    const http = stubHttp({ code: 0, data: [{ namespace: 'public', namespaceShowName: 'public', type: 0 }] });
    await new V3ConsoleDriver(http as never, 'http://h:8080').listNamespaces();
    expect(http.calls[0]?.path).toBe('/v3/console/core/namespace/list');
    expect(http.calls[0]?.options?.baseUrlOverride).toBe('http://h:8080');
  });

  it('each driver reports its flavor for capability caching', () => {
    const http = stubHttp({});
    expect(new V1Driver(http as never).flavor).toBe('v1');
    expect(new V2Driver(http as never).flavor).toBe('v2');
    expect(new V3AdminDriver(http as never).flavor).toBe('v3-admin');
    expect(new V3ConsoleDriver(http as never, 'http://h:8080').flavor).toBe('v3-console');
  });
});
```

- [ ] **Step 4: 运行测试确认失败，然后实现四个 driver**

`src/nacos/driver/NacosDriver.ts`：

```ts
import type { NacosNamespace } from './normalize';

export type NacosApiFlavor = 'v1' | 'v2' | 'v3-admin' | 'v3-console';

/**
 * M1 只定义命名空间能力。后续里程碑按需扩展本接口，每次扩展都必须让
 * 四个实现同时跟进——TypeScript 会强制这一点，这正是把接口做窄的理由。
 */
export interface NacosDriver {
  readonly flavor: NacosApiFlavor;
  listNamespaces(): Promise<NacosNamespace[]>;
}
```

`src/nacos/driver/V1Driver.ts`：

```ts
import type { NacosHttpClient } from '../NacosHttpClient';
import type { NacosApiFlavor, NacosDriver } from './NacosDriver';
import { normalizeNamespace, unwrapData, type NacosNamespace } from './normalize';

export class V1Driver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v1';

  constructor(private readonly http: Pick<NacosHttpClient, 'requestJson'>) {}

  async listNamespaces(): Promise<NacosNamespace[]> {
    const payload = await this.http.requestJson('GET', '/v1/console/namespaces');
    return unwrapData<unknown[]>(payload).map(normalizeNamespace);
  }
}
```

`V2Driver` 同构，路径换成 `/v2/console/namespace/list`，flavor 为 `'v2'`。

`V3AdminDriver` 同构，路径 `/v3/admin/core/namespace/list`，flavor 为 `'v3-admin'`。

`src/nacos/driver/V3ConsoleDriver.ts` 多一个 `consoleBaseUrl` 构造参数：

```ts
export class V3ConsoleDriver implements NacosDriver {
  readonly flavor: NacosApiFlavor = 'v3-console';

  constructor(
    private readonly http: Pick<NacosHttpClient, 'requestJson'>,
    private readonly consoleBaseUrl: string
  ) {}

  async listNamespaces(): Promise<NacosNamespace[]> {
    const payload = await this.http.requestJson('GET', '/v3/console/core/namespace/list', {
      baseUrlOverride: this.consoleBaseUrl
    });
    return unwrapData<unknown[]>(payload).map(normalizeNamespace);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/nacos/driver`
Expected: PASS（13 个测试）

- [ ] **Step 6: 提交**

```bash
git add src/nacos/driver test/nacos/driver
git commit -m "feat: add version drivers with normalized namespace listing"
```

---

## Task 9: CapabilityResolver 与 NacosClient 门面

**Files:**
- Create: `src/nacos/NacosCapabilityResolver.ts`, `src/nacos/NacosClient.ts`
- Test: `test/nacos/NacosCapabilityResolver.test.ts`

- [ ] **Step 1: 写 resolver 的失败测试**

`test/nacos/NacosCapabilityResolver.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { NacosApiError } from '../../src/nacos/NacosApiError';
import { NacosCapabilityResolver } from '../../src/nacos/NacosCapabilityResolver';
import type { NacosApiFlavor, NacosDriver } from '../../src/nacos/driver/NacosDriver';

function driver(flavor: NacosApiFlavor, behavior: () => Promise<unknown>): NacosDriver {
  return { flavor, listNamespaces: behavior as never };
}

describe('NacosCapabilityResolver', () => {
  it('returns the first driver that succeeds', async () => {
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () => Promise.resolve(['a'])),
      driver('v1', () => Promise.resolve(['b']))
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).resolves.toEqual(['a']);
  });

  it('falls through on 404 and on 410', async () => {
    const tried: NacosApiFlavor[] = [];
    const resolver = new NacosCapabilityResolver([
      driver('v1', () => {
        tried.push('v1');
        return Promise.reject(new NacosApiError('api-deprecated', 'gone', 410));
      }),
      driver('v2', () => {
        tried.push('v2');
        return Promise.reject(new NacosApiError('not-found', 'missing', 404));
      }),
      driver('v3-admin', () => {
        tried.push('v3-admin');
        return Promise.resolve(['ok']);
      })
    ]);
    await resolver.run('namespaces', (d) => d.listNamespaces());
    expect(tried).toEqual(['v1', 'v2', 'v3-admin']);
  });

  it('falls through on 403 so an admin-only endpoint can degrade to console', async () => {
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () => Promise.reject(new NacosApiError('forbidden', 'denied', 403))),
      driver('v3-console', () => Promise.resolve(['ok']))
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).resolves.toEqual(['ok']);
  });

  it('does NOT fall through on a business error, because other versions will fail the same way', async () => {
    const second = vi.fn(() => Promise.resolve(['never']));
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () => Promise.reject(new NacosApiError('api-error', 'namespace not exist', 200))),
      driver('v1', second as never)
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow('namespace not exist');
    expect(second).not.toHaveBeenCalled();
  });

  it('does not fall through on a network error, which says nothing about the API version', async () => {
    const second = vi.fn(() => Promise.resolve(['never']));
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () => Promise.reject(new NacosApiError('network', 'ECONNREFUSED'))),
      driver('v1', second as never)
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow('ECONNREFUSED');
    expect(second).not.toHaveBeenCalled();
  });

  it('remembers the winning driver so the next call skips the failing ones', async () => {
    const v1 = vi.fn(() => Promise.reject(new NacosApiError('not-found', 'missing', 404)));
    const resolver = new NacosCapabilityResolver([
      driver('v1', v1 as never),
      driver('v3-admin', () => Promise.resolve(['ok']))
    ]);
    await resolver.run('namespaces', (d) => d.listNamespaces());
    await resolver.run('namespaces', (d) => d.listNamespaces());
    expect(v1).toHaveBeenCalledTimes(1);
  });

  it('re-probes from the top if the cached driver later stops working', async () => {
    let adminHealthy = true;
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () =>
        adminHealthy ? Promise.resolve(['ok']) : Promise.reject(new NacosApiError('forbidden', 'denied', 403))
      ),
      driver('v3-console', () => Promise.resolve(['console']))
    ]);
    await resolver.run('namespaces', (d) => d.listNamespaces());
    adminHealthy = false;
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).resolves.toEqual(['console']);
  });

  it('reports every attempted flavor when all drivers fail', async () => {
    const resolver = new NacosCapabilityResolver([
      driver('v1', () => Promise.reject(new NacosApiError('api-deprecated', 'gone', 410))),
      driver('v3-admin', () => Promise.reject(new NacosApiError('forbidden', 'denied', 403)))
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow(/v1.*v3-admin/s);
  });
});
```

- [ ] **Step 2: 运行测试确认失败，然后实现 `src/nacos/NacosCapabilityResolver.ts`**

```ts
import { NacosApiError } from './NacosApiError';
import type { NacosApiFlavor, NacosDriver } from './driver/NacosDriver';
import { asRedactedLog, noopLog, type AtNacosLog } from '../utils/logger';

/**
 * 按 fallback 链依次尝试 driver，并记住每个能力最终由哪个 flavor 服务，
 * 使后续调用不必重复试错。缓存条目在命中的 driver 再次失败时失效并重探，
 * 这样服务端改配置（比如管理员打开了 v1 兼容开关）后无需重启插件。
 */
export class NacosCapabilityResolver {
  private readonly resolved = new Map<string, NacosApiFlavor>();
  private readonly log: AtNacosLog;

  constructor(
    private readonly drivers: readonly NacosDriver[],
    log: AtNacosLog = noopLog
  ) {
    this.log = asRedactedLog(log);
  }

  async run<T>(capability: string, invoke: (driver: NacosDriver) => Promise<T>): Promise<T> {
    const cachedFlavor = this.resolved.get(capability);
    if (cachedFlavor) {
      const cachedDriver = this.drivers.find((driver) => driver.flavor === cachedFlavor);
      if (cachedDriver) {
        try {
          return await invoke(cachedDriver);
        } catch (error) {
          if (!isFallThrough(error)) {
            throw error;
          }
          // 之前能用的端点现在不行了（权限变更、服务端升级）。丢掉缓存重探。
          this.resolved.delete(capability);
          this.log.debug(`capability ${capability}: cached flavor ${cachedFlavor} stopped working; re-probing`);
        }
      }
    }

    const attempts: string[] = [];
    for (const driver of this.drivers) {
      try {
        const result = await invoke(driver);
        this.resolved.set(capability, driver.flavor);
        this.log.debug(`capability ${capability}: served by ${driver.flavor}`);
        return result;
      } catch (error) {
        if (!isFallThrough(error)) {
          throw error;
        }
        attempts.push(`${driver.flavor} (${describe(error)})`);
      }
    }

    throw new NacosApiError(
      'api-error',
      `No Nacos API flavor could serve "${capability}". Tried: ${attempts.join('; ')}.`
    );
  }

  /** 供诊断展示：当前每个能力实际走的是哪套 API。 */
  snapshot(): Record<string, NacosApiFlavor> {
    return Object.fromEntries(this.resolved);
  }
}

function isFallThrough(error: unknown): boolean {
  return error instanceof NacosApiError && error.shouldFallThrough();
}

function describe(error: unknown): string {
  return error instanceof NacosApiError
    ? `${error.kind}${error.status === undefined ? '' : ` ${error.status}`}`
    : String(error);
}
```

Run: `npx vitest run test/nacos/NacosCapabilityResolver.test.ts`
Expected: PASS（8 个测试）

- [ ] **Step 3: 实现 `src/nacos/NacosClient.ts` 门面**

它负责按探测结果组装 driver 链并暴露领域方法。**driver 顺序按探测到的主版本决定**：

```ts
export function buildDriverChain(
  majorVersion: number,
  http: Pick<NacosHttpClient, 'requestJson'>,
  consoleBaseUrl: string | undefined
): NacosDriver[] {
  const v3Admin = new V3AdminDriver(http);
  const v3Console = consoleBaseUrl ? new V3ConsoleDriver(http, consoleBaseUrl) : undefined;
  const v2 = new V2Driver(http);
  const v1 = new V1Driver(http);

  // 3.x：admin 优先（同端口同 context-path），403 时降级到 console；
  // 末尾仍挂 v1/v2 是为了照顾装了 legacy-adapter 的 3.2+ 部署。
  if (majorVersion >= 3) {
    return [v3Admin, ...(v3Console ? [v3Console] : []), v2, v1];
  }
  // 2.x：v2 优先，v1 补位（配置列表等接口 v2 根本没有）。v3 挂在最后
  // 没有意义（2.x 不存在 v3 端点），省掉一次必然 404 的往返。
  if (majorVersion === 2) {
    return [v2, v1];
  }
  return [v1];
}
```

`NacosClient` 持有 resolver 并转发：

```ts
export class NacosClient {
  constructor(
    private readonly resolver: NacosCapabilityResolver,
    readonly state: NacosServerState
  ) {}

  listNamespaces(): Promise<NacosNamespace[]> {
    return this.resolver.run('namespaces', (driver) => driver.listNamespaces());
  }
}
```

补一个 `test/nacos/NacosClient.test.ts` 覆盖 `buildDriverChain` 的三种版本分支（3.x 有 console 与无 console、2.x、1.x），断言返回的 flavor 顺序。

- [ ] **Step 4: 运行全部测试**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: 真机验证（依赖前置条件 P3）**

用真实实例逐条确认架构文档 §14 的不确定项，把结果回填进架构文档：

```bash
# 替换成真实地址
BASE=http://<host>:8848/nacos
curl -s "$BASE/v3/admin/core/state" | head -c 500; echo    # 确认是否带 {code,data} 包装
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/console/server/state"
curl -s "$BASE/" | head -c 200; echo                        # 3.x 是否回 console 提示
curl -s "$BASE/v1/console/namespaces" | head -c 300; echo    # code 是 200 还是 0
```

把每条的真实输出记录到架构文档 §14 对应条目下，标注「已验证」。

- [ ] **Step 6: 提交**

```bash
git add src/nacos test/nacos docs/plans
git commit -m "feat: add capability resolver with driver fallback chain and Nacos client facade"
```

---

## Task 10: 连接测试探针

**Files:**
- Create: `src/nacos/testNacosConnection.ts`
- Test: `test/nacos/testNacosConnection.test.ts`

- [ ] **Step 1: 写探针的失败测试**

覆盖五种结果：成功（返回版本与模式）、鉴权失败（403）、网络不可达、TLS 不受信、context-path 猜错时自动切到裸 origin 后成功。

```ts
import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../src/nacos/NacosApiError';
import { testNacosConnection } from '../../src/nacos/testNacosConnection';

describe('testNacosConnection', () => {
  it('reports the detected version and startup mode on success', async () => {
    const result = await testNacosConnection({
      serverUrl: 'http://h:8848/nacos',
      authMode: 'none',
      probe: async () => ({
        version: '2.2.3',
        majorVersion: 2,
        startupMode: 'standalone' as const,
        authEnabled: false,
        raw: {}
      })
    });
    expect(result).toMatchObject({ ok: true, version: '2.2.3', startupMode: 'standalone' });
  });

  it('classifies a 403 as an auth failure with an actionable message', async () => {
    const result = await testNacosConnection({
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      probe: async () => {
        throw new NacosApiError('forbidden', 'denied', 403);
      }
    });
    expect(result).toMatchObject({ ok: false, reason: 'auth' });
    expect(result.message).toMatch(/credential|permission/i);
  });
});
```

- [ ] **Step 2: 运行确认失败，实现，运行确认通过**

`testNacosConnection` 遍历 `candidateBaseUrls()` 的候选，对每个调 `probeServerState`，第一个成功的返回 `{ ok: true, baseUrl, version, majorVersion, startupMode, consoleUrl? }`。全部失败时按最后一个错误的 kind 映射成 `reason: 'auth' | 'network' | 'tls' | 'error'`。

Run: `npx vitest run test/nacos/testNacosConnection.test.ts`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/nacos/testNacosConnection.ts test/nacos/testNacosConnection.test.ts
git commit -m "feat: add connection test probe with context-path auto-detection"
```

---

## Task 11: 实例表单 Webview

**Files:**
- Create: `src/webview/NacosInstanceFormPanel.ts`
- Create: `webview/nacos-instance-form/index.ts`, `webview/nacos-instance-form/index.css`
- Test: `test/webview/NacosInstanceFormPanel.test.ts`

- [ ] **Step 1: 写消息处理的失败测试**

按 Grafana 的可测试性约定，消息处理逻辑抽成独立导出的纯函数 `handleInstanceFormMessage(message, existing, configManager, onSaved, panel, options)`，Panel 类只是薄薄的 `static async open()`。测试覆盖：

- 提交新实例时调用 `createInstance` 并关闭面板
- 名称为空时回发 `{type:'error'}` 而不是抛异常
- serverUrl 非 http(s) 时回发 error
- `authMode: 'userPassword'` 且新建时密码为空 → 回发 error
- 编辑已有实例时密码留空 → `updateInstance` 收到的 secrets 里 `password` 为 `undefined`（沿用旧值）
- `readOnly` 复选框状态正确落到 `createInstance` 的入参
- 点击测试连接回发 `{type:'connectionTestResult', payload:{ok, message}}`

- [ ] **Step 2: 运行确认失败，实现 Panel 与前端**

表单字段：名称、服务端地址、控制台地址（可选，标注「Nacos 3.x」）、认证方式下拉（无鉴权 / 用户名密码 / 自定义请求头，**不含 AK/SK**）、用户名、密码、自定义头（key-value 文本域）、只读实例复选框、允许 Agent 后台访问复选框。认证方式切换时用 CSS 类显隐对应字段组。

HTML 由扩展侧模板字符串生成，所有插值过 `escapeAttr()`。文案通过 Task 3 的 `buildWebviewStrings()` 翻译后注入：

```ts
const strings = buildWebviewStrings({
  label: 'Label',
  serverUrl: 'Server URL',
  consoleUrl: 'Console URL (Nacos 3.x, optional)',
  testConnection: 'Test Connection',
  testing: 'Testing connection...',
  saving: 'Saving...'
});
```

注入方式是在 body HTML 里放一个带 nonce 的 `<script type="application/json" id="atNacosStrings">`，前端 `JSON.parse` 读取。**不要**用 `<script nonce>...window.X = {...}</script>` 拼接，那等于把翻译文本当代码执行。

**序列化时必须转义 `<`**（Task 3 定下的分工，转义属于写 HTML 的这一层，不属于 `buildWebviewStrings`）：

```ts
const payload = JSON.stringify(strings).replace(/</g, '\\u003c');
```

只转 `<` 就够，它同时挡住 `</script`（提前闭合标签）和 `<!--`（让分词器进入 script data escaped 状态）。三点必须记住：

1. **转义只能作用在序列化后的文本上。** 若改在字典的值上替换，`JSON.stringify` 会把反斜杠再转义一次，页面拿到字面量 `\u003c/script>`——既没防住注入又损坏了文案。
2. **HTML 实体在这里完全无效。** `<script>` 是 raw-text 元素，解析器不在其中解码实体，`&lt;` 会原样进入 `JSON.parse`。
3. **风险是真实的，不能用「译文是我们自己写的」免除。** `t('Edit Nacos Instance: {label}', { label })` 里的 `label` 来自用户配置的实例名，是可控输入，走同一条通道。

把这个动作收敛成 `src/webview/html.ts` 里的一个 helper（例如 `renderJsonScript(id, value, nonce)`），不要散落在各个 Webview——只有一处需要审。`html.ts` 现有的 CSP 是第二层防线（注入的内联脚本拿不到随机 nonce），但它挡的是执行，挡不住 DOM 结构被破坏和 `JSON.parse` 失败，替代不了转义。

CSS 从 `at-terminal-series/webview/server-form/index.css` 起手（520 行，类名体系最完整），保留 `.field-stack` / `.field-grid` / `.form-footer` / `.primary-action` / `.secondary-action` / `.form-error` / `.is-success` / `.is-error` 等类名约定。

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/webview`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/webview webview test/webview
git commit -m "feat: add Nacos instance form panel with four auth modes"
```

---

## Task 12: 两棵树与命名空间层

**Files:**
- Create: `src/tree/NacosTreeItems.ts`, `src/tree/ConfigTreeProvider.ts`, `src/tree/ServiceTreeProvider.ts`
- Test: `test/tree/ConfigTreeProvider.test.ts`

- [ ] **Step 1: 写树的失败测试**

覆盖：

- 无实例时 `getChildren()` 返回**空数组**（这样 `viewsWelcome` 才会显示；返回任何节点都会抑制欢迎页）
- 有实例时根节点是 `InstanceTreeItem`，`collapsibleState` 为 `Collapsed`
- 展开实例返回 `NamespaceTreeItem` 列表
- 加载失败时返回 `ErrorTreeItem` 而不是抛异常（否则整棵树消失）
- 同一实例并发展开只触发一次网络请求（缓存的是 Promise 不是结果）
- `refresh()` 清空缓存并触发 `onDidChangeTreeData`
- 只读实例的 `InstanceTreeItem.contextValue` 带 `.readonly` 后缀，供 M5 的菜单 `when` 子句使用

- [ ] **Step 2: 运行确认失败，实现**

`NacosTreeItems.ts` 集中定义所有 TreeItem 子类，id 命名 `atNacos.<kind>:<instanceId>:<...>`，contextValue 命名 `atNacos.<kind>`（只读实例追加 `.readonly`）。

`ConfigTreeProvider` 与 `ServiceTreeProvider` 共享一个基类或共享的实例/命名空间层加载逻辑——两棵树的前两层完全相同，重复实现会在 M2/M3 分叉时产生不一致。建议抽 `NacosTreeBase`，子类只实现 `getNamespaceChildren()`。

M1 中两棵树展开到命名空间层为止，命名空间节点的 `collapsibleState` 设为 `Collapsed`，展开返回空数组（M2/M3 填充）。

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run test/tree`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/tree test/tree
git commit -m "feat: add config and service trees with instance and namespace levels"
```

---

## Task 13: package.json 贡献点与 extension.ts 组装

**Files:**
- Modify: `package.json`
- Create: `src/extension.ts`
- Create: `media/at-nacos-icon.png`, `media/at-nacos-icon.svg`, `media/at-nacos-activity.svg`
- Test: `test/extension.test.ts`

- [ ] **Step 1: 补全 package.json 的 contributes**

所有面向用户的字符串用 `%key%` 占位符指向 Task 3 的 nls 文件：

```json
{
  "name": "at-nacos",
  "displayName": "AT Nacos",
  "description": "%atNacos.description%",
  "version": "0.1.0",
  "publisher": "local",
  "license": "MIT",
  "icon": "media/at-nacos-icon.png",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "keywords": ["nacos", "config", "service-discovery", "microservices", "mcp", "at-series"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "l10n": "./l10n",
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "atNacos", "title": "%atNacos.viewsContainer.title%", "icon": "media/at-nacos-activity.svg" }
      ]
    },
    "views": {
      "atNacos": [
        { "id": "atNacos.configs", "name": "%atNacos.view.configs.name%" },
        { "id": "atNacos.services", "name": "%atNacos.view.services.name%" }
      ]
    },
    "commands": [
      { "command": "atNacos.addInstance", "title": "%atNacos.command.addInstance.title%", "icon": "$(add)" },
      { "command": "atNacos.manageInstances", "title": "%atNacos.command.manageInstances.title%", "icon": "$(gear)" },
      { "command": "atNacos.refreshConfigs", "title": "%atNacos.command.refreshConfigs.title%", "icon": "$(refresh)" },
      { "command": "atNacos.refreshServices", "title": "%atNacos.command.refreshServices.title%", "icon": "$(refresh)" }
    ],
    "menus": {
      "view/title": [
        { "command": "atNacos.addInstance", "when": "view == atNacos.configs", "group": "navigation@1" },
        { "command": "atNacos.refreshConfigs", "when": "view == atNacos.configs", "group": "navigation@2" },
        { "command": "atNacos.manageInstances", "when": "view == atNacos.configs", "group": "navigation@3" },
        { "command": "atNacos.refreshServices", "when": "view == atNacos.services", "group": "navigation@1" }
      ]
    },
    "viewsWelcome": [
      {
        "view": "atNacos.configs",
        "contents": "%atNacos.welcome.configs%"
      }
    ]
  },
  "scripts": {
    "build": "node esbuild.config.mjs",
    "watch": "node esbuild.config.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "copy:hub": "node scripts/copy-hub.mjs",
    "package": "npm run build && npm run copy:hub && node scripts/package.mjs"
  }
}
```

`atNacos.welcome.configs` 在两个 nls 文件里分别是英文与中文，值形如 `No Nacos instance configured.\n[Add Instance](command:atNacos.addInstance)`。

**注意**：`copy:hub` 与 `package` 脚本在 M6 才真正可用（`scripts/*.mjs` 那时才创建），M1 先写进去占位不会影响 `build` / `test`。

- [ ] **Step 2: 制作三个图标**

`media/at-nacos-activity.svg` 必须是单色描边、24×24 viewBox，VS Code 会用主题色重新着色。`media/at-nacos-icon.png` 为 128×128。

- [ ] **Step 3: 写 extension.ts 并做一次 typecheck**

`src/extension.ts` 是唯一的 composition root：创建 `LogOutputChannel` 与 `createRedactedLog`、`NacosInstanceConfigManager`、`NacosCertTrustStore`、两个 TreeProvider（注入 client 工厂）、注册四条命令与两个 TreeView，全部塞进 `context.subscriptions`。

client 工厂**每次调用都新建**（不跨编辑缓存），这样表单里改了地址或密码后，下一次树刷新立即生效：

```ts
async function createNacosClient(
  configManager: NacosInstanceConfigManager,
  instance: NacosInstanceConfig,
  certTrustStore: NacosCertTrustStore,
  log: AtNacosLog
): Promise<NacosClient> {
  const http = new NacosHttpClient({
    baseUrl: instance.serverUrl,
    certVerifier: createInteractiveCertVerifier(certTrustStore),
    log
  });
  const auth = await createAuthStrategy(instance, {
    http,
    getPassword: (id) => configManager.getPassword(id),
    getCustomHeaders: (id) => configManager.getCustomHeaders(id)
  });
  const authed = withAuth(http, auth);
  const state = await probeServerState(authed);
  const drivers = buildDriverChain(state.majorVersion, authed, instance.consoleUrl);
  return new NacosClient(new NacosCapabilityResolver(drivers, log), state);
}
```

`withAuth` 是一个薄包装：每次请求前取 `authHeaders()` 合并进 `options.headers`，捕获 `forbidden` 错误时调一次 `auth.refresh()` 并重试一次。**它必须是独立可测的**，放在 `src/nacos/auth/withAuth.ts`，并补一个测试覆盖「403 → refresh → 重试成功」与「403 → refresh → 仍 403 则抛出」两条路径。

Run: `npx tsc --noEmit`
Expected: 无输出

- [ ] **Step 4: 端到端手工验证**

```bash
npm run build
```

在 VS Code 中按 F5 启动扩展开发主机，然后：

1. 活动栏出现 AT Nacos 图标，两个视图显示欢迎页
2. 点「Add Instance」，填入真实 Nacos 地址与凭据，点「测试连接」→ 显示检测到的版本与单机/集群模式
3. 保存后树中出现实例节点，展开显示命名空间列表
4. 把 VS Code 语言切到中文（`Configure Display Language` → `zh-cn`）重启，确认命令标题、视图名、表单文案变成中文
5. 分别对 1.x / 2.x / 3.x 实例重复步骤 2-3
6. 打开输出面板的 `AT Nacos` 通道，确认日志中**没有明文密码或 accessToken**

- [ ] **Step 5: 提交**

```bash
git add package.json package.nls.json package.nls.zh-cn.json src/extension.ts src/nacos/auth/withAuth.ts media test
git commit -m "feat: wire extension entry point with trees, commands, and localized contributions"
```

---

## M1 验收标准

- [ ] `npx tsc --noEmit` 无错误
- [ ] `npx vitest run` 全部通过
- [ ] 能添加无鉴权、用户名密码、自定义请求头三种实例
- [ ] 「测试连接」正确报告服务端版本与单机/集群模式
- [ ] 1.x、2.x、3.x 三种服务端都能连上并列出命名空间
- [ ] 3.x 实例在未填 console 地址时能自动发现 console 端口（或在 admin 403 时给出可操作的错误提示）
- [ ] 界面语言随 VS Code 显示语言在中英间切换
- [ ] 输出通道日志中不含明文凭据
- [ ] 架构文档 §14 的不确定项已用真机验证结果回填

---

## 自查记录

对照架构文档逐节检查本计划的覆盖情况：

| 架构文档章节 | 覆盖任务 |
|---|---|
| §2 身份标识 | Task 1、Task 13 |
| §3 需求决策（只读开关、i18n、分页） | Task 3、Task 4（readOnly 字段）、Task 12（分页在 M2 落地） |
| §4 三个服务端事实 | Task 5（410/404 分类）、Task 7（探测）、Task 9（fallback 链） |
| §5 Driver 抽象 | Task 8、Task 9 |
| §6 参数名与响应形状差异 | Task 8（`normalize.ts`） |
| §7 鉴权 | Task 6 |
| §8 版本与 context-path 探测 | Task 7、Task 10 |
| §9 能力矩阵 | Task 8（M1 只用命名空间那一行） |
| §10 分页上限 | M2 落地，M1 不涉及 |
| §11 错误码 | Task 5 |
| §12 目录结构 | 全部任务 |
| §14 不确定项 | Task 9 Step 5 |

**已知缺口（有意推迟）**：AK/SK 策略在 Task 6 中显式抛「未实现」，表单不提供该选项；MCP 相关的 `src/mcp/**` 与 `scripts/*.mjs` 全部留到 M6；分页与懒加载随 M2 的配置树一起做。
