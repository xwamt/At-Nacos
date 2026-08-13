import { NacosTreeBase } from './NacosTreeBase';
import type { NacosTreeItem, NacosTreeScope } from './NacosTreeItems';

/**
 * The `atNacos.services` view. Everything down to the namespace level lives
 * in `NacosTreeBase`, shared with the configuration tree.
 */
export class ServiceTreeProvider extends NacosTreeBase {
  protected readonly scope: NacosTreeScope = 'service';

  /** M1 stops at the namespace level. M3 answers here with services and their instances. */
  protected async getChildrenBelowInstance(_element: NacosTreeItem): Promise<NacosTreeItem[]> {
    return [];
  }
}
