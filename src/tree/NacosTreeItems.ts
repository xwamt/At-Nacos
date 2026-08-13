import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';
import {
  publicNamespaceId,
  type NacosConfigSummary,
  type NacosInstance,
  type NacosNamespace,
  type NacosServiceRef,
  type NacosServiceSummary
} from '../nacos/driver/normalize';

/**
 * Which of the two views an item was built for.
 *
 * It exists only to keep `TreeItem.id` unique: VS Code requires an id to
 * identify at most one item, and both views live in the same container and
 * render the same instances and namespaces. `contextValue` deliberately does
 * *not* carry the scope -- a `when` clause distinguishes the views with
 * `view == atNacos.configs`, and scoping the context value too would force
 * every menu contribution to be written twice.
 */
export type NacosTreeScope = 'config' | 'service';

/**
 * What a configuration node fires when it is clicked, and what the Load more
 * node fires. The ids live beside the nodes that carry them so that a node and
 * the registration serving it cannot drift apart silently -- a `command` naming
 * something unregistered fails only when a user clicks it.
 */
export const OPEN_CONFIG_COMMAND = 'atNacos.openConfig';
export const LOAD_MORE_CONFIGS_COMMAND = 'atNacos.loadMoreConfigs';
/**
 * One per view, not one shared: the two trees page different listings out of
 * caches of their own, so a single command id would send every click to
 * whichever provider happened to register last.
 */
export const LOAD_MORE_SERVICES_COMMAND = 'atNacos.loadMoreServices';

/**
 * A read-only instance answers to a different context value so that a menu
 * contributed with `when: viewItem == atNacos.instance` never appears on it.
 * Applied to every node under the instance, not just the instance itself:
 * M5's write commands hang off namespaces and configurations too, and a
 * suffix added later means auditing every menu that shipped without it.
 */
function contextValueFor(kind: string, instance: NacosInstanceConfig): string {
  return instance.readOnly ? `atNacos.${kind}.readonly` : `atNacos.${kind}`;
}

/**
 * An id for a node whose place in the tree is spelled by names the user chose.
 *
 * The parts are percent-encoded before being joined, which the levels above do
 * not need to do: an instance id is generated here and a namespace id is
 * `[\w-]+`, but a group name and a dataId are neither. Both may contain a
 * colon, so group `a:b` with dataId `c` and group `a` with dataId `b:c` would
 * write one id between them -- and VS Code identifies at most one item per id,
 * so one of two real configurations would simply not appear.
 */
function treeItemId(scope: NacosTreeScope, kind: string, ...parts: string[]): string {
  return `atNacos.${scope}.${kind}:${parts.map(encodeURIComponent).join(':')}`;
}

/**
 * Whether this entry is the server's default namespace.
 *
 * `publicNamespaceId` answers for the version the probe reported, and the
 * empty id is accepted on top of that unconditionally: a 3.x server with its
 * v3 endpoints switched off is served by the v1/v2 fallback drivers, which
 * spell the default namespace the old way, and no custom namespace has an
 * empty id on any version. `type === 0` is not usable as the test --
 * `normalizeNamespace` defaults an absent `type` to 0, so a custom namespace
 * from a server that omits the field would pass it.
 */
function isPublicNamespace(namespace: NacosNamespace, majorVersion: number): boolean {
  return namespace.namespaceId === publicNamespaceId(majorVersion) || namespace.namespaceId === '';
}

/**
 * What to write on a namespace node.
 *
 * The default namespace is named by the plugin rather than by the server: on
 * 1.x both its id and its display name are empty, which would render an
 * invisible node, and the versions disagree about the spelling besides
 * ('' vs 'public'). One localized label for all three versions is also the
 * only way this string gets translated at all.
 *
 * Everything else keeps the server's own name, falling back to the id when
 * that name is blank. A custom namespace saved with a blank name looks like
 * the 1.x default one and is not: labelling it 'public' would invite an edit
 * meant for one namespace to land in another.
 */
export function namespaceLabel(namespace: NacosNamespace, majorVersion: number): string {
  if (isPublicNamespace(namespace, majorVersion)) {
    return t('public');
  }
  return namespace.displayName || namespace.namespaceId;
}

export class InstanceTreeItem extends vscode.TreeItem {
  constructor(
    scope: NacosTreeScope,
    readonly instance: NacosInstanceConfig
  ) {
    super(instance.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `atNacos.${scope}.instance:${instance.id}`;
    this.contextValue = contextValueFor('instance', instance);
    this.iconPath = new vscode.ThemeIcon('server-environment');
    this.tooltip = instance.serverUrl;
    if (instance.readOnly) {
      // Also said in the UI, not only in the context value: a hidden write
      // command reads as a missing feature unless the node says why.
      this.description = t('read-only');
    }
  }
}

export class NamespaceTreeItem extends vscode.TreeItem {
  constructor(
    scope: NacosTreeScope,
    readonly instance: NacosInstanceConfig,
    readonly namespace: NacosNamespace,
    majorVersion: number
  ) {
    const label = namespaceLabel(namespace, majorVersion);
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `atNacos.${scope}.namespace:${instance.id}:${namespace.namespaceId}`;
    this.contextValue = contextValueFor('namespace', instance);
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
    // The raw id is what an application's own configuration has to quote, so
    // it earns a column of its own -- unless the label is already the id,
    // which is how a namespace with a blank name renders.
    this.description = namespace.namespaceId && namespace.namespaceId !== label ? namespace.namespaceId : undefined;
    this.tooltip = namespace.description || undefined;
  }
}

/**
 * One group of one namespace, in either view: configurations in the one,
 * services in the other. The two derive the group set the same way and say
 * the same thing about it, and the scope in the id is what keeps the two
 * views' nodes apart.
 *
 * It carries the namespace it was rendered under rather than reading it back
 * off a child, because that is the node's place in the tree: two namespaces
 * of one instance regularly hold a group of the same name, and an id built
 * from anything else would give those two nodes one identity.
 */
export class GroupTreeItem extends vscode.TreeItem {
  constructor(
    scope: NacosTreeScope,
    readonly instance: NacosInstanceConfig,
    readonly namespaceId: string,
    readonly group: string,
    loadedCount: number
  ) {
    super(group, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = treeItemId(scope, 'group', instance.id, namespaceId, group);
    this.contextValue = contextValueFor('group', instance);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.description = String(loadedCount);
    // Said in the tooltip because the list really is partial: Nacos has no
    // endpoint that lists groups, so they can only be derived from what has
    // been paged in so far. A user who reads this list as complete concludes
    // that a group does not exist when it merely has not loaded.
    this.tooltip = t(
      'Group {group}, {count} loaded. Nacos cannot list groups, so this list is derived from the pages loaded so far -- more groups may appear as you load more.',
      { count: loadedCount, group }
    );
  }
}

/**
 * One configuration, as the listing described it.
 *
 * The whole summary is kept rather than only its address, because `type` is
 * what decides the syntax highlighting and only the listing carries it --
 * fetching the detail at click time to read it would double every open.
 */
export class ConfigTreeItem extends vscode.TreeItem {
  constructor(
    scope: NacosTreeScope,
    readonly instance: NacosInstanceConfig,
    readonly namespaceId: string,
    readonly config: NacosConfigSummary
  ) {
    super(config.dataId, vscode.TreeItemCollapsibleState.None);
    this.id = treeItemId(scope, 'config', instance.id, namespaceId, config.group, config.dataId);
    this.contextValue = contextValueFor('config', instance);
    this.iconPath = new vscode.ThemeIcon('file');
    // The group is what the tooltip adds: the label already says the dataId,
    // and the same dataId under two groups is a different configuration. The
    // body is deliberately not here -- the listing does send one, and it holds
    // whatever passwords the configuration holds.
    this.tooltip = t('{dataId} in group {group}', { dataId: config.dataId, group: config.group });
    this.command = {
      command: OPEN_CONFIG_COMMAND,
      title: t('Open Configuration'),
      arguments: [instance.id, config]
    };
  }
}

/**
 * How a service's instances are doing, as far as the listing that answered
 * was willing to say.
 *
 * Five outcomes rather than the obvious three, and the two extra ones are the
 * ones that matter. `unknown` is not a zero: the counts arrive only from the
 * catalog endpoint or from 3.x, so a driver reduced to the name-only listing
 * reports nothing at all -- and painting that red would accuse a healthy
 * registry of being down. `empty` is not "all healthy": a service with no
 * instances satisfies `healthy === total` vacuously, and a green tick on a
 * service nobody can call is the worst answer of the five.
 */
type ServiceHealth = 'unknown' | 'empty' | 'none-healthy' | 'partly-healthy' | 'all-healthy';

function serviceHealth(service: NacosServiceSummary): ServiceHealth {
  const { instanceCount: total, healthyInstanceCount: healthy } = service;
  // Both, not either: half a count cannot be rendered as a ratio, and
  // inventing the missing half is exactly what this state exists to prevent.
  if (total === undefined || healthy === undefined) {
    return 'unknown';
  }
  if (total === 0) {
    return 'empty';
  }
  if (healthy === 0) {
    return 'none-healthy';
  }
  return healthy < total ? 'partly-healthy' : 'all-healthy';
}

/**
 * `ThemeColor` rather than a literal, so the tree follows the user's theme --
 * the same colours the Problems panel uses for its own error and warning
 * icons, which is where a VS Code user has already learned to read them.
 * `unknown` is deliberately left uncoloured: a colour is a claim, and that
 * state is the absence of one.
 */
function serviceHealthIcon(health: ServiceHealth): vscode.ThemeIcon {
  switch (health) {
    case 'all-healthy':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    case 'partly-healthy':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    case 'none-healthy':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    // As red as none-healthy, because the caller's outcome is the same, and a
    // glyph of its own because the cause is not: nothing is failing here,
    // there is simply nothing registered.
    case 'empty':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

/**
 * One service of one group.
 *
 * The whole summary is kept rather than only its name: the counts are what
 * the icon and the description are built from, only the listing carries
 * them, and M4's detail view will want the rest of it.
 */
export class ServiceTreeItem extends vscode.TreeItem {
  constructor(
    scope: NacosTreeScope,
    readonly instance: NacosInstanceConfig,
    /**
     * The namespace this node was rendered under, which is not read off the
     * summary for the reason `GroupTreeItem` does not read its own: the
     * node's place in the tree is what its identity is made of. An entry
     * whose `namespaceId` came back as something else -- a fallback, or a
     * server echoing the wrong scope -- would otherwise give the same
     * service in two namespaces one id, and VS Code would draw one of them.
     */
    readonly namespaceId: string,
    readonly service: NacosServiceSummary
  ) {
    super(service.serviceName, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = treeItemId(scope, 'service', instance.id, namespaceId, service.group, service.serviceName);
    this.contextValue = contextValueFor('service', instance);
    const health = serviceHealth(service);
    this.iconPath = serviceHealthIcon(health);
    // Spelled out in words when there is no count, never as `?/?`: a glyph
    // for "we could not ask" is read as a glyph for "nothing is there".
    this.description =
      health === 'unknown'
        ? t('instance count not reported')
        : `${service.healthyInstanceCount}/${service.instanceCount}`;
    this.tooltip =
      health === 'unknown'
        ? t(
            '{serviceName} in group {group}. The listing that answered carries no instance counts, so expand the service to see its instances.',
            { group: service.group, serviceName: service.serviceName }
          )
        : t('{serviceName} in group {group}: {healthy} of {total} instances healthy.', {
            group: service.group,
            healthy: service.healthyInstanceCount ?? 0,
            serviceName: service.serviceName,
            total: service.instanceCount ?? 0
          });
  }
}

/**
 * One registered instance of one service.
 *
 * The whole `NacosInstance` and the ref it was found under are both kept:
 * M5's enable/disable takes the service address and the instance together,
 * and nothing below this node can reconstruct either.
 *
 * **No `command`.** M3 is read-only and has no instance detail panel, so a
 * click would have nowhere to go; the context value is what M5 hangs its
 * menu on.
 */
export class ServiceInstanceTreeItem extends vscode.TreeItem {
  constructor(
    scope: NacosTreeScope,
    readonly instance: NacosInstanceConfig,
    readonly service: NacosServiceRef,
    readonly serviceInstance: NacosInstance
  ) {
    const address = `${serviceInstance.ip}:${serviceInstance.port}`;
    super(address, vscode.TreeItemCollapsibleState.None);
    this.id = treeItemId(
      scope,
      'serviceInstance',
      instance.id,
      service.namespaceId,
      service.group,
      service.serviceName,
      address
    );
    // Not `atNacos.instance`: that context value already belongs to the Nacos
    // server node at the root, and a menu contributed for one would appear on
    // the other.
    this.contextValue = contextValueFor('serviceInstance', instance);
    this.iconPath = instanceHealthIcon(serviceInstance);
    this.description = instanceDescription(serviceInstance);
    this.tooltip = instanceTooltip(serviceInstance);
  }
}

/**
 * A disabled instance is checked for first, and deliberately outranks an
 * unhealthy one: Nacos hands a disabled instance to no caller however
 * healthy it is, so that is the fact about routing. The health underneath is
 * not lost -- the tooltip's first line still reports it.
 */
function instanceHealthIcon(serviceInstance: NacosInstance): vscode.ThemeIcon {
  if (!serviceInstance.enabled) {
    return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  }
  return serviceInstance.healthy
    ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'))
    : new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
}

/**
 * The two fields that decide where a request lands. `normalizeInstance`
 * leaves the cluster name empty when the entry omitted it, and a description
 * reading "cluster , weight 1" looks like a rendering bug rather than like a
 * missing field.
 */
function instanceDescription(serviceInstance: NacosInstance): string {
  return serviceInstance.clusterName
    ? t('cluster {cluster}, weight {weight}', {
        cluster: serviceInstance.clusterName,
        weight: serviceInstance.weight
      })
    : t('weight {weight}', { weight: serviceInstance.weight });
}

function instanceTooltip(serviceInstance: NacosInstance): string {
  const lines = [serviceInstance.healthy ? t('This instance is healthy.') : t('This instance is unhealthy.')];
  if (!serviceInstance.enabled) {
    lines.push(t('This instance is disabled, so Nacos hands it to no caller.'));
  }
  const metadata = Object.entries(serviceInstance.metadata);
  // An instance registered by a bare API call carries none at all, and a line
  // that trails off after "Metadata:" reads as a failed lookup.
  lines.push(
    metadata.length === 0
      ? t('No metadata.')
      : t('Metadata: {metadata}', { metadata: metadata.map(([key, value]) => `${key}=${value}`).join(', ') })
  );
  return lines.join('\n');
}

/**
 * The next page of one namespace's configurations.
 *
 * It belongs to the namespace and not to a group: the page it loads can
 * introduce groups that are not on screen yet, so a node hidden inside one
 * group would be the only way to reveal another.
 */
export class LoadMoreTreeItem extends vscode.TreeItem {
  constructor(scope: NacosTreeScope, namespace: NamespaceTreeItem, loaded: number, total: number) {
    super(t('Load more'), vscode.TreeItemCollapsibleState.None);
    this.id = treeItemId(scope, 'loadMore', namespace.instance.id, namespace.namespace.namespaceId);
    // No read-only variant, unlike every other node under the instance:
    // nothing can be published to a paging affordance, so no menu will ever
    // need to be hidden from it.
    this.contextValue = 'atNacos.loadMore';
    this.iconPath = new vscode.ThemeIcon('ellipsis');
    this.description = `${loaded} / ${total}`;
    // Both halves follow from the view rather than from an argument: what is
    // being counted and which provider does the paging are one decision, and
    // splitting it would let a caller pass a noun that contradicts the
    // command it triggers. The noun is inside the sentence rather than
    // interpolated into it, because a translated fragment dropped into a
    // translated frame is only grammatical by luck.
    const paging = scope === 'service' ? SERVICE_PAGING : CONFIG_PAGING;
    this.tooltip = paging.tooltip(loaded, total);
    this.command = { command: paging.command, title: t('Load more'), arguments: [namespace] };
  }
}

const CONFIG_PAGING = {
  command: LOAD_MORE_CONFIGS_COMMAND,
  tooltip: (loaded: number, total: number): string =>
    t('{loaded} of {total} configurations loaded. The next page may bring groups that are not shown yet.', {
      loaded,
      total
    })
};

const SERVICE_PAGING = {
  command: LOAD_MORE_SERVICES_COMMAND,
  tooltip: (loaded: number, total: number): string =>
    t('{loaded} of {total} services loaded. The next page may bring groups that are not shown yet.', { loaded, total })
};

export class ErrorTreeItem extends vscode.TreeItem {
  /**
   * `message` must already be redacted; every caller runs it through
   * `formatError` first. It goes in the description rather than the label so
   * that the node reads as a failure at a glance and still says why without
   * a hover.
   *
   * `ownerId` identifies whatever failed -- an instance, or an instance and a
   * namespace together. Two failures at the same time need two ids, and which
   * levels can fail at once is the caller's knowledge, not this class's.
   */
  constructor(scope: NacosTreeScope, message: string, ownerId?: string) {
    super(t('Failed to load'), vscode.TreeItemCollapsibleState.None);
    // Two failing instances would otherwise produce two nodes carrying the
    // same label, which is what VS Code derives an id from when none is set.
    this.id = `atNacos.${scope}.error:${ownerId ?? '__root__'}`;
    this.contextValue = 'atNacos.error';
    this.iconPath = new vscode.ThemeIcon('error');
    this.description = message;
    this.tooltip = message;
  }
}

export type NacosTreeItem =
  | InstanceTreeItem
  | NamespaceTreeItem
  | GroupTreeItem
  | ConfigTreeItem
  | ServiceTreeItem
  | ServiceInstanceTreeItem
  | LoadMoreTreeItem
  | ErrorTreeItem;
