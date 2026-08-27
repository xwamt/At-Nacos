import type * as vscode from 'vscode';
import type { NacosInstanceConfigManager } from '../config/NacosInstanceConfigManager';
import type { NacosInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';
import type { NacosClient } from '../nacos/NacosClient';
import type { NacosInstance, NacosServiceRef, NacosServiceSummary, Paged } from '../nacos/driver/normalize';
import { formatError } from '../utils/errors';
import { NacosTreeBase, type NacosTreeClient } from './NacosTreeBase';
import {
  ErrorTreeItem,
  GroupTreeItem,
  LoadMoreTreeItem,
  NamespaceTreeItem,
  ServiceInstanceTreeItem,
  ServiceTreeItem,
  type NacosTreeItem,
  type NacosTreeScope
} from './NacosTreeItems';

/** The shared levels' client, plus the two capabilities the levels below need. */
export type NacosServiceTreeClient = NacosTreeClient & Pick<NacosClient, 'listServices' | 'listInstances'>;

export type NacosServiceTreeClientFactory = (instance: NacosInstanceConfig) => Promise<NacosServiceTreeClient>;

/**
 * How many services to ask for at a time, matching the configuration tree.
 *
 * A service entry is small -- a name, a group and four counters -- so the
 * response-size argument that sets the configuration tree's page size does
 * not apply here. What does apply is the node count: a namespace with
 * thousands of services would otherwise build thousands of tree items in one
 * draw.
 */
const SERVICE_PAGE_SIZE = 100;

/** Everything one namespace has paged in so far. */
interface LoadedServices {
  services: NacosServiceSummary[];
  /** How many pages have been asked for, which is what the next Load more continues from. */
  pagesLoaded: number;
  pagesAvailable: number;
  totalCount: number;
}

/**
 * The `atNacos.services` view. Everything down to the namespace level lives
 * in `NacosTreeBase`, shared with the configuration tree; below it this
 * provider adds the groups of a namespace, the services of a group, and the
 * instances of a service.
 */
export class ServiceTreeProvider extends NacosTreeBase {
  protected readonly scope: NacosTreeScope = 'service';

  /**
   * Keyed by instance and namespace, holding the in-flight promise rather than
   * its result, for the reason `NacosTreeBase` holds its namespaces that way:
   * VS Code expands several nodes at once and a settled-value cache would let
   * a burst start one request each.
   */
  private readonly pageCache = new Map<string, Promise<LoadedServices>>();

  /**
   * Keyed by the full service address, and separate from the page cache
   * because it is a separate request: one service's instances failing must
   * leave every sibling under the same group as it was.
   */
  private readonly instanceCache = new Map<string, Promise<NacosInstance[]>>();

  /**
   * The service-name substring being searched for, absent when nothing is.
   * It is handed to the driver verbatim: which listings can honour it, and
   * under which parameter name, differs by API version and is the driver's
   * to know.
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
   * known to produce a client that can list services. The base keeps its own
   * narrow view of the same function.
   */
  constructor(
    configManager: Pick<NacosInstanceConfigManager, 'listInstances'>,
    private readonly createServiceClient: NacosServiceTreeClientFactory
  ) {
    super(configManager, createServiceClient);
  }

  refresh(): void {
    this.pageCache.clear();
    this.instanceCache.clear();
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
    let loaded: LoadedServices;
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
    // matches, which are the ones being searched for. The instance cache
    // stays: a service's instances are the same whatever listing found it.
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
    if (element instanceof ServiceTreeItem) {
      return this.getServiceChildren(element);
    }
    return [];
  }

  private async getNamespaceChildren(element: NamespaceTreeItem): Promise<NacosTreeItem[]> {
    const namespaceId = element.namespace.namespaceId;
    let loaded: LoadedServices;
    try {
      loaded = await this.loadServices(element.instance, namespaceId);
    } catch (error) {
      return [this.errorNode(error, pageCacheKey(element.instance.id, namespaceId))];
    }
    const children: NacosTreeItem[] = groupServices(loaded.services).map(
      ([group, services]) => new GroupTreeItem(this.scope, element.instance, namespaceId, group, services.length)
    );
    if (loaded.pagesLoaded < loaded.pagesAvailable) {
      children.push(new LoadMoreTreeItem(this.scope, element, loaded.services.length, loaded.totalCount));
    }
    return children;
  }

  private async getGroupChildren(element: GroupTreeItem): Promise<NacosTreeItem[]> {
    let loaded: LoadedServices;
    try {
      loaded = await this.loadServices(element.instance, element.namespaceId);
    } catch (error) {
      return [this.errorNode(error, joinKey(element.instance.id, element.namespaceId, element.group))];
    }
    return loaded.services
      .filter((service) => service.group === element.group)
      .sort((left, right) => left.serviceName.localeCompare(right.serviceName))
      .map((service) => new ServiceTreeItem(this.scope, element.instance, element.namespaceId, service));
  }

  private async getServiceChildren(element: ServiceTreeItem): Promise<NacosTreeItem[]> {
    const ref = serviceRef(element.namespaceId, element.service);
    let instances: NacosInstance[];
    try {
      instances = await this.loadInstances(element.instance, ref);
    } catch (error) {
      return [this.errorNode(error, instanceCacheKey(element.instance.id, ref))];
    }
    return instances.map(
      (serviceInstance) => new ServiceInstanceTreeItem(this.scope, element.instance, ref, serviceInstance)
    );
  }

  /**
   * Rendered under the node that failed rather than thrown, as the instance
   * level does. `ownerId` names that node and not merely its namespace: a
   * namespace, a group of it and a service in that group can all be showing
   * an error at the same moment, and two nodes carrying one id is what VS
   * Code will not draw.
   */
  private errorNode(error: unknown, ownerId: string): ErrorTreeItem {
    return new ErrorTreeItem(this.scope, formatError(error), ownerId);
  }

  /**
   * Synchronous on purpose, exactly as `NacosTreeBase.loadNamespaces` is: it
   * has to reach the `set` before it yields, or two overlapping expansions of
   * one namespace would both find the cache empty and both start a request.
   */
  private loadServices(instance: NacosInstanceConfig, namespaceId: string): Promise<LoadedServices> {
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

  /** Synchronous before its first await, for the reason `loadServices` is. */
  private loadInstances(instance: NacosInstanceConfig, ref: NacosServiceRef): Promise<NacosInstance[]> {
    const key = instanceCacheKey(instance.id, ref);
    const cached = this.instanceCache.get(key);
    if (cached) {
      return cached;
    }
    const pending = this.fetchInstances(instance, ref);
    this.instanceCache.set(key, pending);
    // Evicted on failure and identity-checked on the way out, as every other
    // cache in these two trees is: a rejection left behind is replayed for
    // every later expansion, so collapsing the service and expanding it again
    // would show the first error forever.
    void pending.catch(() => {
      if (this.instanceCache.get(key) === pending) {
        this.instanceCache.delete(key);
      }
    });
    return pending;
  }

  private async fetchInstances(instance: NacosInstanceConfig, ref: NacosServiceRef): Promise<NacosInstance[]> {
    const client = await this.createServiceClient(instance);
    return client.listInstances(ref);
  }

  /**
   * One page, merged into what is already loaded.
   *
   * The group is left out of the query, which is the one thing this request
   * cannot get wrong: absent means every group, and a listing scoped to one
   * group could never produce the group level that sits above it. Nacos's own
   * name-only listing defaults that parameter to `DEFAULT_GROUP` and answers
   * an empty page for a registry that is merely somewhere else -- which is
   * how this milestone's reconnaissance concluded the live server had no
   * services at all.
   */
  private async fetchPage(
    instance: NacosInstanceConfig,
    namespaceId: string,
    loaded: LoadedServices
  ): Promise<LoadedServices> {
    const pageNo = loaded.pagesLoaded + 1;
    const client = await this.createServiceClient(instance);
    const page = await client.listServices({
      namespaceId,
      pageNo,
      pageSize: SERVICE_PAGE_SIZE,
      serviceName: this.filterText
    });
    return mergePage(loaded, page, pageNo);
  }
}

const EMPTY_PAGES: LoadedServices = { services: [], pagesLoaded: 0, pagesAvailable: 1, totalCount: 0 };

/**
 * Appends a page to what is loaded, skipping whatever is already there.
 *
 * The duplicate check is not paranoia about the protocol: a service
 * registered between two page requests shifts the rows, and the same name
 * then arrives twice. Two nodes with one id is what VS Code refuses to
 * render.
 *
 * `pagesLoaded` counts what was asked for rather than what the server said it
 * answered with. A server that ignores the page number would otherwise keep
 * offering Load more forever; counted this way it runs out of pages and the
 * duplicate check makes the extra requests harmless.
 */
function mergePage(loaded: LoadedServices, page: Paged<NacosServiceSummary>, pageNo: number): LoadedServices {
  const services = [...loaded.services];
  const seen = new Set(services.map(serviceKey));
  for (const service of page.items) {
    const key = serviceKey(service);
    if (!seen.has(key)) {
      seen.add(key);
      services.push(service);
    }
  }
  return { services, pagesLoaded: pageNo, pagesAvailable: page.pagesAvailable, totalCount: page.totalCount };
}

/**
 * The loaded services by group, ordered by group name.
 *
 * Sorted rather than left in the order the pages arrived, so that a Load more
 * inserts its new groups in place instead of appending them below the ones the
 * user is already reading.
 */
function groupServices(services: NacosServiceSummary[]): [string, NacosServiceSummary[]][] {
  const grouped = new Map<string, NacosServiceSummary[]>();
  for (const service of services) {
    const bucket = grouped.get(service.group);
    if (bucket) {
      bucket.push(service);
    } else {
      grouped.set(service.group, [service]);
    }
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Where a service lives, with the counts left behind. The instance level
 * needs the address and nothing else, and passing the summary on would let a
 * stale count travel further than the node that displays it.
 *
 * The namespace is the tree's, not the summary's, so that the instances asked
 * for are the ones under the node the user expanded.
 */
function serviceRef(namespaceId: string, service: NacosServiceSummary): NacosServiceRef {
  return { namespaceId, group: service.group, serviceName: service.serviceName };
}

function pageCacheKey(instanceId: string, namespaceId: string): string {
  return joinKey(instanceId, namespaceId);
}

function instanceCacheKey(instanceId: string, ref: NacosServiceRef): string {
  return joinKey(instanceId, ref.namespaceId, ref.group, ref.serviceName);
}

function serviceKey(service: NacosServiceSummary): string {
  return joinKey(service.group, service.serviceName);
}

/**
 * Percent-encoded before joining, so that a separator inside a part cannot
 * pass for the separator between them. A service name really can carry
 * Nacos's own `GROUP@@service` separator inside it, and a group name can
 * carry a colon.
 */
function joinKey(...parts: string[]): string {
  return parts.map(encodeURIComponent).join(':');
}
