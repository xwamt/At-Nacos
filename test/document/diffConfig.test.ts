import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { NacosInstanceConfig } from '../../src/config/schema';
import { buildConfigHistoryUri, buildConfigUri } from '../../src/document/configUri';
import {
  compareConfigAcrossEnvironments,
  diffWithPreviousVersion,
  historyVersionLabel,
  openConfigVersionDiff,
  type CompareConfigClient,
  type PreviousVersionClient
} from '../../src/document/diffConfig';
import { NacosApiError } from '../../src/nacos/NacosApiError';
import type {
  NacosConfigDetail,
  NacosConfigHistoryEntry,
  NacosConfigRef,
  NacosNamespace
} from '../../src/nacos/driver/normalize';

const translate = vscode.l10n.t.bind(vscode.l10n);

afterEach(() => {
  vi.restoreAllMocks();
});

function ref(overrides: Partial<NacosConfigRef> = {}): NacosConfigRef {
  return { namespaceId: 'cl-parent', group: 'cl-intimfy', dataId: 'application-dev.yml', ...overrides };
}

function entry(overrides: Partial<NacosConfigHistoryEntry> = {}): NacosConfigHistoryEntry {
  return {
    ...ref(),
    id: '1044',
    opType: 'U',
    modifiedAt: Date.parse('2026-08-14T02:03:04Z'),
    ...overrides
  };
}

function instance(overrides: Partial<NacosInstanceConfig> = {}): NacosInstanceConfig {
  return {
    id: 'instance-1',
    label: 'prod',
    serverUrl: 'http://nacos.example.com:8848/nacos',
    authMode: 'none',
    readOnly: false,
    allowBackgroundAccess: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

function namespace(overrides: Partial<NacosNamespace> = {}): NacosNamespace {
  return { namespaceId: 'cl-parent-offline', displayName: 'cl-parent-offline', type: 2, ...overrides };
}

function detail(overrides: Partial<NacosConfigDetail> = {}): NacosConfigDetail {
  return { ...ref(), content: 'a: 1\n', ...overrides };
}

/** What `vscode.diff` was executed with, if it was. */
function diffCall(executeCommand: ReturnType<typeof spyOnExecuteCommand>): unknown[] | undefined {
  return executeCommand.mock.calls.find((call) => call[0] === 'vscode.diff');
}

function spyOnExecuteCommand() {
  return vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
}

/** Answers each quick pick in turn with the entry at `index`, or dismisses it when the index is out of range. */
function answerQuickPicks(...indexes: (number | undefined)[]) {
  let call = 0;
  return vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (
    items: readonly unknown[] | Thenable<readonly unknown[]>
  ) => {
    const index = indexes[call];
    call += 1;
    return index === undefined ? undefined : (await items)[index];
  }) as never);
}

describe('openConfigVersionDiff', () => {
  /**
   * The native diff editor, and never a hand-rolled comparison: the whole
   * reason M2 put configurations in real documents is that side-by-side
   * comparison, syntax highlighting and inline navigation come with them.
   */
  it('opens the native diff with the history version on the left and the current content on the right', async () => {
    const executeCommand = spyOnExecuteCommand();

    await openConfigVersionDiff('instance-1', ref(), entry());

    const call = diffCall(executeCommand);
    expect(call?.[0]).toBe('vscode.diff');
    expect(String(call?.[1])).toBe(buildConfigHistoryUri('instance-1', ref(), '1044').toString());
    expect(String(call?.[2])).toBe(buildConfigUri('instance-1', ref()).toString());
  });

  /** Two equal addresses are one buffer, and a diff of one buffer shows no difference at all. */
  it('never puts the same address on both sides', async () => {
    const executeCommand = spyOnExecuteCommand();

    await openConfigVersionDiff('instance-1', ref(), entry());

    const call = diffCall(executeCommand);
    expect(String(call?.[1])).not.toBe(String(call?.[2]));
  });

  it('titles the diff after the configuration and the version it is showing', async () => {
    const executeCommand = spyOnExecuteCommand();

    await openConfigVersionDiff('instance-1', ref(), entry());

    expect(String(diffCall(executeCommand)?.[3])).toContain('application-dev.yml');
    expect(String(diffCall(executeCommand)?.[3])).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('names a version by its record id when the server reported no timestamp', async () => {
    const executeCommand = spyOnExecuteCommand();

    await openConfigVersionDiff('instance-1', ref(), entry({ modifiedAt: undefined }));

    expect(String(diffCall(executeCommand)?.[3])).toContain('1044');
  });
});

describe('historyVersionLabel', () => {
  it('names a version by when it was written', () => {
    expect(historyVersionLabel(entry())).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('falls back to the record id, which every version has', () => {
    expect(historyVersionLabel(entry({ modifiedAt: undefined }))).toContain('1044');
  });
});

describe('diffWithPreviousVersion', () => {
  function client(items: NacosConfigHistoryEntry[], asked: unknown[] = []): PreviousVersionClient {
    return {
      listConfigHistory: async (query: unknown) => {
        asked.push(query);
        return { items, totalCount: items.length, pageNumber: 1, pagesAvailable: 1 };
      }
    } as PreviousVersionClient;
  }

  /**
   * Nacos writes a history row holding the content *before* a change, so the
   * most recent row is the version immediately before the current one. One
   * row is all this needs, and the endpoint is the only paged one Nacos
   * clamps server-side.
   */
  it('asks for the single most recent history row', async () => {
    spyOnExecuteCommand();
    const asked: unknown[] = [];

    await diffWithPreviousVersion({
      instanceId: 'instance-1',
      ref: ref(),
      connect: async () => client([entry()], asked)
    });

    expect(asked).toEqual([{ ...ref(), pageNo: 1, pageSize: 1 }]);
  });

  it('diffs the current content against that row', async () => {
    const executeCommand = spyOnExecuteCommand();

    await diffWithPreviousVersion({ instanceId: 'instance-1', ref: ref(), connect: async () => client([entry()]) });

    expect(String(diffCall(executeCommand)?.[1])).toBe(buildConfigHistoryUri('instance-1', ref(), '1044').toString());
  });

  /**
   * The common case on the server this milestone was verified against, which
   * has no history rows at all. A diff whose left side is empty would read as
   * a configuration that was created from nothing a moment ago.
   */
  it('says there is no earlier version rather than opening a diff with an empty side', async () => {
    const executeCommand = spyOnExecuteCommand();
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');

    await diffWithPreviousVersion({ instanceId: 'instance-1', ref: ref(), connect: async () => client([]) });

    expect(diffCall(executeCommand)).toBeUndefined();
    expect(String(vi.mocked(showInformationMessage).mock.calls[0]?.[0])).toContain('application-dev.yml');
  });

  /** The command that invoked this reports the failure; swallowing it here would lose it. */
  it('lets a failed history read through to its caller', async () => {
    spyOnExecuteCommand();

    await expect(
      diffWithPreviousVersion({
        instanceId: 'instance-1',
        ref: ref(),
        connect: async () => Promise.reject(new Error('HTTP 403'))
      })
    ).rejects.toThrow('HTTP 403');
  });
});

describe('compareConfigAcrossEnvironments', () => {
  function client(overrides: Partial<Record<keyof CompareConfigClient, unknown>> = {}): CompareConfigClient {
    return {
      listNamespaces: async () => [namespace({ namespaceId: 'cl-parent' }), namespace()],
      getConfig: async () => detail(),
      ...overrides
    } as CompareConfigClient;
  }

  function compare(overrides: Partial<Parameters<typeof compareConfigAcrossEnvironments>[0]> = {}): Promise<void> {
    return compareConfigAcrossEnvironments({
      source: { instance: { id: 'instance-1', label: 'prod' }, ref: ref() },
      listInstances: async () => [instance()],
      connect: async () => client(),
      ...overrides
    });
  }

  /**
   * A single instance is not a choice, and a quick pick with one entry is a
   * click spent confirming what the user already said. The namespace pick is
   * still needed -- which is the whole live-verifiable case, since two
   * namespaces of one server are two environments.
   */
  it('asks only for a namespace when one instance is configured', async () => {
    spyOnExecuteCommand();
    const showQuickPick = answerQuickPicks(0);

    await compare();

    expect(showQuickPick).toHaveBeenCalledTimes(1);
    expect(showQuickPick.mock.calls[0]?.[1]).toMatchObject({
      placeHolder: 'Select the namespace to compare with'
    });
  });

  it('asks which instance first when several are configured', async () => {
    spyOnExecuteCommand();
    const showQuickPick = answerQuickPicks(1, 0);

    await compare({ listInstances: async () => [instance(), instance({ id: 'instance-2', label: 'uat' })] });

    expect(showQuickPick).toHaveBeenCalledTimes(2);
    expect(showQuickPick.mock.calls[0]?.[1]).toMatchObject({
      placeHolder: 'Select the Nacos instance to compare with'
    });
  });

  /**
   * Comparing a configuration with itself is the one outcome this command
   * must not produce: both sides would be the same address, so the editor
   * would show a file with no changes.
   */
  it('leaves the source namespace out of the pick when the target is the source instance', async () => {
    spyOnExecuteCommand();
    const showQuickPick = answerQuickPicks(0);

    await compare();

    const offered = await showQuickPick.mock.calls[0]?.[0];
    expect(offered?.map((choice) => choice.description)).toEqual(['cl-parent-offline']);
  });

  it('offers every namespace when the target is another instance', async () => {
    spyOnExecuteCommand();
    const showQuickPick = answerQuickPicks(1, 0);

    await compare({ listInstances: async () => [instance(), instance({ id: 'instance-2', label: 'uat' })] });

    const offered = await showQuickPick.mock.calls[1]?.[0];
    expect(offered?.map((choice) => choice.description)).toEqual(['cl-parent', 'cl-parent-offline']);
  });

  it('opens the diff with the configuration the user started from on the left', async () => {
    const executeCommand = spyOnExecuteCommand();
    answerQuickPicks(0);

    await compare();

    const call = diffCall(executeCommand);
    expect(String(call?.[1])).toBe(buildConfigUri('instance-1', ref()).toString());
    expect(String(call?.[2])).toBe(buildConfigUri('instance-1', ref({ namespaceId: 'cl-parent-offline' })).toString());
  });

  it('titles the diff after both environments', async () => {
    const executeCommand = spyOnExecuteCommand();
    answerQuickPicks(0);

    await compare();

    const title = String(diffCall(executeCommand)?.[3]);
    expect(title).toContain('application-dev.yml');
    expect(title).toContain('cl-parent');
    expect(title).toContain('cl-parent-offline');
  });

  it('builds the target address from the instance that was picked', async () => {
    const executeCommand = spyOnExecuteCommand();
    answerQuickPicks(1, 1);

    await compare({ listInstances: async () => [instance(), instance({ id: 'instance-2', label: 'uat' })] });

    expect(String(diffCall(executeCommand)?.[2])).toBe(
      buildConfigUri('instance-2', ref({ namespaceId: 'cl-parent-offline' })).toString()
    );
  });

  /**
   * `getConfig` raises `resource-not-found` for a dataId nobody published,
   * and that kind deliberately does not fall through -- so it can be told
   * apart from a transport failure and answered with a sentence instead of a
   * blank right-hand pane.
   */
  it('says the target has no such configuration rather than opening a blank side', async () => {
    const executeCommand = spyOnExecuteCommand();
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
    answerQuickPicks(0);

    await compare({
      connect: async () =>
        client({
          getConfig: async () => {
            throw new NacosApiError('resource-not-found', 'config data not exist', 404);
          }
        })
    });

    expect(diffCall(executeCommand)).toBeUndefined();
    const message = String(vi.mocked(showInformationMessage).mock.calls[0]?.[0]);
    expect(message).toContain('application-dev.yml');
    expect(message).toContain('cl-parent-offline');
  });

  it('lets any other failure through, so it is not reported as a missing configuration', async () => {
    spyOnExecuteCommand();
    answerQuickPicks(0);

    await expect(
      compare({
        connect: async () =>
          client({
            getConfig: async () => {
              throw new NacosApiError('api-error', 'HTTP 500 from /v1/cs/configs', 500);
            }
          })
      })
    ).rejects.toThrow('HTTP 500');
  });

  it('opens nothing when the instance pick is dismissed', async () => {
    const executeCommand = spyOnExecuteCommand();
    answerQuickPicks(undefined);

    await compare({ listInstances: async () => [instance(), instance({ id: 'instance-2', label: 'uat' })] });

    expect(diffCall(executeCommand)).toBeUndefined();
  });

  it('opens nothing when the namespace pick is dismissed', async () => {
    const executeCommand = spyOnExecuteCommand();
    answerQuickPicks(undefined);

    await compare();

    expect(diffCall(executeCommand)).toBeUndefined();
  });

  /** One instance holding one namespace has nothing to compare with, and a pick with no entries says nothing. */
  it('says so when the target instance has no other namespace to offer', async () => {
    const executeCommand = spyOnExecuteCommand();
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
    const showQuickPick = answerQuickPicks(0);

    await compare({ connect: async () => client({ listNamespaces: async () => [namespace({ namespaceId: 'cl-parent' })] }) });

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(diffCall(executeCommand)).toBeUndefined();
    expect(showInformationMessage).toHaveBeenCalled();
  });

  it('says so when no instance is configured at all', async () => {
    const executeCommand = spyOnExecuteCommand();
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');

    await compare({ listInstances: async () => [] });

    expect(diffCall(executeCommand)).toBeUndefined();
    expect(showInformationMessage).toHaveBeenCalled();
  });

  /** 1.x and 2.x spell the default namespace as the empty string, which no pick can show as a label. */
  it('names the default namespace in the pick rather than offering a blank entry', async () => {
    spyOnExecuteCommand();
    const showQuickPick = answerQuickPicks(0);

    await compare({
      connect: async () => client({ listNamespaces: async () => [{ namespaceId: '', displayName: '', type: 0 }] })
    });

    const offered = await showQuickPick.mock.calls[0]?.[0];
    expect(offered?.[0]?.label).toBe('public');
  });
});

describe('localization', () => {
  it('routes every message it shows through a key the zh-cn bundle translates', async () => {
    const bundle = JSON.parse(readFileSync(resolve(process.cwd(), 'l10n/bundle.l10n.zh-cn.json'), 'utf8')) as Record<
      string,
      string
    >;
    const sources: string[] = [];
    vi.spyOn(vscode.l10n, 't').mockImplementation((messageOrOptions: string | { message: string }, ...args: never[]) => {
      const message = typeof messageOrOptions === 'string' ? messageOrOptions : messageOrOptions.message;
      sources.push(message);
      return translate(message, ...args);
    });
    spyOnExecuteCommand();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    answerQuickPicks(0, undefined, undefined);

    await openConfigVersionDiff('instance-1', ref(), entry());
    await openConfigVersionDiff('instance-1', ref(), entry({ modifiedAt: undefined }));
    await diffWithPreviousVersion({
      instanceId: 'instance-1',
      ref: ref(),
      connect: async () =>
        ({ listConfigHistory: async () => ({ items: [], totalCount: 0, pageNumber: 1, pagesAvailable: 0 }) }) as PreviousVersionClient
    });
    await compareConfigAcrossEnvironments({
      source: { instance: { id: 'instance-1', label: 'prod' }, ref: ref() },
      listInstances: async () => [instance()],
      connect: async () =>
        ({
          listNamespaces: async () => [namespace(), { namespaceId: '', displayName: '', type: 0 }],
          getConfig: async () => {
            throw new NacosApiError('resource-not-found', 'config data not exist', 404);
          }
        }) as CompareConfigClient
    });
    await compareConfigAcrossEnvironments({
      source: { instance: { id: 'instance-1', label: 'prod' }, ref: ref() },
      listInstances: async () => [],
      connect: async () => ({}) as CompareConfigClient
    });
    await compareConfigAcrossEnvironments({
      source: { instance: { id: 'instance-1', label: 'prod' }, ref: ref() },
      listInstances: async () => [instance()],
      connect: async () => ({ listNamespaces: async () => [namespace({ namespaceId: 'cl-parent' })] }) as CompareConfigClient
    });

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(Object.keys(bundle), source).toContain(source);
    }
  });
});
