import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { activate, deactivate } from '../../src/extension';
import {
  ConfigTreeItem,
  GroupTreeItem,
  ServiceInstanceTreeItem,
  ServiceTreeItem
} from '../../src/tree/NacosTreeItems';
import {
  commands as fixtureCommands,
  window as fixtureWindow,
  workspace as fixtureWorkspace
} from '../../test-fixtures/vscode';
import { extensionContext } from './extensionContext';

interface Manifest {
  icon?: string;
  main: string;
  contributes: {
    viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
    views: Record<string, { id: string; name: string }[]>;
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
    viewsWelcome: { view: string; contents: string }[];
  };
}

/**
 * Read from disk rather than imported, so the assertions are about the file
 * that actually ships. Anchored on `process.cwd()` the way `vitest.config.ts`
 * anchors its `vscode` alias.
 */
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as Manifest;

const { commands, menus, views, viewsContainers, viewsWelcome } = manifest.contributes;

describe('package.json contributions', () => {
  beforeEach(async () => {
    await deactivate();
    fixtureCommands.__clearRegisteredCommands();
    fixtureWindow.__clearTreeViews();
    fixtureWindow.__clearLogChannels();
    fixtureWorkspace.__clearContentProviders();
  });

  afterEach(async () => {
    await deactivate();
    vi.restoreAllMocks();
  });

  it('registers a handler for exactly the commands it contributes', () => {
    // A contributed command with no handler is offered in the palette and
    // fails with "command not found" when picked; a registered command that is
    // not contributed can only be reached from code. Both are invisible until
    // someone clicks.
    activate(extensionContext());

    expect([...fixtureCommands.__getRegisteredCommands().keys()].sort()).toEqual(
      commands.map((entry) => entry.command).sort()
    );
  });

  it('creates a view for exactly the view ids it contributes', () => {
    activate(extensionContext());

    expect(fixtureWindow.__getTreeViews().map((view) => view.viewId)).toEqual(
      (views.atNacos ?? []).map((view) => view.id)
    );
  });

  it('puts every view in the activity bar container it declares', () => {
    expect(viewsContainers.activitybar.map((container) => container.id)).toEqual(['atNacos']);
    expect(Object.keys(views)).toEqual(['atNacos']);
  });

  it('references only contributed commands from its menus', () => {
    // Every menu, not only `view/title`: a `commandPalette` entry naming a
    // command that no longer exists is silently ignored, so the command it was
    // meant to hide comes back into the palette.
    const contributed = new Set(commands.map((entry) => entry.command));
    for (const [location, items] of Object.entries(menus)) {
      for (const item of items) {
        expect(contributed.has(item.command), `${location}: ${item.command}`).toBe(true);
      }
    }
  });

  it('scopes every view/title menu item to a view it contributes', () => {
    const viewIds = new Set((views.atNacos ?? []).map((view) => view.id));
    for (const item of menus['view/title'] ?? []) {
      const scoped = /view == ([\w.]+)/.exec(item.when ?? '');
      expect(scoped?.[1], item.command).toBeDefined();
      expect(viewIds.has(scoped?.[1] ?? ''), item.command).toBe(true);
    }
  });

  /**
   * A view/title command with no icon is folded into the `...` overflow menu,
   * where a filter nobody can see is a filter nobody uses.
   */
  it.each([
    ['atNacos.filterConfigs', '$(filter)'],
    ['atNacos.clearConfigFilter', '$(clear-all)']
  ])('puts %s on the configurations view title with an icon', (command, icon) => {
    expect(commands.find((entry) => entry.command === command)?.icon).toBe(icon);
    expect((menus['view/title'] ?? []).filter((item) => item.command === command).map((item) => item.when)).toEqual([
      'view == atNacos.configs'
    ]);
  });

  it.each([
    ['atNacos.filterServices', '$(filter)'],
    ['atNacos.clearServiceFilter', '$(clear-all)']
  ])('puts %s on the services view title with an icon', (command, icon) => {
    expect(commands.find((entry) => entry.command === command)?.icon).toBe(icon);
    expect((menus['view/title'] ?? []).filter((item) => item.command === command).map((item) => item.when)).toEqual([
      'view == atNacos.services'
    ]);
  });

  /**
   * The cluster is a property of the server, not of either listing, so the
   * panel is reachable from whichever view the user happens to be in.
   */
  it('puts the cluster status panel on both view titles with an icon', () => {
    expect(commands.find((entry) => entry.command === 'atNacos.openClusterStatus')?.icon).toBe('$(server)');
    expect(
      (menus['view/title'] ?? [])
        .filter((item) => item.command === 'atNacos.openClusterStatus')
        .map((item) => item.when)
    ).toEqual(['view == atNacos.configs', 'view == atNacos.services']);
  });

  /**
   * All three are invoked by a tree node carrying arguments. Picked from the
   * palette they arrive with none: `openConfig` would be asked to open
   * `undefined` and either paging command to page a namespace that was not
   * named. `when: false` is the only way a contributed command stays out of it.
   */
  it.each([
    ['atNacos.openConfig'],
    ['atNacos.loadMoreConfigs'],
    ['atNacos.loadMoreServices'],
    ['atNacos.showConfigHistory'],
    ['atNacos.diffWithPrevious'],
    ['atNacos.compareAcrossEnvironments'],
    ['atNacos.showConfigListeners'],
    ['atNacos.showServiceSubscribers'],
    ['atNacos.editConfig'],
    ['atNacos.publishConfig'],
    ['atNacos.deleteConfig'],
    ['atNacos.enableServiceInstance'],
    ['atNacos.disableServiceInstance']
  ])(
    'hides %s from the command palette, since only a tree node can supply its arguments',
    (command) => {
      expect((menus.commandPalette ?? []).filter((item) => item.command === command).map((item) => item.when)).toEqual([
        'false'
      ]);
    }
  );

  /**
   * Both MCP config commands take no arguments, so the palette is exactly
   * where they are invoked from. A `commandPalette` entry naming either one
   * could only hide it.
   */
  it.each([['atNacos.installMcpConfig'], ['atNacos.uninstallMcpConfig']])(
    'contributes %s and leaves it visible in the command palette',
    (command) => {
      expect(commands.some((entry) => entry.command === command)).toBe(true);
      expect((menus.commandPalette ?? []).some((item) => item.command === command)).toBe(false);
    }
  );

  /** A palette entry with any other `when` is a command that can still be picked with no arguments. */
  it('writes no commandPalette entry that leaves a command visible', () => {
    for (const item of menus.commandPalette ?? []) {
      expect(item.when, item.command).toBe('false');
    }
  });

  /**
   * The `when` clause of a node menu, as the regular expression VS Code
   * compiles it into. Asserting on the clause as text would pass for a
   * pattern that matches nothing.
   */
  function contextValuePattern(when: string | undefined): RegExp {
    const written = /^viewItem =~ \/(.+)\/$/.exec(when ?? '');
    expect(written, when).not.toBeNull();
    return new RegExp(written?.[1] ?? '$^');
  }

  function nodeMenu(command: string): { command: string; when?: string; group?: string } {
    const items = (menus['view/item/context'] ?? []).filter((item) => item.command === command);
    expect(items, command).toHaveLength(1);
    return items[0] as { command: string; when?: string; group?: string };
  }

  function instance(readOnly: boolean): NacosInstanceConfig {
    return {
      id: 'instance-1',
      label: 'prod',
      serverUrl: 'http://nacos.example.com:8848/nacos',
      authMode: 'none',
      readOnly,
      allowBackgroundAccess: false,
      createdAt: 0,
      updatedAt: 0
    };
  }

  function configNodeValue(readOnly: boolean): string {
    return String(
      new ConfigTreeItem('config', instance(readOnly), 'uat', {
        namespaceId: 'uat',
        group: 'cl-intimfy',
        dataId: 'application-uat.yml'
      }).contextValue
    );
  }

  function serviceNodeValue(readOnly: boolean): string {
    return String(
      new ServiceTreeItem('service', instance(readOnly), 'uat', {
        namespaceId: 'uat',
        group: 'cl-intimfy',
        serviceName: 'cl-auth'
      }).contextValue
    );
  }

  /**
   * Every one of these is a read, so it belongs on a read-only instance's
   * nodes too -- which carry a `.readonly` suffix that a `==` comparison
   * would miss.
   */
  it.each([
    ['atNacos.showConfigHistory'],
    ['atNacos.diffWithPrevious'],
    ['atNacos.compareAcrossEnvironments'],
    ['atNacos.showConfigListeners']
  ])('offers %s on a configuration node of a writable and of a read-only instance', (command) => {
    const pattern = contextValuePattern(nodeMenu(command).when);

    expect(pattern.test(configNodeValue(false)), configNodeValue(false)).toBe(true);
    expect(pattern.test(configNodeValue(true)), configNodeValue(true)).toBe(true);
    expect(pattern.test(serviceNodeValue(false))).toBe(false);
    expect(pattern.test(String(new GroupTreeItem('config', instance(false), 'uat', 'g', 1).contextValue))).toBe(false);
  });

  /**
   * The trap in the service clause: `atNacos.serviceInstance` starts with
   * `atNacos.service`, and a prefix match would put a subscriber panel on
   * every registered instance node under it.
   */
  it('offers the subscriber panel on a service node and on nothing under it', () => {
    const pattern = contextValuePattern(nodeMenu('atNacos.showServiceSubscribers').when);
    const serviceInstanceValue = String(
      new ServiceInstanceTreeItem(
        'service',
        instance(false),
        { namespaceId: 'uat', group: 'cl-intimfy', serviceName: 'cl-auth' },
        { ip: '10.0.0.1', port: 8080, healthy: true, enabled: true, weight: 1, clusterName: 'DEFAULT', ephemeral: true, metadata: {} }
      ).contextValue
    );

    expect(pattern.test(serviceNodeValue(false))).toBe(true);
    expect(pattern.test(serviceNodeValue(true))).toBe(true);
    expect(pattern.test(serviceInstanceValue), serviceInstanceValue).toBe(false);
    expect(pattern.test(configNodeValue(false))).toBe(false);
  });

  /** A node menu with no group is appended to whatever came before it, in registration order. */
  it('groups the configuration node actions together', () => {
    for (const command of [
      'atNacos.showConfigHistory',
      'atNacos.diffWithPrevious',
      'atNacos.compareAcrossEnvironments',
      'atNacos.showConfigListeners'
    ]) {
      expect(nodeMenu(command).group, command).toMatch(/^atNacos\.inspect@\d$/);
    }
  });

  it.each([
    ['atNacos.editConfig'],
    ['atNacos.publishConfig'],
    ['atNacos.deleteConfig']
  ])('hides write command %s on a read-only configuration node', (command) => {
    const item = nodeMenu(command);
    expect(item.when).toBe('viewItem == atNacos.config');

    // Matches writable config node contextValue
    expect(configNodeValue(false)).toBe('atNacos.config');
    // Does not match read-only config node contextValue
    expect(configNodeValue(true)).toBe('atNacos.config.readonly');
  });

  it('shows enableServiceInstance only on disabled service instances and disableServiceInstance only on enabled instances', () => {
    const enableItem = nodeMenu('atNacos.enableServiceInstance');
    expect(enableItem.when).toBe('viewItem == atNacos.serviceInstance.disabled');

    const disableItem = nodeMenu('atNacos.disableServiceInstance');
    expect(disableItem.when).toBe('viewItem == atNacos.serviceInstance.enabled');
  });

  it('attaches its welcome view to a view it contributes', () => {
    const viewIds = new Set((views.atNacos ?? []).map((view) => view.id));
    for (const welcome of viewsWelcome) {
      expect(viewIds.has(welcome.view), welcome.view).toBe(true);
    }
  });

  it('ships every icon file it points at', () => {
    // A dangling path here fails `vsce package` rather than the build, so
    // nothing else in this repository would catch it. The marketplace icon is
    // deliberately absent until M6, which is why `icon` is checked only if it
    // is present at all.
    const referenced = [...viewsContainers.activitybar.map((container) => container.icon), manifest.icon].filter(
      (path): path is string => typeof path === 'string'
    );
    expect(referenced).toContain('media/at-nacos-activity.svg');
    for (const path of referenced) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(true);
    }
  });

  it('draws the activity bar icon in the theme colour rather than a baked-in one', () => {
    // VS Code recolours this per theme, and only `currentColor` follows. A
    // hard-coded fill looks wrong in half the themes and invisible in some.
    const svg = readFileSync(resolve(process.cwd(), 'media/at-nacos-activity.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('currentColor');
    expect(svg).not.toMatch(/<style|<image|fill="#|stroke="#/);
  });

  it('points main at the bundle esbuild emits', () => {
    expect(manifest.main).toBe('./dist/extension.js');
  });
});
