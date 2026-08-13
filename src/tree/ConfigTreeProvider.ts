import type * as vscode from 'vscode';
import type { NacosInstanceConfigManager } from '../config/NacosInstanceConfigManager';
import type { NacosInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosConfigSummary, Paged } from '../nacos/driver/normalize';
import { formatError } from '../utils/errors';
import { NacosTreeBase, type NacosTreeClient } from './NacosTreeBase';
import {
  ConfigTreeItem,
  ErrorTreeItem,
  GroupTreeItem,
  LoadMoreTreeItem,
  NamespaceTreeItem,
  type NacosTreeItem,
  type NacosTreeScope
} from './NacosTreeItems';

/** The shared levels' client, plus the one capability the levels below need. */
export type NacosConfigTreeClient = NacosTreeClient & Pick<NacosClient, 'listConfigs'>;

export type NacosConfigTreeClientFactory = (instance: NacosInstanceConfig) => Promise<NacosConfigTreeClient>;

/**
 * How many configurations to ask for at a time.
 *
 * The client is the only thing setting a bound here: verified on a real 2.3.2,
 * the v1 list endpoint has no server-side cap at all and served a `pageSize`
 * of 9999 in full. It also returns the **entire body of every configuration**
 * in the page -- 12 of them measured 38KB, and Nacos's own ceiling for one is
 * 100KB -- so an unpaged namespace is a multi-megabyte response materializing
 * inside the extension host.
 */
const CONFIG_PAGE_SIZE = 100;

/** Everything one namespace has paged in so far. */
interface LoadedConfigs {
  configs: NacosConfigSummary[];
  /** How many pages have been asked for, which is what the next Load more continues from. */
  pagesLoaded: number;
  pagesAvailable: number;
  totalCount: number;
}

/**
 * The `atNacos.configs` view. Everything down to the namespace level lives in
 * `NacosTreeBase`, shared with the service tree; below it this provider adds
 * the groups of a namespace, the configurations of a group, and the node that
 * pages in the next hundred.
 */
export class ConfigTreeProvider extends NacosTreeBase {
  protected readonly scope: NacosTreeScope = 'config';

  /**
   * Keyed by instance and namespace, holding the in-flight promise rather than
   * its result, for the reason `NacosTreeBase` holds its namespaces that way:
   * VS Code expands several nodes at once and a settled-value cache would let
   * a burst start one request each.
   *
   * This is also what makes Load more additive. The entry accumulates the
   * pages, so the next one is merged into what is on screen instead of
   * replacing it.
   */
  private readonly pageCache = new Map<string, Promise<LoadedConfigs>>();

  /**
   * The dataId substring being searched for, absent when nothing is. It is
   * handed to the driver verbatim: which Nacos search mode that means, and
   * where the wildcards go, differs by API version and is the driver's to
   * know.
   */
  private filterText: string | undefined;

  /**
   * Only `message`, because that is the whole of what a provider has any
   * business setting on its view -- and a wider type would make a test fake a
   * dozen members of `TreeView` to hand one in.
   */
  private treeView: Pick<vscode.TreeView<NacosTreeItem>, 'message'> | undefined;

  /**
   * Declared again here, and wider, so that the factory this provider calls is
   * known to produce a client that can list configurations. The base keeps its
   * own narrow view of the same function.
   */
  constructor(
    configManager: Pick<NacosInstanceConfigManager, 'listInstances'>,
    private readonly createConfigClient: NacosConfigTreeClientFactory
  ) {
    super(configManager, createConfigClient);
  }

  refresh(): void {
    this.pageCache.clear();
    super.refresh();
  }

  /**
   * Lends the provider the one part of the view it writes to. The view is
   * created after the provider it is given, so a filter can already be set by
   * the time this arrives -- hence the immediate update rather than only on
   * the next change.
   */
  attachTreeView(treeView: Pick<vscode.TreeView<NacosTreeItem>, 'message'>): void {
    this.treeView = treeView;
    this.showFilterOnView();
  }

  getFilter(): string | undefined {
    return this.filterText;
  }

  /** Blank text means no filter, so that clearing the input box shows everything again. */
  setFilter(text: string): void {
    const trimmed = text.trim();
    this.applyFilter(trimmed.length > 0 ? trimmed : undefined);
  }

  clearFilter(): void {
    this.applyFilter(undefined);
  }

  /**
   * Pages one more hundred into a namespace that is already showing some.
   *
   * Fires the change event for that namespace rather than for the whole tree,
   * which is the entire point of the node: firing undefined redraws from the
   * root and collapses every node the user has open -- including the group
   * they clicked Load more to add to.
   *
   * Rejects when the page fails, leaving the pages already loaded exactly as
   * they were. The caller reports it: this is a click, so it has a place to
   * report to, and turning the namespace into an error node would throw away
   * what the user was reading in order to say that there is no more of it.
   */
  async loadMore(namespace: NamespaceTreeItem): Promise<void> {
    const key = pageCacheKey(namespace.instance.id, namespace.namespace.namespaceId);
    const pending = this.pageCache.get(key);
    if (!pending) {
      // A refresh dropped the pages while the node was on screen. The next
      // expansion starts at page one, which is where this would have to begin
      // anyway.
      return;
    }
    let loaded: LoadedConfigs;
    try {
      loaded = await pending;
    } catch {
      // The first page is what failed, so there is nothing to add to. Its
      // entry has already evicted itself; expanding the namespace retries.
      return;
    }
    if (this.pageCache.get(key) !== pending) {
      // A refresh, or a second click, replaced the entry while this one was
      // awaiting it. Appending to what was read here would either resurrect
      // dropped pages or ask for the same page twice.
      return;
    }
    const appended = this.fetchPage(namespace.instance, namespace.namespace.namespaceId, loaded);
    this.pageCache.set(key, appended);
    try {
      await appended;
    } catch (error) {
      if (this.pageCache.get(key) === appended) {
        this.pageCache.set(key, pending);
      }
      throw error;
    }
    this.onDidChangeTreeDataEmitter.fire(namespace);
  }

  private applyFilter(filterText: string | undefined): void {
    if (filterText === this.filterText) {
      // Entering the same text again is not a reload. Dropping the pages here
      // would throw away everything the user had paged in and answer with the
      // first hundred matches again.
      return;
    }
    this.filterText = filterText;
    // A filter is a different result set, so the page counter means nothing in
    // it: continuing from page four would skip the first three pages of
    // matches, which are the ones being searched for.
    this.pageCache.clear();
    this.showFilterOnView();
    // Undefined, unlike Load more: every namespace's contents change at once,
    // so there is no single subtree to redraw.
    this.onDidChangeTreeDataEmitter.fire();
  }

  /** The only place the filter is visible at all; a filtered tree that does not say so reads as an empty one. */
  private showFilterOnView(): void {
    if (this.treeView) {
      this.treeView.message = this.filterText ? t('Filter: "{text}"', { text: this.filterText }) : undefined;
    }
  }

  protected async getChildrenBelowInstance(element: NacosTreeItem): Promise<NacosTreeItem[]> {
    if (element instanceof NamespaceTreeItem) {
      return this.getNamespaceChildren(element);
    }
    if (element instanceof GroupTreeItem) {
      return this.getGroupChildren(element);
    }
    return [];
  }

  private async getNamespaceChildren(element: NamespaceTreeItem): Promise<NacosTreeItem[]> {
    const namespaceId = element.namespace.namespaceId;
    let loaded: LoadedConfigs;
    try {
      loaded = await this.loadConfigs(element.instance, namespaceId);
    } catch (error) {
      return [this.errorNode(error, pageCacheKey(element.instance.id, namespaceId))];
    }
    const children: NacosTreeItem[] = groupConfigs(loaded.configs).map(
      ([group, configs]) => new GroupTreeItem(this.scope, element.instance, namespaceId, group, configs.length)
    );
    if (loaded.pagesLoaded < loaded.pagesAvailable) {
      children.push(new LoadMoreTreeItem(this.scope, element, loaded.configs.length, loaded.totalCount));
    }
    return children;
  }

  private async getGroupChildren(element: GroupTreeItem): Promise<NacosTreeItem[]> {
    let loaded: LoadedConfigs;
    try {
      loaded = await this.loadConfigs(element.instance, element.namespaceId);
    } catch (error) {
      return [this.errorNode(error, joinKey(element.instance.id, element.namespaceId, element.group))];
    }
    return loaded.configs
      .filter((config) => config.group === element.group)
      .sort((left, right) => left.dataId.localeCompare(right.dataId))
      .map((config) => new ConfigTreeItem(this.scope, element.instance, element.namespaceId, config));
  }

  /**
   * Rendered under the node that failed rather than thrown, as the instance
   * level does. `ownerId` names that node and not merely its namespace: a
   * namespace and a group of it can be showing an error at the same moment,
   * and two nodes carrying one id is what VS Code will not draw.
   */
  private errorNode(error: unknown, ownerId: string): ErrorTreeItem {
    return new ErrorTreeItem(this.scope, formatError(error), ownerId);
  }

  /**
   * Synchronous on purpose, exactly as `NacosTreeBase.loadNamespaces` is: it
   * has to reach the `set` before it yields, or two overlapping expansions of
   * one namespace would both find the cache empty and both start a request.
   */
  private loadConfigs(instance: NacosInstanceConfig, namespaceId: string): Promise<LoadedConfigs> {
    const key = pageCacheKey(instance.id, namespaceId);
    const cached = this.pageCache.get(key);
    if (cached) {
      return cached;
    }
    const pending = this.fetchPage(instance, namespaceId, EMPTY_PAGES);
    this.pageCache.set(key, pending);
    // A rejected promise left in the cache is replayed for every later
    // expansion, so collapsing the node and expanding it again -- the retry
    // gesture -- would show the first error forever. Identity-checked, so that
    // a refresh during a slow load does not have its healthy replacement
    // deleted by the failure of the fetch it replaced.
    void pending.catch(() => {
      if (this.pageCache.get(key) === pending) {
        this.pageCache.delete(key);
      }
    });
    return pending;
  }

  /**
   * One page, merged into what is already loaded.
   *
   * A fresh client per call, which is what `NacosTreeBase` does for the
   * namespace level and for the same reason: an edited address or a rotated
   * password takes effect on the next load rather than at the next window
   * reload. It costs one login and one version probe per page.
   */
  private async fetchPage(
    instance: NacosInstanceConfig,
    namespaceId: string,
    loaded: LoadedConfigs
  ): Promise<LoadedConfigs> {
    const pageNo = loaded.pagesLoaded + 1;
    const client = await this.createConfigClient(instance);
    const page = await client.listConfigs({
      namespaceId,
      pageNo,
      pageSize: CONFIG_PAGE_SIZE,
      search: this.filterText
    });
    return mergePage(loaded, page, pageNo);
  }
}

const EMPTY_PAGES: LoadedConfigs = { configs: [], pagesLoaded: 0, pagesAvailable: 1, totalCount: 0 };

/**
 * Appends a page to what is loaded, skipping whatever is already there.
 *
 * The duplicate check is not paranoia about the protocol: a configuration
 * published between two page requests shifts the rows, and the same dataId
 * then arrives twice. Two nodes with one id is what VS Code refuses to render.
 *
 * `pagesLoaded` counts what was asked for rather than what the server said it
 * answered with. A server that ignores the page number would otherwise keep
 * offering Load more forever; counted this way it runs out of pages and the
 * duplicate check makes the extra requests harmless.
 */
function mergePage(loaded: LoadedConfigs, page: Paged<NacosConfigSummary>, pageNo: number): LoadedConfigs {
  const configs = [...loaded.configs];
  const seen = new Set(configs.map(configKey));
  for (const config of page.items) {
    const key = configKey(config);
    if (!seen.has(key)) {
      seen.add(key);
      configs.push(config);
    }
  }
  return { configs, pagesLoaded: pageNo, pagesAvailable: page.pagesAvailable, totalCount: page.totalCount };
}

/**
 * The loaded configurations by group, ordered by group name.
 *
 * Sorted rather than left in the order the pages arrived, so that a Load more
 * inserts its new groups in place instead of appending them below the ones the
 * user is already reading.
 */
function groupConfigs(configs: NacosConfigSummary[]): [string, NacosConfigSummary[]][] {
  const grouped = new Map<string, NacosConfigSummary[]>();
  for (const config of configs) {
    const bucket = grouped.get(config.group);
    if (bucket) {
      bucket.push(config);
    } else {
      grouped.set(config.group, [config]);
    }
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function pageCacheKey(instanceId: string, namespaceId: string): string {
  return joinKey(instanceId, namespaceId);
}

function configKey(config: NacosConfigSummary): string {
  return joinKey(config.group, config.dataId);
}

/** Percent-encoded before joining, so that a colon inside a part cannot pass for the separator. */
function joinKey(...parts: string[]): string {
  return parts.map(encodeURIComponent).join(':');
}
