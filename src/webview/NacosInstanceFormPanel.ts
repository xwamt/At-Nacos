import * as vscode from 'vscode';
import { z } from 'zod';
import type {
  NacosInstanceConfigManager,
  NacosInstanceSecrets
} from '../config/NacosInstanceConfigManager';
import type { NacosAuthMode, NacosInstanceConfig } from '../config/schema';
import { buildWebviewStrings, t } from '../i18n/t';
import {
  testNacosConnection,
  type NacosConnectionTestOptions,
  type NacosConnectionTestResult,
  type NacosConnectionTestSuccess
} from '../nacos/testNacosConnection';
import { formatError } from '../utils/errors';
import { escapeAttr, renderWebviewHtml } from './html';

/**
 * The modes the form offers, which is every mode M1 can actually perform.
 * `akSk` is storable -- the config schema accepts it, so a later milestone can
 * add it without a migration -- but `createAuthStrategy` throws on it today,
 * and an instance the user cannot connect with is worse than one they cannot
 * create. The `satisfies` keeps this list a subset of what the schema allows.
 */
export const NACOS_FORM_AUTH_MODES = [
  'none',
  'userPassword',
  'customHeader'
] as const satisfies readonly NacosAuthMode[];

export type NacosFormAuthMode = (typeof NACOS_FORM_AUTH_MODES)[number];

export type InstanceFormConfigManager = Pick<
  NacosInstanceConfigManager,
  'createInstance' | 'updateInstance' | 'getPassword' | 'getCustomHeaders'
>;

export interface InstanceFormMessageOptions {
  /** A seam for tests, and for Task 13 to hand the probe a cert verifier and a log. */
  testConnection?: (options: NacosConnectionTestOptions) => Promise<NacosConnectionTestResult>;
}

export type CustomHeaderParseResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; message: string };

export interface RenderInstanceFormOptions {
  existing?: NacosInstanceConfig;
  hasStoredPassword?: boolean;
  hasStoredHeaders?: boolean;
}

export interface InstanceFormView {
  /** The `<main>` the page is built from. */
  body: string;
  /** Keyed by element id, serialized into the page by `renderWebviewHtml`. */
  data: Record<string, unknown>;
}

/**
 * What the page posts. Parsed rather than cast: this arrives from a renderer
 * process, which can send anything, and the fields feed a credential store.
 *
 * Every field is required. The page and this module ship in one bundle and
 * cannot disagree about the shape, so a payload missing a field is not an
 * older client -- it is a message nobody in this extension wrote.
 */
const instanceFormPayloadSchema = z
  .object({
    label: z.string(),
    serverUrl: z.string(),
    consoleUrl: z.string(),
    authMode: z.enum(NACOS_FORM_AUTH_MODES),
    username: z.string(),
    password: z.string(),
    /** The raw textarea, parsed by `parseCustomHeaders` once the mode is known. */
    customHeaders: z.string(),
    readOnly: z.boolean(),
    allowBackgroundAccess: z.boolean()
  })
  .strip();

type InstanceFormPayload = z.infer<typeof instanceFormPayloadSchema>;

/** RFC 9110 token: what a header name may contain before the HTTP stack rejects it. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export class NacosInstanceFormPanel {
  static async open(
    context: vscode.ExtensionContext,
    configManager: NacosInstanceConfigManager,
    onSaved: () => void,
    existing?: NacosInstanceConfig,
    options: InstanceFormMessageOptions = {}
  ): Promise<void> {
    // Before the panel exists, deliberately. SecretStorage can refuse, and a
    // caller that reports that error is better than an empty panel that never
    // gets its HTML.
    const view = renderInstanceForm({
      existing,
      hasStoredPassword: existing ? Boolean(await configManager.getPassword(existing.id)) : false,
      hasStoredHeaders: existing ? hasEntries(await configManager.getCustomHeaders(existing.id)) : false
    });

    const panel = vscode.window.createWebviewPanel(
      'atNacos.instanceForm',
      instanceFormTitle(existing),
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [context.extensionUri] }
    );
    panel.webview.html = renderWebviewHtml(
      panel.webview,
      {
        script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'nacos-instance-form.js'),
        style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'nacos-instance-form', 'index.css')
      },
      view.body,
      view.data
    );

    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      await handleInstanceFormMessage(message, existing, configManager, onSaved, panel, options);
    });
  }
}

/**
 * Everything the panel does with a message from the page, as a function of its
 * arguments: the class above is only the wiring. Returns whether the message
 * was one this form owns.
 *
 * It resolves rather than throwing, always. A rejection here surfaces as an
 * unhandled promise in the extension host, while the page sits on "Saving..."
 * with no way to find out what happened.
 */
export async function handleInstanceFormMessage(
  message: unknown,
  existing: NacosInstanceConfig | undefined,
  configManager: InstanceFormConfigManager,
  onSaved: () => void,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>,
  options: InstanceFormMessageOptions = {}
): Promise<boolean> {
  const type = messageType(message);
  if (type !== 'submit' && type !== 'testConnection') {
    return false;
  }

  const parsed = instanceFormPayloadSchema.safeParse((message as { payload?: unknown }).payload);
  if (!parsed.success) {
    // Deliberately not the validation detail: the only ways to get here are a
    // crafted message and a bug in our own page, and neither is something the
    // user can act on. `authMode: 'akSk'` lands here too.
    await postError(panel, t('This form sent a value AT Nacos could not read. Reload the panel and try again.'));
    return true;
  }

  if (type === 'testConnection') {
    await runConnectionTest(parsed.data, existing, configManager, panel, options);
    return true;
  }

  try {
    await saveInstance(parsed.data, existing, configManager, onSaved, panel);
  } catch (error) {
    await postError(panel, formatError(error));
  }
  return true;
}

async function saveInstance(
  payload: InstanceFormPayload,
  existing: NacosInstanceConfig | undefined,
  configManager: InstanceFormConfigManager,
  onSaved: () => void,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>
): Promise<void> {
  const label = payload.label.trim();
  if (!label) {
    await postError(panel, t('Label is required.'));
    return;
  }
  const addressError = validateAddress(payload);
  if (addressError) {
    await postError(panel, addressError);
    return;
  }

  const credentials = await resolveCredentials(payload, existing, configManager);
  if (!credentials.ok) {
    await postError(panel, credentials.message);
    return;
  }

  const fields = {
    label,
    serverUrl: payload.serverUrl.trim(),
    consoleUrl: payload.consoleUrl.trim() || undefined,
    authMode: payload.authMode,
    username: payload.username.trim() || undefined,
    readOnly: payload.readOnly,
    allowBackgroundAccess: payload.allowBackgroundAccess
  };

  if (existing) {
    await configManager.updateInstance(existing.id, fields, credentials.secrets);
  } else {
    await configManager.createInstance({ ...fields, ...credentials.secrets });
  }
  // Closed before the callback, not after. The instance is written by now, so
  // a refresh that throws must not leave the form open reporting a failure --
  // the next Save would write a second instance.
  panel.dispose();
  onSaved();
}

type CredentialResolution = { ok: true; secrets: NacosInstanceSecrets } | { ok: false; message: string };

/**
 * Turns what the form is holding into what the store should keep.
 *
 * Both credentials follow the same three-way rule, which is the convention
 * every AT Series plugin shares: a value typed in replaces what is stored,
 * `undefined` keeps it, and the empty form of the value ("" or {}) clears it.
 *
 * Clearing is what a mode change triggers. A password the user can no longer
 * reach from any setting has no reason to stay in SecretStorage, and on a new
 * instance there is nothing to clear, so the write is skipped entirely.
 */
async function resolveCredentials(
  payload: InstanceFormPayload,
  existing: NacosInstanceConfig | undefined,
  configManager: InstanceFormConfigManager
): Promise<CredentialResolution> {
  const secrets: NacosInstanceSecrets = {};

  if (payload.authMode === 'userPassword') {
    if (!payload.username.trim()) {
      return { ok: false, message: t('A username is required for username and password authentication.') };
    }
    // Not trimmed: trailing whitespace can be part of a password, and silently
    // dropping it would store a credential the user never typed. Only the
    // empty string means "keep the stored one".
    const stored = existing ? await configManager.getPassword(existing.id) : undefined;
    if (payload.password === '' && !stored) {
      return { ok: false, message: t('A password is required for username and password authentication.') };
    }
    secrets.password = payload.password === '' ? undefined : payload.password;
  } else {
    secrets.password = existing ? '' : undefined;
  }

  if (payload.authMode === 'customHeader') {
    const parsed = parseCustomHeaders(payload.customHeaders);
    if (!parsed.ok) {
      return { ok: false, message: parsed.message };
    }
    const stored = existing ? await configManager.getCustomHeaders(existing.id) : undefined;
    if (!hasEntries(parsed.headers) && !hasEntries(stored)) {
      return { ok: false, message: t('At least one custom header is required for custom header authentication.') };
    }
    secrets.customHeaders = hasEntries(parsed.headers) ? parsed.headers : undefined;
  } else {
    secrets.customHeaders = existing ? {} : undefined;
  }

  return { ok: true, secrets };
}

/**
 * Probes the server with what the form is holding and saves nothing. The whole
 * point of the button is to answer a question before committing to it.
 */
async function runConnectionTest(
  payload: InstanceFormPayload,
  existing: NacosInstanceConfig | undefined,
  configManager: InstanceFormConfigManager,
  panel: Pick<vscode.WebviewPanel, 'webview'>,
  options: InstanceFormMessageOptions
): Promise<void> {
  let outcome: TestOutcome;
  try {
    outcome = await probeWithFormValues(payload, existing, configManager, options);
  } catch (error) {
    // `testNacosConnection` promises never to reject, but reading a stored
    // credential can, and so can the seam tests inject. A page left spinning
    // on "Testing connection..." is the one outcome with nothing to read.
    outcome = { ok: false, message: formatError(error) };
  }
  await postTestResult(panel, outcome);
}

interface TestOutcome {
  ok: boolean;
  message: string;
  /**
   * The console address the probe discovered, for the page to write into the
   * field the user left blank. Present only when there is something to fill:
   * what the user typed is not sent back to them.
   */
  consoleUrl?: string;
}

async function probeWithFormValues(
  payload: InstanceFormPayload,
  existing: NacosInstanceConfig | undefined,
  configManager: InstanceFormConfigManager,
  options: InstanceFormMessageOptions
): Promise<TestOutcome> {
  const addressError = validateAddress(payload);
  if (addressError) {
    return { ok: false, message: addressError };
  }

  let customHeaders: Record<string, string> | undefined;
  if (payload.authMode === 'customHeader') {
    const parsed = parseCustomHeaders(payload.customHeaders);
    if (!parsed.ok) {
      // Probing with the headers that did parse would test a request the
      // instance will never send.
      return { ok: false, message: parsed.message };
    }
    customHeaders = hasEntries(parsed.headers)
      ? parsed.headers
      : existing
        ? await configManager.getCustomHeaders(existing.id)
        : undefined;
  }

  // What the user is testing is usually a credential they have just typed, so
  // the form wins over the store. Blank is not "no password", though -- it is
  // the same "keep what is saved" the save path reads it as, and testing a
  // credential the instance would not send is not testing the instance.
  let password: string | undefined;
  if (payload.authMode === 'userPassword') {
    password = payload.password || (existing ? await configManager.getPassword(existing.id) : undefined);
  }

  const probe = options.testConnection ?? testNacosConnection;
  const result = await probe({
    serverUrl: payload.serverUrl.trim(),
    consoleUrl: payload.consoleUrl.trim() || undefined,
    authMode: payload.authMode,
    username: payload.username.trim() || undefined,
    password,
    customHeaders
  });
  return result.ok
    ? {
        ok: true,
        message: describeSuccess(result, payload.authMode),
        // Naming the console in the success sentence and then dropping it is
        // how the discovery used to get lost: the instance is saved with
        // whatever the field holds, and a 3.x instance saved without a console
        // address has no fallback for the 403 an ordinary account gets from
        // the v3 admin API.
        consoleUrl: payload.consoleUrl.trim() ? undefined : result.consoleUrl
      }
    : // English, and left that way: these sentences are assembled from the
      // address, the status and the server's own words, so there is no source
      // string to key a translation on. Localizing them means rebuilding them
      // from `NacosConnectionTestFailure`'s structured fields, which belongs
      // to whoever owns that module.
      { ok: false, message: result.message };
}

function describeSuccess(result: NacosConnectionTestSuccess, authMode: NacosFormAuthMode): string {
  const sentences = [
    t('Connected to Nacos {version} ({mode}).', {
      version: result.version,
      mode: describeStartupMode(result.startupMode)
    })
  ];
  if (result.consoleUrl) {
    sentences.push(t('Its console is at {consoleUrl}.', { consoleUrl: result.consoleUrl }));
  }
  if (result.authEnabled && authMode === 'none') {
    // The state endpoint can be readable anonymously on a server whose data is
    // not, so a green result here would otherwise promise more than it checked.
    sentences.push(t('This server has authentication enabled, but this instance sends no credentials.'));
  }
  return sentences.join(' ');
}

function describeStartupMode(mode: NacosConnectionTestSuccess['startupMode']): string {
  switch (mode) {
    case 'standalone':
      return t('standalone mode');
    case 'cluster':
      return t('cluster mode');
    default:
      return t('startup mode not reported');
  }
}

/** The two address fields, checked together because both are typed as one. */
function validateAddress(payload: InstanceFormPayload): string | undefined {
  if (!isHttpUrl(payload.serverUrl.trim())) {
    return t('A valid Nacos server URL is required.');
  }
  const consoleUrl = payload.consoleUrl.trim();
  if (consoleUrl && !isHttpUrl(consoleUrl)) {
    return t('The console URL must start with http:// or https://.');
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Reads the header textarea, one `Name: value` per line.
 *
 * A malformed line is an error rather than a line to skip. Skipping it would
 * send the request without the credential and leave the user reading a 403
 * about a token that never left the machine.
 */
export function parseCustomHeaders(text: string): CustomHeaderParseResult {
  // Keyed by lowercase name because HTTP header names are case-insensitive:
  // `Authorization` and `authorization` are one header, and keeping both would
  // put two of it on the wire for the server to choose between. The later line
  // wins, spelling included -- it is what the user typed last.
  const byName = new Map<string, { name: string; value: string }>();

  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    // The first colon only: a value may hold one, as `X-Target: host:8848`
    // does. Position zero is an empty name, which is the same mistake as no
    // colon at all.
    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      return {
        ok: false,
        message: t('Custom header line {line} must be written as "Name: value".', { line: index + 1 })
      };
    }
    const name = trimmed.slice(0, separator).trim();
    if (!HEADER_NAME_PATTERN.test(name)) {
      // The HTTP stack would reject this at request time, a long way from the
      // field that caused it.
      return { ok: false, message: t('"{name}" is not a valid HTTP header name.', { name }) };
    }
    // An empty value is legal, and rejecting it would be this form inventing a
    // rule HTTP does not have.
    byName.set(name.toLowerCase(), { name, value: trimmed.slice(separator + 1).trim() });
  }

  const headers: Record<string, string> = {};
  for (const { name, value } of byName.values()) {
    headers[name] = value;
  }
  return { ok: true, headers };
}

export function renderInstanceForm(options: RenderInstanceFormOptions = {}): InstanceFormView {
  const { existing, hasStoredPassword = false, hasStoredHeaders = false } = options;
  const submitLabel = existing ? t('Save Instance') : t('Add Instance');
  const authMode = renderedAuthMode(existing);

  const body = `<main class="instance-form-shell">
  <header class="form-header">
    <div>
      <h1>${escapeAttr(instanceFormTitle(existing))}</h1>
      <p>${escapeAttr(t('Connect AT Nacos to a Nacos server. Nacos 1.x, 2.x and 3.x are supported.'))}</p>
    </div>
  </header>
  <form id="instance-form" class="instance-form auth-mode-${escapeAttr(authMode)}">
    <div class="form-panel">
      <div class="field-grid">
        <label class="field-stack">${escapeAttr(t('Label'))}
          <input name="label" value="${escapeAttr(existing?.label ?? '')}" required autocomplete="off">
        </label>
        <label class="field-stack">${escapeAttr(t('Server URL'))}
          <input name="serverUrl" type="url" value="${escapeAttr(existing?.serverUrl ?? '')}" placeholder="http://nacos.example.com:8848/nacos" required autocomplete="off">
          <span class="field-help">${escapeAttr(t('Include the context path if the server has one, usually /nacos.'))}</span>
        </label>
        <label class="field-stack field-wide">${escapeAttr(t('Console URL (Nacos 3.x, optional)'))}
          <input name="consoleUrl" type="url" value="${escapeAttr(existing?.consoleUrl ?? '')}" placeholder="http://nacos.example.com:8080" autocomplete="off">
          <span class="field-help">${escapeAttr(t('Nacos 3.x serves its console from a port of its own. Leave this blank to detect it.'))}</span>
        </label>
      </div>
    </div>
    <div class="form-panel">
      <div class="field-grid">
        <label class="field-stack field-wide">${escapeAttr(t('Authentication'))}
          <select id="authMode" name="authMode">
            ${renderAuthOptions(authMode)}
          </select>
        </label>
        <label class="field-stack auth-user-password-field">${escapeAttr(t('Username'))}
          <input name="username" value="${escapeAttr(existing?.username ?? '')}" autocomplete="off">
        </label>
        <label class="field-stack auth-user-password-field">${escapeAttr(t('Password'))}
          <input name="password" type="password" autocomplete="new-password">
          <span class="field-help">${escapeAttr(
            hasStoredPassword
              ? t('Leave blank to keep the saved password.')
              : t('Kept in VS Code SecretStorage, never in settings.')
          )}</span>
        </label>
        <label class="field-stack field-wide auth-custom-header-field">${escapeAttr(t('Custom headers'))}
          <textarea name="customHeaders" rows="4" spellcheck="false" autocomplete="off" placeholder="Authorization: Bearer ..."></textarea>
          <span class="field-help">${escapeAttr(
            hasStoredHeaders
              ? t('Leave blank to keep the saved headers.')
              : t('One per line, written as "Name: value".')
          )}</span>
        </label>
      </div>
    </div>
    <div class="form-panel">
      <div class="toggle-grid">
        <label class="toggle-row" for="readOnly">
          <span class="toggle-copy">
            <span class="toggle-title">${escapeAttr(t('Read-only instance'))}</span>
            <span class="field-help">${escapeAttr(t('Hides every action that would write to this server.'))}</span>
          </span>
          <input id="readOnly" name="readOnly" type="checkbox"${existing?.readOnly ? ' checked' : ''}>
        </label>
        <label class="toggle-row" for="allowBackgroundAccess">
          <span class="toggle-copy">
            <span class="toggle-title">${escapeAttr(t('Allow Agent background access'))}</span>
            <span class="field-help">${escapeAttr(
              t('Lets Agents read this instance over MCP even when no panel is open.')
            )}</span>
          </span>
          <input id="allowBackgroundAccess" name="allowBackgroundAccess" type="checkbox"${
            existing?.allowBackgroundAccess ? ' checked' : ''
          }>
        </label>
      </div>
    </div>
    <footer class="form-footer">
      <div class="form-feedback">
        <div id="form-error" class="form-error" role="status" aria-live="polite"></div>
        <div id="testStatus" class="test-status" role="status" aria-live="polite"></div>
      </div>
      <div class="form-actions">
        <button id="testConnectionButton" class="secondary-action" type="button">${escapeAttr(t('Test Connection'))}</button>
        <button id="submitButton" class="primary-action" type="submit">
          <span id="submitLabel">${escapeAttr(submitLabel)}</span>
        </button>
      </div>
    </footer>
  </form>
</main>`;

  return {
    body,
    // The page renders these itself, so they have to be translated here --
    // `vscode.l10n` exists only in the extension host. `renderWebviewHtml`
    // serializes and escapes them.
    data: {
      atNacosStrings: buildWebviewStrings({
        submit: existing ? 'Save Instance' : 'Add Instance',
        saving: 'Saving...',
        testConnection: 'Test Connection',
        testing: 'Testing connection...',
        unknownError: 'Something went wrong.'
      })
    }
  };
}

const AUTH_MODE_LABELS: Record<NacosFormAuthMode, string> = {
  none: 'No authentication',
  userPassword: 'Username and password',
  customHeader: 'Custom headers'
};

function renderAuthOptions(selected: NacosFormAuthMode): string {
  return NACOS_FORM_AUTH_MODES.map(
    (mode) =>
      `<option value="${mode}"${mode === selected ? ' selected' : ''}>${escapeAttr(t(AUTH_MODE_LABELS[mode]))}</option>`
  ).join('\n            ');
}

/**
 * A stored mode this version has no option for falls back to anonymous rather
 * than leaving the select with nothing selected -- a select in that state
 * submits its first option anyway, so the fallback may as well be visible.
 */
function renderedAuthMode(existing: NacosInstanceConfig | undefined): NacosFormAuthMode {
  const stored = existing?.authMode;
  return NACOS_FORM_AUTH_MODES.find((mode) => mode === stored) ?? 'none';
}

function instanceFormTitle(existing: NacosInstanceConfig | undefined): string {
  return existing ? t('Edit Nacos Instance: {label}', { label: existing.label }) : t('Add Nacos Instance');
}

function messageType(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const { type } = message as { type?: unknown };
  return typeof type === 'string' ? type : undefined;
}

function hasEntries(record: Record<string, string> | undefined): boolean {
  return record !== undefined && Object.keys(record).length > 0;
}

async function postError(panel: Pick<vscode.WebviewPanel, 'webview'>, message: string): Promise<void> {
  await post(panel, { type: 'error', payload: message });
}

async function postTestResult(panel: Pick<vscode.WebviewPanel, 'webview'>, payload: TestOutcome): Promise<void> {
  await post(panel, { type: 'connectionTestResult', payload });
}

/**
 * Every reply to the page goes through here, and a failed one is dropped.
 *
 * The reply is a UI update, and the only way it fails is that the panel closed
 * while the work was in flight -- so there is nothing to report it to and
 * nothing for the user to do. Letting it propagate would turn closing a panel
 * during a connection test into an unhandled rejection in the extension host.
 */
async function post(panel: Pick<vscode.WebviewPanel, 'webview'>, message: unknown): Promise<void> {
  try {
    await panel.webview.postMessage(message);
  } catch {
    // The page is gone. So is anyone who could have read this.
  }
}
