import { NacosTreeBase } from './NacosTreeBase';
import type { NacosTreeItem, NacosTreeScope } from './NacosTreeItems';

/**
 * The `atNacos.configs` view. Everything down to the namespace level lives in
 * `NacosTreeBase`, shared with the service tree.
 */
export class ConfigTreeProvider extends NacosTreeBase {
  protected readonly scope: NacosTreeScope = 'config';

  /**
   * M1 stops at the namespace level. M2 answers here with the namespace's
   * groups, and with a "Load more" node once a group runs past a page.
   */
  protected async getChildrenBelowInstance(_element: NacosTreeItem): Promise<NacosTreeItem[]> {
    return [];
  }
}
