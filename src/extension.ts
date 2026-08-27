import * as vscode from 'vscode';
import { detectHostApp } from '@at-series/mcp-hub';
import { NacosAgentToolService } from './agent/NacosAgentToolService';
import { BridgeServer } from './mcp/BridgeServer';
import { syncPackagedHub } from './mcp/hubSync';
import {
  ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde
} from './mcp/McpConfigInstaller';
import { NacosInstanceConfigManager } from './config/NacosInstanceConfigManager';
import type { NacosInstanceConfig } from './config/schema';
import { NACOS_CONFIG_SCHEME } from './document/configUri';
import { NACOS_DRAFT_SCHEME, parseDraftUri } from './document/draftUri';
import {
  compareConfigAcrossEnvironments,
  diffWithPreviousVersion,
  openConfigVersionDiff
} from './document/diffConfig';
import { NacosConfigDocumentProvider } from './document/NacosConfigDocumentProvider';
import { NacosDraftFileSystemProvider } from './document/NacosDraftFileSystemProvider';
import { openConfigDocument } from './document/openConfigDocument';
import { openDraftDocument } from './document/openDraftDocument';
import { deleteConfig } from './write/deleteConfig';
import { publishConfig } from './write/publishConfig';
import { rollbackConfig } from './write/rollbackConfig';
import { toggleServiceInstanceEnabled } from './write/updateInstanceHealth';
import { t } from './i18n/t';
import { NacosCapabilityResolver } from './nacos/NacosCapabilityResolver';
import { NacosCertTrustStore } from './nacos/NacosCertTrustStore';
import { NacosClient, buildChainAdvice, buildDriverChain } from './nacos/NacosClient';
import { NacosClientPool } from './nacos/NacosClientPool';
import { NacosHttpClient } from './nacos/NacosHttpClient';
import { createAuthStrategy } from './nacos/auth/createAuthStrategy';
import { withAuth } from './nacos/auth/withAuth';
import { createInteractiveCertVerifier } from './nacos/createInteractiveCertVerifier';
import { probeServerState } from './nacos/probe/probeServerState';
import { CONSOLE_MAJOR_VERSION, discoverConsoleBaseUrl } from './nacos/probe/resolveBaseUrl';
import type { NacosConfigRef, NacosConfigSummary } from './nacos/driver/normalize';
import { testNacosConnection } from './nacos/testNacosConnection';
import { ConfigTreeProvider } from './tree/ConfigTreeProvider';
import {
  GroupTreeItem,
  LOAD_MORE_CONFIGS_COMMAND,
  LOAD_MORE_SERVICES_COMMAND,
  NamespaceTreeItem,
  OPEN_CONFIG_COMMAND,
  type ConfigTreeItem,
  type NacosTreeItem,
  type ServiceInstanceTreeItem,
  type ServiceTreeItem
} from './tree/NacosTreeItems';
import { ServiceTreeProvider } from './tree/ServiceTreeProvider';
import { formatError } from './utils/errors';
import { createRedactedLog, type AtNacosLog } from './utils/logger';
import { withLoadingProgress } from './utils/notifications';
import { ClusterStatusPanel } from './webview/ClusterStatusPanel';
import { ConfigHistoryPanel } from './webview/ConfigHistoryPanel';
import { ConfigListenersPanel } from './webview/ConfigListenersPanel';
import { NacosInstanceFormPanel } from './webview/NacosInstanceFormPanel';
import { disposeOpenPanels } from './webview/openPanels';
import { ServiceSubscribersPanel } from './webview/ServiceSubscribersPanel';

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
  const clientPool = new NacosClientPool();

  const getOrCreateClient = (instance: NacosInstanceConfig): Promise<NacosClient> =>
    clientPool.getClient(instance, (inst) =>
      createNacosClient(configManager, inst, certTrustStore, log)
    );

  const configTreeProvider = new ConfigTreeProvider(configManager, getOrCreateClient);
  const serviceTreeProvider = new ServiceTreeProvider(configManager, getOrCreateClient);
  // Both trees, always: an instance is a root node in each of them, so a save
  // or a delete that redrew only one would leave the other showing a server
  // that no longer exists.
  const refreshTreeViews = (): void => {
    clientPool.clear();
    configTreeProvider.refresh();
    serviceTreeProvider.refresh();
  };

  // Registered on activation rather than lazily on the first click: VS Code
  // restores a window's open editors before anyone touches them, so a `nacos:`
  // tab left open across a reload is asked for its content during startup.
  // With no provider registered by then the tab reads "cannot open ... no text
  // editor content provider" and stays that way until it is closed.
  const configDocumentProvider = new NacosConfigDocumentProvider(configManager, getOrCreateClient);
  const configDocumentRegistration = vscode.workspace.registerTextDocumentContentProvider(
    NACOS_CONFIG_SCHEME,
    configDocumentProvider
  );

  const draftFileSystemProvider = new NacosDraftFileSystemProvider();
  const draftFileSystemRegistration = vscode.workspace.registerFileSystemProvider(
    NACOS_DRAFT_SCHEME,
    draftFileSystemProvider
  );

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

  const hostEnv = {
    appName: vscode.env.appName,
    appRoot: vscode.env.appRoot,
    uriScheme: vscode.env.uriScheme,
    extensionPath: context.extensionUri.fsPath
  };
  const hostApp = detectHostApp(hostEnv);
  const currentWorkspaceFolder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const hubReady = syncPackagedHub(context)
    .then((result) => {
      log.info(`hub-sync: ok (updated=${result.updated}, active=${result.activeVersion})`);
      return result;
    })
    .catch((error) => {
      log.error(`hub-sync: failed: ${formatError(error)}`);
    });

  const nacosAgentToolService = new NacosAgentToolService({
    configManager,
    certTrustStore,
    createClient: (instance) => getOrCreateClient(instance),
    log
  });

  const bridgeServer = new BridgeServer({
    hostApp,
    pluginVersion:
      typeof context.extension?.packageJSON?.version === 'string'
        ? context.extension.packageJSON.version
        : undefined,
    toolService: nacosAgentToolService,
    log
  });
  void bridgeServer.start().catch((error) => {
    log.error(`bridge: failed to start: ${formatError(error)}`);
  });

  void hubReady
    .then(() => ensureAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() }))
    .catch((error) => {
      log.error(`mcp-config: could not be updated: ${formatError(error)}`);
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
    clientPool.clear();
    configTreeProvider.refresh();
  });
  const refreshServicesCommand = vscode.commands.registerCommand('atNacos.refreshServices', () => {
    clientPool.clear();
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

  // Both take the arguments their tree node carries, and both are contributed
  // with `"when": "false"` so the palette cannot offer them without any --
  // there is no configuration to open and no namespace to page when the
  // invocation comes from a text box.
  const openConfigCommand = vscode.commands.registerCommand(
    OPEN_CONFIG_COMMAND,
    async (instanceId: string, config: NacosConfigSummary) => {
      try {
        await withLoadingProgress(
          t('Loading configuration {dataId}...', { dataId: config.dataId }),
          () => openConfigDocument(instanceId, config)
        );
      } catch (error) {
        // The read itself cannot land here: the content provider answers every
        // failure with readable text in the buffer, precisely so that a
        // rejection does not become an empty editor. What is left is VS Code
        // refusing to show the document at all, and a tree click that opens
        // nothing and says nothing is indistinguishable from a dead node.
        const message = formatError(error);
        log.error(`openConfig: ${message}`);
        await vscode.window.showErrorMessage(
          t('Could not open the configuration {dataId}: {message}', { dataId: config.dataId, message })
        );
      }
    }
  );

  const loadMoreConfigsCommand = vscode.commands.registerCommand(
    LOAD_MORE_CONFIGS_COMMAND,
    async (namespace: NamespaceTreeItem) => {
      try {
        await withLoadingProgress(t('Loading more configurations...'), () =>
          configTreeProvider.loadMore(namespace)
        );
      } catch (error) {
        // `loadMore` rejects instead of rendering an error node, deliberately:
        // an error node under the namespace would replace the pages the user
        // was reading in order to report that there are no more of them. That
        // makes this the only place the failure can be said at all.
        const message = formatError(error);
        log.error(`loadMoreConfigs: ${message}`);
        await vscode.window.showErrorMessage(t('Could not load more configurations: {message}', { message }));
      }
    }
  );

  // Its own command rather than a shared one taking the scope: the two trees
  // page out of caches of their own, and a single registration would send
  // every click to whichever provider was wired last.
  const loadMoreServicesCommand = vscode.commands.registerCommand(
    LOAD_MORE_SERVICES_COMMAND,
    async (namespace: NamespaceTreeItem) => {
      try {
        await withLoadingProgress(t('Loading more services...'), () =>
          serviceTreeProvider.loadMore(namespace)
        );
      } catch (error) {
        const message = formatError(error);
        log.error(`loadMoreServices: ${message}`);
        await vscode.window.showErrorMessage(t('Could not load more services: {message}', { message }));
      }
    }
  );

  /**
   * The cluster panel, opened for whichever instance the user means.
   *
   * It hangs off both view titles, so it arrives with no arguments at all and
   * has to ask -- but only when there is something to ask about. One instance
   * is not a choice, and a quick pick with a single entry is a click spent on
   * confirming what the user already said.
   */
  const openClusterStatusCommand = vscode.commands.registerCommand('atNacos.openClusterStatus', async () => {
    try {
      const instance = await pickInstanceForClusterStatus(configManager, openInstanceForm);
      if (!instance) {
        return;
      }
      await ClusterStatusPanel.open(context, {
        instance,
        // Built per open and per refresh, exactly as the trees build theirs,
        // so an edited address or a rotated password takes effect on the next
        // click of Refresh rather than on the next window reload.
        connect: () => createNacosClient(configManager, instance, certTrustStore, log)
      });
    } catch (error) {
      // The panel reports what it could not *read* itself, in the section it
      // belongs to. What is left here is failing to open one at all: a
      // damaged stored instance, or VS Code refusing the panel.
      const message = formatError(error);
      log.error(`openClusterStatus: ${message}`);
      await vscode.window.showErrorMessage(t('Could not open the cluster status panel: {message}', { message }));
    }
  });

  /**
   * A client for whichever instance a node came from, read back by id rather
   * than taken from the node.
   *
   * A panel outlives the tree node it was opened from: the node holds the
   * instance as it was when the tree last drew, and an address or a password
   * edited since then would leave every Refresh talking to the old server.
   * The document provider re-reads for the same reason.
   */
  const connectToInstance = async (instanceId: string, label: string): Promise<NacosClient> => {
    const instance = await configManager.getInstance(instanceId);
    if (!instance) {
      throw new Error(
        t('The Nacos instance {label} is no longer configured. It was probably deleted while this view stayed open.', {
          label
        })
      );
    }
    return getOrCreateClient(instance);
  };

  /** One wording for both ways an earlier version is reached: the history panel's row, and the command. */
  const reportDiffFailure = async (dataId: string, command: string, run: () => Promise<void>): Promise<void> => {
    try {
      await withLoadingProgress(
        t('Loading version diff for {dataId}...', { dataId }),
        run
      );
    } catch (error) {
      const message = formatError(error);
      log.error(`${command}: ${message}`);
      await vscode.window.showErrorMessage(
        t('Could not compare {dataId} with an earlier version: {message}', { dataId, message })
      );
    }
  };

  /**
   * The five commands a tree node carries, each reported the same way.
   *
   * They arrive with the node as their only argument and are contributed with
   * `"when": "false"` in the palette, so there is no invocation without one.
   * Each reports its own failure: a menu item that does nothing and says
   * nothing is indistinguishable from a dead node.
   */
  const showConfigHistoryCommand = vscode.commands.registerCommand(
    'atNacos.showConfigHistory',
    async (item: ConfigTreeItem) => {
      try {
        await ConfigHistoryPanel.open(context, {
          instance: { id: item.instance.id, label: item.instance.label, readOnly: item.instance.readOnly },
          // The summary the node holds, which is the ref M2 builds the
          // current version's address from -- so the right-hand side of a
          // diff is the same buffer as the tab a click on the node opens.
          ref: item.config,
          connect: () => connectToInstance(item.instance.id, item.instance.label),
          // Reported here rather than in the panel, which owns no channel and
          // no notification: clicking Compare and getting nothing at all is
          // the one outcome worse than an error message.
          openDiff: (entry) =>
            reportDiffFailure(item.config.dataId, 'showConfigHistory', () =>
              openConfigVersionDiff(item.instance.id, item.config, entry)
            ),
          rollback: async (entry) => {
            try {
              const instance = await configManager.getInstance(item.instance.id);
              if (!instance) {
                return;
              }
              await rollbackConfig({
                instance,
                ref: item.config,
                entry,
                connect: () => connectToInstance(item.instance.id, item.instance.label),
                refreshDocument: (instId, ref) => configDocumentProvider.refresh(instId, ref),
                onRollback: () => refreshTreeViews()
              });
            } catch (error) {
              const message = formatError(error);
              log.error(`rollbackConfig: ${message}`);
              await vscode.window.showErrorMessage(
                t('Could not roll back the configuration {dataId}: {message}', { dataId: item.config.dataId, message })
              );
            }
          }
        });
      } catch (error) {
        const message = formatError(error);
        log.error(`showConfigHistory: ${message}`);
        await vscode.window.showErrorMessage(
          t('Could not open the configuration history panel: {message}', { message })
        );
      }
    }
  );

  const diffWithPreviousCommand = vscode.commands.registerCommand(
    'atNacos.diffWithPrevious',
    (item: ConfigTreeItem) =>
      reportDiffFailure(item.config.dataId, 'diffWithPrevious', () =>
        diffWithPreviousVersion({
          instanceId: item.instance.id,
          ref: item.config,
          connect: () => connectToInstance(item.instance.id, item.instance.label)
        })
      )
  );

  const compareAcrossEnvironmentsCommand = vscode.commands.registerCommand(
    'atNacos.compareAcrossEnvironments',
    async (item: ConfigTreeItem) => {
      try {
        await compareConfigAcrossEnvironments({
          source: { instance: { id: item.instance.id, label: item.instance.label }, ref: item.config },
          listInstances: () => configManager.listInstances(),
          // The instance the pick answered with, rather than one read back by
          // id: `listInstances` produced it a moment ago, and there is no
          // panel here to outlive it.
          connect: (instance) => getOrCreateClient(instance)
        });
      } catch (error) {
        const message = formatError(error);
        log.error(`compareAcrossEnvironments: ${message}`);
        await vscode.window.showErrorMessage(
          t('Could not compare {dataId} across environments: {message}', { dataId: item.config.dataId, message })
        );
      }
    }
  );

  const showConfigListenersCommand = vscode.commands.registerCommand(
    'atNacos.showConfigListeners',
    async (item: ConfigTreeItem) => {
      try {
        await ConfigListenersPanel.open(context, {
          instance: { id: item.instance.id, label: item.instance.label },
          ref: item.config,
          connect: () => connectToInstance(item.instance.id, item.instance.label)
        });
      } catch (error) {
        const message = formatError(error);
        log.error(`showConfigListeners: ${message}`);
        await vscode.window.showErrorMessage(
          t('Could not open the configuration listeners panel: {message}', { message })
        );
      }
    }
  );

  const showServiceSubscribersCommand = vscode.commands.registerCommand(
    'atNacos.showServiceSubscribers',
    async (item: ServiceTreeItem) => {
      try {
        await ServiceSubscribersPanel.open(context, {
          instance: { id: item.instance.id, label: item.instance.label },
          ref: item.service,
          connect: () => connectToInstance(item.instance.id, item.instance.label)
        });
      } catch (error) {
        const message = formatError(error);
        log.error(`showServiceSubscribers: ${message}`);
        await vscode.window.showErrorMessage(
          t('Could not open the service subscribers panel: {message}', { message })
        );
      }
    }
  );

  /**
   * A draft for a configuration that does not exist on the server yet,
   * started from a namespace or group node -- the only levels that can name a
   * parent for it, since a config node is by definition one that already
   * exists. The draft goes through the same Diff-and-confirm publish pipeline
   * as an edit: `publishConfig` re-reads the server and treats
   * resource-not-found as empty content, so the first publish is an insert
   * and a dataId that turned out to exist is shown in the diff, not clobbered
   * blind.
   */
  const createConfigCommand = vscode.commands.registerCommand(
    'atNacos.createConfig',
    async (item: NamespaceTreeItem | GroupTreeItem) => {
      try {
        const instance = await configManager.getInstance(item.instance.id);
        if (!instance) {
          return;
        }
        const ref = await askForNewConfigRef(item);
        if (!ref) {
          return;
        }
        // `assertWritable` runs inside openDraftDocument, the same second
        // layer of defense every write path has.
        await withLoadingProgress(
          t('Opening draft for {dataId}...', { dataId: ref.dataId }),
          () =>
            openDraftDocument({
              instance,
              ref,
              draftProvider: draftFileSystemProvider,
              connect: () => connectToInstance(item.instance.id, item.instance.label),
              createNew: true
            })
        );
      } catch (error) {
        const message = formatError(error);
        log.error(`createConfig: ${message}`);
        await vscode.window.showErrorMessage(
          t('Could not create the configuration: {message}', { message })
        );
      }
    }
  );

  const editConfigCommand = vscode.commands.registerCommand(
    'atNacos.editConfig',
    async (item: ConfigTreeItem) => {
      try {
        const instance = await configManager.getInstance(item.instance.id);
        if (!instance) {
          return;
        }
        await withLoadingProgress(
          t('Opening draft for {dataId}...', { dataId: item.config.dataId }),
          () =>
            openDraftDocument({
              instance,
              ref: item.config,
              draftProvider: draftFileSystemProvider,
              connect: () => connectToInstance(item.instance.id, item.instance.label)
            })
        );
      } catch (error) {
        const message = formatError(error);
        log.error(`editConfig: ${message}`);
        await vscode.window.showErrorMessage(
          t('Could not edit the configuration {dataId}: {message}', { dataId: item.config.dataId, message })
        );
      }
    }
  );

  const publishConfigCommand = vscode.commands.registerCommand(
    'atNacos.publishConfig',
    async (item?: ConfigTreeItem) => {
      try {
        let instanceId: string | undefined = item?.instance.id;
        let ref = item?.config;

        if (!instanceId || !ref) {
          const activeUri = vscode.window.activeTextEditor?.document.uri;
          if (activeUri) {
            const target = parseDraftUri(activeUri);
            if (target) {
              instanceId = target.instanceId;
              ref = target.ref;
            }
          }
        }

        if (!instanceId || !ref) {
          return;
        }

        const instance = await configManager.getInstance(instanceId);
        if (!instance) {
          return;
        }

        await publishConfig({
          instance,
          ref,
          draftProvider: draftFileSystemProvider,
          connect: () => connectToInstance(instance.id, instance.label),
          refreshDocument: (instId, targetRef) => configDocumentProvider.refresh(instId, targetRef),
          onPublished: () => refreshTreeViews()
        });
      } catch (error) {
        const message = formatError(error);
        log.error(`publishConfig: ${message}`);
        const dataId = item?.config.dataId ?? '';
        await vscode.window.showErrorMessage(
          t('Could not publish the configuration {dataId}: {message}', { dataId, message })
        );
      }
    }
  );

  const inFlightPublish = new Set<string>();

  const saveDocumentListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (document.uri.scheme !== NACOS_DRAFT_SCHEME) {
      return;
    }
    const target = parseDraftUri(document.uri);
    if (!target) {
      return;
    }
    if (!draftFileSystemProvider.isDirty(target)) {
      return;
    }

    const draftKey = document.uri.toString();
    if (inFlightPublish.has(draftKey)) {
      return;
    }
    inFlightPublish.add(draftKey);

    try {
      const instance = await configManager.getInstance(target.instanceId);
      if (!instance) {
        return;
      }
      await publishConfig({
        instance,
        ref: target.ref,
        draftProvider: draftFileSystemProvider,
        connect: () => connectToInstance(instance.id, instance.label),
        refreshDocument: (instId, targetRef) => configDocumentProvider.refresh(instId, targetRef),
        onPublished: () => refreshTreeViews()
      });
    } catch (error) {
      const message = formatError(error);
      log.error(`saveDocumentPublish: ${message}`);
      await vscode.window.showErrorMessage(
        t('Could not publish the configuration {dataId}: {message}', {
          dataId: target.ref.dataId,
          message
        })
      );
    } finally {
      inFlightPublish.delete(draftKey);
    }
  });

  const closeDocumentListener = vscode.workspace.onDidCloseTextDocument((document) => {
    if (document.uri.scheme !== NACOS_DRAFT_SCHEME) {
      return;
    }
    const target = parseDraftUri(document.uri);
    if (!target) {
      return;
    }
    if (!draftFileSystemProvider.isDirty(target)) {
      draftFileSystemProvider.deleteDraft(target);
    }
  });

  const deleteConfigCommand = vscode.commands.registerCommand(
    'atNacos.deleteConfig',
    async (item: ConfigTreeItem) => {
      try {
        const instance = await configManager.getInstance(item.instance.id);
        if (!instance) {
          return;
        }
        await deleteConfig({
          instance,
          ref: item.config,
          connect: () => connectToInstance(item.instance.id, item.instance.label),
          draftProvider: draftFileSystemProvider,
          refreshDocument: (instId, targetRef) => configDocumentProvider.refresh(instId, targetRef),
          onDeleted: () => refreshTreeViews()
        });
      } catch (error) {
        const message = formatError(error);
        log.error(`deleteConfig: ${message}`);
        await vscode.window.showErrorMessage(
          t('Could not delete the configuration {dataId}: {message}', { dataId: item.config.dataId, message })
        );
      }
    }
  );

  const enableServiceInstanceCommand = vscode.commands.registerCommand(
    'atNacos.enableServiceInstance',
    async (item: ServiceInstanceTreeItem) => {
      try {
        const instance = await configManager.getInstance(item.instance.id);
        if (!instance) {
          return;
        }
        await toggleServiceInstanceEnabled({
          instance,
          serviceRef: item.service,
          serviceInstance: item.serviceInstance,
          enabled: true,
          connect: () => connectToInstance(item.instance.id, item.instance.label),
          onUpdated: () => refreshTreeViews()
        });
      } catch (error) {
        const message = formatError(error);
        log.error(`enableServiceInstance: ${message}`);
        const address = `${item.serviceInstance.ip}:${item.serviceInstance.port}`;
        await vscode.window.showErrorMessage(
          t('Could not update instance state for {address}: {message}', { address, message })
        );
      }
    }
  );

  const disableServiceInstanceCommand = vscode.commands.registerCommand(
    'atNacos.disableServiceInstance',
    async (item: ServiceInstanceTreeItem) => {
      try {
        const instance = await configManager.getInstance(item.instance.id);
        if (!instance) {
          return;
        }
        await toggleServiceInstanceEnabled({
          instance,
          serviceRef: item.service,
          serviceInstance: item.serviceInstance,
          enabled: false,
          connect: () => connectToInstance(item.instance.id, item.instance.label),
          onUpdated: () => refreshTreeViews()
        });
      } catch (error) {
        const message = formatError(error);
        log.error(`disableServiceInstance: ${message}`);
        const address = `${item.serviceInstance.ip}:${item.serviceInstance.port}`;
        await vscode.window.showErrorMessage(
          t('Could not update instance state for {address}: {message}', { address, message })
        );
      }
    }
  );

  const installMcpConfigCommand = vscode.commands.registerCommand('atNacos.installMcpConfig', async () => {
    try {
      await syncPackagedHub(context);
      const res = await ensureAtSeriesConfigForCurrentIde({
        ...hostEnv,
        workspaceFolder: currentWorkspaceFolder()
      });
      if (res?.updated) {
        await vscode.window.showInformationMessage(t('AT Series MCP configuration installed successfully.'));
      } else {
        await vscode.window.showInformationMessage(t('AT Series MCP configuration is already up to date.'));
      }
    } catch (error) {
      const message = formatError(error);
      log.error(`installMcpConfig: ${message}`);
      await vscode.window.showErrorMessage(t('Could not install MCP configuration: {message}', { message }));
    }
  });

  // VS Code awaits the promise `deactivate()` returns. It does NOT await the
  // `dispose()` of anything in `context.subscriptions` -- it calls each one and
  // moves on. Nothing in this milestone needs that guarantee: the channel, the
  // two views, the document provider and the commands all dispose
  // synchronously, so they are pushed below. The seam exists anyway, and is guarded against a second
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
      // Not a `context.subscriptions` entry: a panel outlives that array, and
      // the message handler behind its Refresh button does not outlive this
      // host. Left open, it would keep a button that does nothing at all.
      await bridgeServer.stop().catch(() => undefined);
      disposeOpenPanels();
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
    // The provider and its registration both, because they own different
    // things: dropping the registration stops VS Code asking this provider for
    // content, and disposing the provider releases the change emitter every
    // open document is subscribed to.
    configDocumentProvider,
    configDocumentRegistration,
    draftFileSystemProvider,
    draftFileSystemRegistration,
    refreshConfigsCommand,
    refreshServicesCommand,
    filterConfigsCommand,
    clearConfigFilterCommand,
    openConfigCommand,
    loadMoreConfigsCommand,
    loadMoreServicesCommand,
    openClusterStatusCommand,
    showConfigHistoryCommand,
    diffWithPreviousCommand,
    compareAcrossEnvironmentsCommand,
    showConfigListenersCommand,
    showServiceSubscribersCommand,
    createConfigCommand,
    editConfigCommand,
    publishConfigCommand,
    deleteConfigCommand,
    enableServiceInstanceCommand,
    disableServiceInstanceCommand,
    installMcpConfigCommand,
    saveDocumentListener,
    closeDocumentListener
  );
}

/**
 * Which instance the cluster panel should show: the only one, the one picked,
 * or none at all.
 *
 * `manageInstances` asks the same question and cannot share this, deliberately
 * -- it offers the pick even for a single instance, because there the pick is
 * how an instance is reached in order to be edited or deleted. Here it would
 * only be a click.
 */
async function pickInstanceForClusterStatus(
  configManager: Pick<NacosInstanceConfigManager, 'listInstances'>,
  openInstanceForm: OpenInstanceForm
): Promise<NacosInstanceConfig | undefined> {
  const instances = await configManager.listInstances();
  if (instances.length === 0) {
    // The same offer `manageInstances` makes: this button sits on a view
    // title, so it is reachable before any instance exists.
    const addAction = t('Add Instance');
    const answer = await vscode.window.showInformationMessage(t('No Nacos instances configured yet.'), addAction);
    if (answer === addAction) {
      await openInstanceForm();
    }
    return undefined;
  }
  if (instances.length === 1) {
    return instances[0];
  }
  const picked = await vscode.window.showQuickPick(
    instances.map((instance) => ({
      label: instance.label,
      description: instance.serverUrl,
      instance
    })),
    { placeHolder: t('Select a Nacos instance to show the cluster status of') }
  );
  return picked?.instance;
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

/** Nacos's own default group -- what it substitutes for a blank one, so the prefill says what blank would mean anyway. */
const DEFAULT_GROUP = 'DEFAULT_GROUP';

/**
 * Where the new configuration will live, assembled from the node it was
 * started on and from input boxes for what the node cannot say.
 *
 * The dataId is always asked for: it is the one thing no parent node carries.
 * A group node then names both remaining coordinates itself, while a
 * namespace node has to ask for the group too, prefilled with the default so
 * that accepting it is one Enter rather than a retype. Escape at either box
 * answers undefined and abandons the creation; a group box cleared to empty
 * does not, because Nacos itself reads a blank group as the default one.
 */
async function askForNewConfigRef(item: NamespaceTreeItem | GroupTreeItem): Promise<NacosConfigRef | undefined> {
  const typedDataId = await vscode.window.showInputBox({
    prompt: t('Data ID of the new configuration'),
    placeHolder: t('e.g. application-uat.yaml'),
    validateInput: (value) => (value.trim() === '' ? t('A data ID is required.') : undefined)
  });
  // Trimmed before the emptiness check: `validateInput` only guards the
  // interactive path, and a box dismissed with Escape bypasses it entirely.
  const dataId = typedDataId?.trim();
  if (!dataId) {
    return undefined;
  }

  if (item instanceof GroupTreeItem) {
    return { namespaceId: item.namespaceId, group: item.group, dataId };
  }

  const typedGroup = await vscode.window.showInputBox({
    prompt: t('Group of the new configuration'),
    value: DEFAULT_GROUP
  });
  if (typedGroup === undefined) {
    return undefined;
  }
  return { namespaceId: item.namespace.namespaceId, group: typedGroup.trim() || DEFAULT_GROUP, dataId };
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
