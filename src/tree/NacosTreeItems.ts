import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';
import { publicNamespaceId, type NacosNamespace } from '../nacos/driver/normalize';

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

export class ErrorTreeItem extends vscode.TreeItem {
  /**
   * `message` must already be redacted; every caller runs it through
   * `formatError` first. It goes in the description rather than the label so
   * that the node reads as a failure at a glance and still says why without
   * a hover.
   */
  constructor(scope: NacosTreeScope, message: string, instanceId?: string) {
    super(t('Failed to load'), vscode.TreeItemCollapsibleState.None);
    // Two failing instances would otherwise produce two nodes carrying the
    // same label, which is what VS Code derives an id from when none is set.
    this.id = `atNacos.${scope}.error:${instanceId ?? '__root__'}`;
    this.contextValue = 'atNacos.error';
    this.iconPath = new vscode.ThemeIcon('error');
    this.description = message;
    this.tooltip = message;
  }
}

export type NacosTreeItem = InstanceTreeItem | NamespaceTreeItem | ErrorTreeItem;
