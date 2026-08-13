import * as vscode from 'vscode';
import type { NacosInstanceConfigManager } from '../config/NacosInstanceConfigManager';
import type { NacosInstanceConfig } from '../config/schema';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosNamespace } from '../nacos/driver/normalize';
import { formatError } from '../utils/errors';
import {
  ErrorTreeItem,
  InstanceTreeItem,
  NamespaceTreeItem,
  type NacosTreeItem,
  type NacosTreeScope
} from './NacosTreeItems';

/**
 * Only what the shared levels call. Narrow enough that a test passes an
 * object literal, and narrow enough that the provider cannot reach for an
 * endpoint the namespace level has no business calling.
 */
export type NacosTreeClient = Pick<NacosClient, 'listNamespaces' | 'state'>;

/**
 * Injected rather than built here: assembling a client means an HTTP client,
 * an auth strategy, a TLS verifier and a version probe, all of which belong
 * to the composition root. Every call builds a fresh client, so an edit to
 * the instance's address or credentials takes effect on the next refresh.
 */
export type NacosTreeClientFactory = (instance: NacosInstanceConfig) => Promise<NacosTreeClient>;

/** The namespace list plus the version that decides how to name the default namespace. */
interface InstanceNamespaces {
  majorVersion: number;
  namespaces: NacosNamespace[];
}

/**
 * The instance and namespace levels, which the configuration tree and the
 * service tree render identically.
 *
 * Shared by inheritance rather than by a helper the two providers call: what
 * is common is not only the loading but the whole `TreeDataProvider`
 * implementation -- the change event, `getTreeItem`, the root dispatch and
 * the cache `refresh()` clears. A helper would leave each provider to wire
 * those four together itself, which is the copy that drifts. Subclasses take
 * over below the instance, where M2 (groups, dataIds) and M3 (services,
 * instances) diverge, and are free to add what only one of them needs -- the
 * configuration tree grows a filter in M2 that the service tree has no use
 * for.
 */
export abstract class NacosTreeBase implements vscode.TreeDataProvider<NacosTreeItem> {
  /**
   * Protected so a subclass can fire it for a single element. M2's "Load
   * more" node redraws one namespace's subtree, and firing undefined there
   * would collapse everything the user has open.
   */
  protected readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<NacosTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  /**
   * Keyed by instance id, holding the in-flight promise rather than its
   * result. VS Code calls `getChildren` again for every visible node as the
   * user expands, and those calls overlap: caching the settled value alone
   * would let a burst start one request each.
   */
  private readonly namespaceCache = new Map<string, Promise<InstanceNamespaces>>();

  protected abstract readonly scope: NacosTreeScope;

  constructor(
    private readonly configManager: Pick<NacosInstanceConfigManager, 'listInstances'>,
    private readonly createClient: NacosTreeClientFactory
  ) {}

  /** A subclass that caches anything of its own has to clear it here too. */
  refresh(): void {
    this.namespaceCache.clear();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: NacosTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NacosTreeItem): Promise<NacosTreeItem[]> {
    if (!element) {
      return this.getRootChildren();
    }
    if (element instanceof InstanceTreeItem) {
      return this.getInstanceChildren(element.instance);
    }
    return this.getChildrenBelowInstance(element);
  }

  /**
   * Children of anything below the instance level. In M1 that is only a
   * namespace and both trees answer with nothing.
   *
   * One hook for the whole subtree rather than a namespace-only callback:
   * M2 and M3 add levels under the namespace, and dispatching those here
   * would put half of each tree's routing in the shared base, where the
   * other tree would have to read past it.
   */
  protected abstract getChildrenBelowInstance(element: NacosTreeItem): Promise<NacosTreeItem[]>;

  private async getRootChildren(): Promise<NacosTreeItem[]> {
    let instances: NacosInstanceConfig[];
    try {
      instances = await this.configManager.listInstances();
    } catch (error) {
      // Not an empty array, even though that is what renders the welcome
      // view: `listInstances` throws when a stored record no longer parses,
      // and "no instance configured" would be the wrong answer to that. Its
      // Add Instance button would also write over the damaged record, which
      // a later version may still be able to repair.
      return [new ErrorTreeItem(this.scope, formatError(error))];
    }
    if (instances.length === 0) {
      // Empty rather than a "nothing here" node so VS Code renders the
      // `viewsWelcome` contribution, with its clickable Add Instance button.
      // Any node at all suppresses the welcome view and leaves the plugin
      // with no discoverable entry point.
      return [];
    }
    return instances.map((instance) => new InstanceTreeItem(this.scope, instance));
  }

  private async getInstanceChildren(instance: NacosInstanceConfig): Promise<NacosTreeItem[]> {
    let loaded: InstanceNamespaces;
    try {
      loaded = await this.loadNamespaces(instance);
    } catch (error) {
      // Rendered under the instance that failed rather than thrown: a throw
      // out of `getChildren` empties the entire view, so one unreachable
      // server would hide every reachable one and say nothing about why.
      return [new ErrorTreeItem(this.scope, formatError(error), instance.id)];
    }
    return loaded.namespaces.map(
      (namespace) => new NamespaceTreeItem(this.scope, instance, namespace, loaded.majorVersion)
    );
  }

  /**
   * Synchronous on purpose. It has to reach the `set` before it yields, or
   * two overlapping expansions of one instance would both find the cache
   * empty and both start a request.
   */
  private loadNamespaces(instance: NacosInstanceConfig): Promise<InstanceNamespaces> {
    const cached = this.namespaceCache.get(instance.id);
    if (cached) {
      return cached;
    }
    const pending = this.fetchNamespaces(instance);
    this.namespaceCache.set(instance.id, pending);
    return pending;
  }

  private async fetchNamespaces(instance: NacosInstanceConfig): Promise<InstanceNamespaces> {
    const client = await this.createClient(instance);
    return { majorVersion: client.state.majorVersion, namespaces: await client.listNamespaces() };
  }
}
