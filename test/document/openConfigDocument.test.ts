import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { parseConfigUri } from '../../src/document/configUri';
import { openConfigDocument } from '../../src/document/openConfigDocument';
import type { NacosConfigSummary } from '../../src/nacos/driver/normalize';

function summary(overrides: Partial<NacosConfigSummary> = {}): NacosConfigSummary {
  return { namespaceId: 'uat', group: 'cl-intimfy', dataId: 'application-uat.yml', type: 'yaml', ...overrides };
}

function spyOnLanguage() {
  return vi.spyOn(vscode.languages, 'setTextDocumentLanguage');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openConfigDocument', () => {
  it('opens the nacos: document that addresses the configuration', async () => {
    const config = summary({ namespaceId: '', dataId: 'com/example/service.yml' });

    const document = await openConfigDocument('instance-1', config);

    expect(parseConfigUri(document.uri)).toEqual({
      instanceId: 'instance-1',
      ref: { namespaceId: '', group: 'cl-intimfy', dataId: 'com/example/service.yml' }
    });
  });

  it('shows the document it opened', async () => {
    const shown = vi.spyOn(vscode.window, 'showTextDocument');

    await openConfigDocument('instance-1', summary());

    expect(shown).toHaveBeenCalledTimes(1);
  });
});

/**
 * The language mode is set explicitly rather than guessed from the address.
 * Guessing would mean appending an extension the dataId does not have, which
 * shows up in the tab title -- and most dataIds already carry one of their
 * own.
 */
describe('openConfigDocument language mode', () => {
  it('sets the language from the type the server reported', async () => {
    const setLanguage = spyOnLanguage();

    await openConfigDocument('instance-1', summary({ dataId: 'application-uat', type: 'yaml' }));

    expect(setLanguage.mock.calls[0][1]).toBe('yaml');
  });

  /**
   * The case that makes this a required path rather than a safety net: Nacos
   * populates `type` only under `search=accurate`, and the tree's filter
   * searches with blur. The moment a user filters, the dataId is all there is.
   */
  it('falls back to the dataId suffix when a blur search left the type out', async () => {
    const setLanguage = spyOnLanguage();

    await openConfigDocument('instance-1', summary({ dataId: 'application-uat.yml', type: undefined }));

    expect(setLanguage.mock.calls[0][1]).toBe('yaml');
  });

  it('lets the type win over a dataId suffix that disagrees with it', async () => {
    const setLanguage = spyOnLanguage();

    await openConfigDocument('instance-1', summary({ dataId: 'application-uat.yml', type: 'json' }));

    expect(setLanguage.mock.calls[0][1]).toBe('json');
  });

  it('falls back to plaintext when neither the type nor the dataId says anything', async () => {
    const setLanguage = spyOnLanguage();

    await openConfigDocument('instance-1', summary({ dataId: 'application-uat', type: undefined }));

    expect(setLanguage.mock.calls[0][1]).toBe('plaintext');
  });

  it('appends no extension to the address, so the tab is titled with the dataId itself', async () => {
    const document = await openConfigDocument('instance-1', summary({ dataId: 'application-uat', type: 'yaml' }));

    expect(document.uri.path.endsWith('/application-uat')).toBe(true);
  });

  /** Otherwise the user watches the text re-tokenize a frame after the editor appears. */
  it('sets the language before revealing the editor', async () => {
    const setLanguage = spyOnLanguage();
    const shown = vi.spyOn(vscode.window, 'showTextDocument');

    await openConfigDocument('instance-1', summary());

    expect(setLanguage.mock.invocationCallOrder[0]).toBeLessThan(shown.mock.invocationCallOrder[0]);
  });

  it('returns the document carrying the language it set', async () => {
    const document = await openConfigDocument('instance-1', summary({ dataId: 'app.properties', type: undefined }));

    expect(document.languageId).toBe('properties');
  });
});
