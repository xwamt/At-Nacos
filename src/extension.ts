import * as vscode from 'vscode';
import { NacosInstanceConfigManager } from './config/NacosInstanceConfigManager';
import type { NacosInstanceConfig } from './config/schema';
import { t } from './i18n/t';
import { NacosCapabilityResolver } from './nacos/NacosCapabilityResolver';
import { NacosCertTrustStore } from './nacos/NacosCertTrustStore';
import { NacosClient, buildChainAdvice, buildDriverChain } from './nacos/NacosClient';
import { NacosHttpClient } from './nacos/NacosHttpClient';
import { createAuthStrategy } from './nacos/auth/createAuthStrategy';
import { withAuth } from './nacos/auth/withAuth';
import { createInteractiveCertVerifier } from './nacos/createInteractiveCertVerifier';
import { probeServerState } from './nacos/probe/probeServerState';
import { CONSOLE_MAJOR_VERSION, discoverConsoleBaseUrl } from './nacos/probe/resolveBaseUrl';
import { testNacosConnection } from './nacos/testNacosConnection';
import { ConfigTreeProvider } from './tree/ConfigTreeProvider';
import type { NacosTreeItem } from './tree/NacosTreeItems';
import { ServiceTreeProvider } from './tree/ServiceTreeProvider';
import { formatError } from './utils/errors';
import { createRedactedLog, type AtNacosLog } from './utils/logger';
import { NacosInstanceFormPanel } from './webview/NacosInstanceFormPanel';

/** What `deactivate` awaits. Replaced on every `activate`; see the doc on `cleanup`. */
let extensionCleanup: { dispose(): Promise<void> } | undefined;

/** Opens the instance form, for a new instance or an existing one. */
type OpenInstanceForm = (existing?: NacosInstanceConfig) => Promise<void>;

/**
 * Builds a client for one instance: an HTTP client, an authentication
 * strategy wrapped around it, a version probe, and the driver chain that
 * probe selects.
 *
 * Fresh on every call, deliberately, which is what makes an edit in the
 * instance form take effect on the very next tree refresh instead of leaving
 * the tree talking to the old address with the old credential until the
 * window is reloaded. The tree providers cache the data they fetch, not the
 * clients that fetched it.
 *
 * The cost of that choice is one login (for the userPassword mode) and one
 * `/state` round trip per refresh per instance, because neither the token nor
 * the probed version outlives the client that holds them. Caching either one
 * means owning its invalidation -- an edited instance, a rotated password, a
 * server upgraded in place -- which is a larger decision than this milestone
 * needs to make.
 *
 * Exported so the wiring can be tested against a real HTTP server rather than
 * inferred from `activate`.
 */
export async function createNacosClient(
  configManager: Pick<NacosInstanceConfigManager, 'getPassword' | 'getCustomHeaders'>,
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
  // Everything above the transport talks to the authenticated wrapper, the
  // probe included: a secured Nacos refuses `/state` too, and a probe that
  // sent no credential would report the server as unreachable.
  const authed = withAuth(http, auth);
  const state = await probeServerState(authed);
  const consoleBaseUrl = await resolveConsoleBaseUrl(instance, state.majorVersion, authed);
  const drivers = buildDriverChain(state.majorVersion, authed, consoleBaseUrl);
  const resolver = new NacosCapabilityResolver(drivers, log, buildChainAdvice(state.majorVersion, consoleBaseUrl));
  return new NacosClient(resolver, state);
}

/**
 * The console address to build the chain from: what the instance carries, or
 * what the server will admit to when it carries none.
 *
 * Asking here rather than only in the connection test is what makes a blank
 * console field survive being saved. §4.3: `nacos.core.auth.admin.enabled`
 * defaults to true and most `/v3/admin/*` endpoints want an administrator, so
 * an ordinary account gets 403 and needs the console endpoint to drop to --
 * and a chain built without a console address does not have one. The
 * connection test discovers exactly this and shows it, but only the saved
 * field reaches the tree, and the tree is where the 403 happens.
 *
 * One extra request, on 3.x instances with the field left blank only, and the
 * connection test writes its answer back into that field -- so an instance the
 * user tested before saving never pays it again. 1.x and 2.x serve their
 * console from the same port and are not asked at all.
 */
async function resolveConsoleBaseUrl(
  instance: NacosInstanceConfig,
  majorVersion: number,
  authed: Pick<NacosHttpClient, 'requestRaw'>
): Promise<string | undefined> {
  if (instance.consoleUrl) {
    return instance.consoleUrl;
  }
  if (majorVersion < CONSOLE_MAJOR_VERSION) {
    return undefined;
  }
  return discoverConsoleBaseUrl(authed, instance.serverUrl);
}

/**
 * The one composition root. Every collaborator in this extension is built
 * here and handed its dependencies rather than reaching for a global, which
 * is what keeps the config, HTTP, auth, driver and probe layers testable
 * without a VS Code host: outside this file, only the UI modules (the tree,
 * the Webview, the certificate prompt) and the two thin adapters (`i18n/t`,
 * `utils/notifications`) import `vscode` at all.
 */
export function activate(context: vscode.ExtensionContext): void {
  // A `LogOutputChannel` rather than a plain one: VS Code then owns the level
  // (Output panel gear / `Developer: Set Log Level...`) and stamps each line,
  // so the extension contributes no setting of its own for it. Everything
  // below writes through `createRedactedLog`, which is the only thing allowed
  // to hand text to this channel -- see src/utils/logger.ts.
  const logChannel = vscode.window.createOutputChannel('AT Nacos', { log: true });
  const log = createRedactedLog(logChannel);

  const configManager = new NacosInstanceConfigManager(context.globalState, context.secrets, log);
  const certTrustStore = new NacosCertTrustStore(context.globalState, log);

  const configTreeProvider = new ConfigTreeProvider(configManager, (instance) =>
    createNacosClient(configManager, instance, certTrustStore, log)
  );
  const serviceTreeProvider = new ServiceTreeProvider(configManager, (instance) =>
    createNacosClient(configManager, instance, certTrustStore, log)
  );
  // Both trees, always: an instance is a root node in each of them, so a save
  // or a delete that redrew only one would leave the other showing a server
  // that no longer exists.
  const refreshTreeViews = (): void => {
    configTreeProvider.refresh();
    serviceTreeProvider.refresh();
  };

  const openInstanceForm: OpenInstanceForm = (existing) =>
    NacosInstanceFormPanel.open(context, configManager, refreshTreeViews, existing, {
      // The form's default probe constructs its own client with neither a
      // certificate verifier nor a log, so without this seam Test Connection
      // would refuse every self-signed certificate that the tree, going
      // through `createNacosClient`, is able to prompt for and trust.
      testConnection: (options) =>
        testNacosConnection({
          ...options,
          certVerifier: createInteractiveCertVerifier(certTrustStore),
          log
        })
    });

  // Both instance commands report their own failures. They are user-initiated
  // actions with no other surface to fail on -- unlike the tree, which renders
  // a failure as an error node -- and `listInstances` really does throw when a
  // stored record no longer parses.
  const addInstanceCommand = vscode.commands.registerCommand('atNacos.addInstance', async () => {
    try {
      await openInstanceForm();
    } catch (error) {
      const message = formatError(error);
      log.error(`addInstance: ${message}`);
      await vscode.window.showErrorMessage(t('Could not open the Nacos instance form: {message}', { message }));
    }
  });

  const manageInstancesCommand = vscode.commands.registerCommand('atNacos.manageInstances', async () => {
    try {
      await manageInstances(configManager, openInstanceForm, refreshTreeViews);
    } catch (error) {
      const message = formatError(error);
      log.error(`manageInstances: ${message}`);
      await vscode.window.showErrorMessage(t('Could not manage Nacos instances: {message}', { message }));
    }
  });

  const configTreeView = vscode.window.createTreeView<NacosTreeItem>('atNacos.configs', {
    treeDataProvider: configTreeProvider
  });
  // The active filter is reported on the view's message line, and only the
  // view owns that. Without this the tree would filter itself silently, which
  // reads as a server that has lost half its configurations.
  configTreeProvider.attachTreeView(configTreeView);
  const serviceTreeView = vscode.window.createTreeView<NacosTreeItem>('atNacos.services', {
    treeDataProvider: serviceTreeProvider
  });

  const refreshConfigsCommand = vscode.commands.registerCommand('atNacos.refreshConfigs', () => {
    configTreeProvider.refresh();
  });
  const refreshServicesCommand = vscode.commands.registerCommand('atNacos.refreshServices', () => {
    serviceTreeProvider.refresh();
  });

  const filterConfigsCommand = vscode.commands.registerCommand('atNacos.filterConfigs', async () => {
    const typed = await vscode.window.showInputBox({
      prompt: t('Filter configurations by data ID'),
      placeHolder: t('e.g. application-uat'),
      // Prefilled, so that narrowing an existing filter is an edit rather than
      // a retype.
      value: configTreeProvider.getFilter() ?? ''
    });
    // Undefined is Escape and has to leave the current filter alone. An empty
    // string is not the same gesture: that is a deliberate "show all again".
    if (typed !== undefined) {
      configTreeProvider.setFilter(typed);
    }
  });
  const clearConfigFilterCommand = vscode.commands.registerCommand('atNacos.clearConfigFilter', () => {
    configTreeProvider.clearFilter();
  });

  // VS Code awaits the promise `deactivate()` returns. It does NOT await the
  // `dispose()` of anything in `context.subscriptions` -- it calls each one and
  // moves on. Nothing in this milestone needs that guarantee: the channel, the
  // two views and the four commands all dispose synchronously, so they are
  // pushed below. The seam exists anyway, and is guarded against a second
  // call, because the shutdown steps that do need awaiting arrive later -- the
  // MCP bridge has to finish unpublishing its registry record or the Hub pays
  // a failed connection to a dead port on every later refresh.
  let disposed = false;
  const cleanup = {
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      if (extensionCleanup === cleanup) {
        extensionCleanup = undefined;
      }
      log.info('deactivate: AT Nacos shut down');
    }
  };
  extensionCleanup = cleanup;

  context.subscriptions.push(
    logChannel,
    addInstanceCommand,
    manageInstancesCommand,
    configTreeView,
    serviceTreeView,
    refreshConfigsCommand,
    refreshServicesCommand,
    filterConfigsCommand,
    clearConfigFilterCommand
  );
}

async function manageInstances(
  configManager: Pick<NacosInstanceConfigManager, 'listInstances' | 'deleteInstance'>,
  openInstanceForm: OpenInstanceForm,
  onChanged: () => void
): Promise<void> {
  const instances = await configManager.listInstances();
  if (instances.length === 0) {
    // Resolved before the prompt, as every localized action label below is:
    // the comparison has to be against the same string the user clicked.
    const addAction = t('Add Instance');
    const answer = await vscode.window.showInformationMessage(t('No Nacos instances configured yet.'), addAction);
    if (answer === addAction) {
      await openInstanceForm();
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    instances.map((instance) => ({
      label: instance.label,
      description: instance.serverUrl,
      instance
    })),
    { placeHolder: t('Select a Nacos instance to edit or delete') }
  );
  if (!picked) {
    return;
  }

  const editAction = t('Edit');
  const deleteAction = t('Delete');
  const action = await vscode.window.showQuickPick([editAction, deleteAction], {
    placeHolder: picked.instance.label
  });
  if (action === editAction) {
    await openInstanceForm(picked.instance);
    return;
  }
  if (action === deleteAction) {
    await deleteInstanceWithConfirmation(configManager, picked.instance, onChanged);
  }
}

/**
 * Modal, because deleting an instance also deletes its stored password or
 * headers and nothing in this extension can put them back.
 */
async function deleteInstanceWithConfirmation(
  configManager: Pick<NacosInstanceConfigManager, 'deleteInstance'>,
  instance: NacosInstanceConfig,
  onChanged: () => void
): Promise<void> {
  const deleteAction = t('Delete');
  const answer = await vscode.window.showWarningMessage(
    t('Delete Nacos instance "{label}"?', { label: instance.label }),
    { modal: true },
    deleteAction
  );
  if (answer === deleteAction) {
    await configManager.deleteInstance(instance.id);
    onChanged();
  }
}

/** Async because VS Code awaits what this returns; see the `cleanup` doc in `activate`. */
export async function deactivate(): Promise<void> {
  await extensionCleanup?.dispose();
}
