import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';
import { publicNamespaceId, type NacosConfigSummary, type NacosNamespace } from '../nacos/driver/normalize';

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
 * One configuration group of one namespace.
 *
 * It carries the namespace it was rendered under rather than reading it back
 * off a configuration, because that is the node's place in the tree: two
 * namespaces of one instance regularly hold a group of the same name, and an
 * id built from anything else would give those two nodes one identity.
 */
export class GroupTreeItem extends vscode.TreeItem {
  constructor(
    scope: NacosTreeScope,
    readonly instance: NacosInstanceConfig,
    readonly namespaceId: string,
    readonly group: string,
    configCount: number
  ) {
    super(group, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = treeItemId(scope, 'group', instance.id, namespaceId, group);
    this.contextValue = contextValueFor('group', instance);
    this.iconPath = new vscode.ThemeIcon('folder');
    this.description = String(configCount);
    // Said in the tooltip because the list really is partial: Nacos has no
    // endpoint that lists groups, so they can only be derived from the
    // configurations paged in so far. A user who reads this list as complete
    // concludes that a group does not exist when it merely has not loaded.
    this.tooltip = t(
      'Group {group}, {count} loaded. Nacos cannot list groups, so this list is derived from the pages loaded so far -- more groups may appear as you load more.',
      { count: configCount, group }
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
    this.tooltip = t(
      '{loaded} of {total} configurations loaded. The next page may bring groups that are not shown yet.',
      { loaded, total }
    );
    this.command = { command: LOAD_MORE_CONFIGS_COMMAND, title: t('Load more'), arguments: [namespace] };
  }
}

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
  | LoadMoreTreeItem
  | ErrorTreeItem;
