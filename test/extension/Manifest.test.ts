import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activate, deactivate } from '../../src/extension';
import { commands as fixtureCommands, window as fixtureWindow } from '../../test-fixtures/vscode';
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
    const contributed = new Set(commands.map((entry) => entry.command));
    for (const item of menus['view/title'] ?? []) {
      expect(contributed.has(item.command), item.command).toBe(true);
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
