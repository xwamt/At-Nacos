import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NacosInstanceConfigManager } from '../../src/config/NacosInstanceConfigManager';
import type { ExtensionMemento, SecretStore } from '../../src/config/NacosInstanceConfigManager';
import type { LogLevelName, LogSink } from '../../src/utils/logger';

/** The globalState key the manager owns; seeding tests have to name it. */
const INSTANCES_KEY = 'atNacos.instances';

/** A well-formed record as a previous session would have left it behind. */
const storedRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'prod',
  serverUrl: 'http://h:8848/nacos',
  authMode: 'none',
  readOnly: false,
  allowBackgroundAccess: false,
  createdAt: 1,
  updatedAt: 2
};

interface TestMemento extends ExtensionMemento {
  /** Plant a value the way a previous version of the extension would have. */
  seed(key: string, value: unknown): void;
  /** The raw stored value, before the manager gets a chance to parse it. */
  peek(key: string): unknown;
}

function createMemento(): TestMemento {
  const store = new Map<string, unknown>();
  return {
    // VS Code's Memento falls back to the default only when the key is
    // absent -- a stored `null` comes back as `null`. A `??` here would hand
    // the manager an empty array for exactly the corrupt values these tests
    // exist to reach, and the suite would prove nothing about them.
    get<T>(key: string, defaultValue: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    seed(key: string, value: unknown): void {
      store.set(key, value);
    },
    peek(key: string): unknown {
      return store.get(key);
    }
  };
}

function createSecrets(): SecretStore & { snapshot(): Map<string, string> } {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key);
    },
    async store(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    snapshot: () => store
  };
}

function createLog(): LogSink & { entries: string[] } {
  const entries: string[] = [];
  const at = (level: LogLevelName) => (message: string) => {
    entries.push(`${level}: ${message}`);
  };
  return {
    entries,
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace')
  };
}

describe('NacosInstanceConfigManager', () => {
  let memento: TestMemento;
  let secrets: ReturnType<typeof createSecrets>;
  let manager: NacosInstanceConfigManager;

  beforeEach(() => {
    memento = createMemento();
    secrets = createSecrets();
    manager = new NacosInstanceConfigManager(memento, secrets);
  });

  it('creates an instance and stores the password in SecretStorage, not globalState', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });
    const listed = await manager.listInstances();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('hunter2');
    expect(await manager.getPassword(created.id)).toBe('hunter2');
  });

  it('keeps the username in globalState, where it is not a credential', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      username: '  nacos  '
    });
    expect(created.username).toBe('nacos');
    expect(JSON.stringify(memento.peek(INSTANCES_KEY))).toContain('nacos');
  });

  it('stores no secret at all for an instance that uses no auth', async () => {
    await manager.createInstance({ label: 'local', serverUrl: 'http://h:8848', authMode: 'none' });
    expect(secrets.snapshot().size).toBe(0);
  });

  /**
   * The form promises the password is "kept in VS Code SecretStorage, never in
   * settings", and an address carrying userinfo is the one way it ends up in
   * settings anyway. `redactSensitiveText` cannot save it either: there is no
   * `password=` marker for its pattern to anchor on.
   */
  it('writes no credential to globalState for a serverUrl that carries one', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://admin:hunter2@h:8848/nacos',
      authMode: 'none'
    });

    expect(created.serverUrl).toBe('http://h:8848/nacos');
    expect(JSON.stringify(memento.peek(INSTANCES_KEY))).not.toContain('hunter2');
    expect(JSON.stringify(memento.peek(INSTANCES_KEY))).not.toContain('admin');
  });

  /** Retroactive, which refusing the record could not be: the credential is already on disk. */
  it('strips the credential out of a record an earlier version stored with one', async () => {
    memento.seed(INSTANCES_KEY, [{ ...storedRecord, serverUrl: 'http://admin:hunter2@h:8848/nacos' }]);

    const listed = await manager.listInstances();

    expect(listed[0]?.serverUrl).toBe('http://h:8848/nacos');
    expect(JSON.stringify(listed)).not.toContain('hunter2');
  });

  it('rejects a serverUrl the schema cannot normalize', async () => {
    await expect(
      manager.createInstance({ label: 'prod', serverUrl: 'nacos.example.com', authMode: 'none' })
    ).rejects.toThrow();
  });

  it('trims surrounding whitespace from the label', async () => {
    const created = await manager.createInstance({
      label: '  prod  ',
      serverUrl: 'http://h:8848',
      authMode: 'none'
    });
    expect(created.label).toBe('prod');
  });

  it('keeps the Nacos 3.x console URL when the form supplies one', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      consoleUrl: 'http://h:8080/',
      authMode: 'none'
    });
    expect(created.consoleUrl).toBe('http://h:8080');
  });

  it('treats a blank consoleUrl as absent so probing can fill it in', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      consoleUrl: '   ',
      authMode: 'none'
    });
    expect(created.consoleUrl).toBeUndefined();
  });

  it('defaults both guard flags to false', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848',
      authMode: 'none'
    });
    expect(created.readOnly).toBe(false);
    expect(created.allowBackgroundAccess).toBe(false);
  });

  it('carries the guard flags through create and update', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848',
      authMode: 'none',
      readOnly: true,
      allowBackgroundAccess: true
    });
    expect(created.readOnly).toBe(true);

    const updated = await manager.updateInstance(created.id, { allowBackgroundAccess: false });
    expect(updated.allowBackgroundAccess).toBe(false);
    expect(updated.readOnly).toBe(true);
  });

  it('keeps the stored password when update passes undefined', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });
    await manager.updateInstance(created.id, { label: 'prod-renamed' });
    expect(await manager.getPassword(created.id)).toBe('hunter2');
  });

  it('rotates the stored password when update passes a new one', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });
    await manager.updateInstance(created.id, {}, { password: 'hunter3' });
    expect(await manager.getPassword(created.id)).toBe('hunter3');
  });

  it('clears the stored password when update passes an empty string', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });
    await manager.updateInstance(created.id, {}, { password: '' });
    expect(await manager.getPassword(created.id)).toBe('');
  });

  it('keeps the stored password when the auth mode changes', async () => {
    // Flipping the mode by mistake is two clicks; making it cost the password
    // would be worse than leaving one keychain entry that the strategy for the
    // current mode never reads. Removing the instance still removes both.
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });
    await manager.updateInstance(created.id, { authMode: 'customHeader' });
    expect(await manager.getPassword(created.id)).toBe('hunter2');
  });

  it('returns no password for an instance that never had one', async () => {
    const created = await manager.createInstance({
      label: 'local',
      serverUrl: 'http://h:8848',
      authMode: 'none'
    });
    expect(await manager.getPassword(created.id)).toBeUndefined();
  });

  it('round-trips custom headers through SecretStorage', async () => {
    const created = await manager.createInstance({
      label: 'gw',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'customHeader',
      customHeaders: { 'X-Gateway-Token': 'abc' }
    });
    expect(await manager.getCustomHeaders(created.id)).toEqual({ 'X-Gateway-Token': 'abc' });
    expect(JSON.stringify(await manager.listInstances())).not.toContain('abc');
  });

  it('replaces custom headers when update passes a new map', async () => {
    const created = await manager.createInstance({
      label: 'gw',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'customHeader',
      customHeaders: { 'X-Gateway-Token': 'abc' }
    });
    await manager.updateInstance(created.id, {}, { customHeaders: { 'X-Gateway-Token': 'def' } });
    expect(await manager.getCustomHeaders(created.id)).toEqual({ 'X-Gateway-Token': 'def' });
  });

  it('returns no custom headers for an instance that only ever had a password', async () => {
    // The two secret kinds live under prefixes of their own; a password must
    // never surface as a header map.
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'hunter2'
    });
    expect(await manager.getCustomHeaders(created.id)).toBeUndefined();
  });

  it('returns no custom headers when the stored secret is not valid JSON', async () => {
    const created = await manager.createInstance({
      label: 'gw',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'customHeader',
      customHeaders: { 'X-Gateway-Token': 'abc' }
    });
    const corrupt = '{"X-Gateway-Token": "abc"';
    expect(() => JSON.parse(corrupt)).toThrow();

    await secrets.store(manager.headersKey(created.id), corrupt);

    expect(await manager.getCustomHeaders(created.id)).toBeUndefined();
  });

  it('returns no custom headers when the stored JSON is not a string map', async () => {
    const created = await manager.createInstance({
      label: 'gw',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'customHeader',
      customHeaders: { 'X-Gateway-Token': 'abc' }
    });
    for (const stored of ['{"a":1}', '["a"]', 'null', '"a"', '{"a":{"b":"c"}}']) {
      await secrets.store(manager.headersKey(created.id), stored);
      expect(await manager.getCustomHeaders(created.id)).toBeUndefined();
    }
  });

  it('deletes every secret belonging to a removed instance', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848/nacos',
      authMode: 'customHeader',
      customHeaders: { 'X-Gateway-Token': 'abc' }
    });
    await manager.deleteInstance(created.id);
    expect(await manager.listInstances()).toEqual([]);
    expect(secrets.snapshot().size).toBe(0);
  });

  it('leaves another instance untouched when one is deleted', async () => {
    const doomed = await manager.createInstance({
      label: 'doomed',
      serverUrl: 'http://h:8848',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'gone'
    });
    const kept = await manager.createInstance({
      label: 'kept',
      serverUrl: 'http://h:8849',
      authMode: 'userPassword',
      username: 'nacos',
      password: 'stays'
    });

    await manager.deleteInstance(doomed.id);

    expect((await manager.listInstances()).map((instance) => instance.id)).toEqual([kept.id]);
    expect(await manager.getPassword(kept.id)).toBe('stays');
  });

  it('ignores a delete for an unknown id', async () => {
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848',
      authMode: 'none'
    });
    await expect(manager.deleteInstance('missing')).resolves.toBeUndefined();
    expect((await manager.listInstances()).map((instance) => instance.id)).toEqual([created.id]);
  });

  it('throws when updating an unknown id', async () => {
    await expect(manager.updateInstance('missing', { label: 'x' })).rejects.toThrow();
  });

  it('returns undefined from getInstance for an unknown id', async () => {
    expect(await manager.getInstance('missing')).toBeUndefined();
  });

  it('keeps createdAt and advances updatedAt on update', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848',
      authMode: 'none'
    });
    now.mockReturnValue(2_000);

    const updated = await manager.updateInstance(created.id, { label: 'prod-renamed' });

    expect(updated.createdAt).toBe(1_000);
    expect(updated.updatedAt).toBe(2_000);
    now.mockRestore();
  });

  it('sorts instances by label so tree order is stable across writes', async () => {
    await manager.createInstance({ label: 'zeta', serverUrl: 'http://h:8848', authMode: 'none' });
    await manager.createInstance({ label: 'alpha', serverUrl: 'http://h:8849', authMode: 'none' });
    expect((await manager.listInstances()).map((i) => i.label)).toEqual(['alpha', 'zeta']);
  });

  it('keeps two instances that share a label apart by id', async () => {
    const first = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848',
      authMode: 'none'
    });
    const second = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8849',
      authMode: 'none'
    });

    expect(second.id).not.toBe(first.id);
    await manager.updateInstance(first.id, { serverUrl: 'http://h:9848' });

    const listed = await manager.listInstances();
    expect(listed).toHaveLength(2);
    expect((await manager.getInstance(second.id))?.serverUrl).toBe('http://h:8849');
  });

  it('reads a record that carries a field written by a newer version', async () => {
    memento.seed(INSTANCES_KEY, [{ ...storedRecord, region: 'cn-hangzhou' }]);
    expect((await manager.listInstances()).map((instance) => instance.label)).toEqual(['prod']);
  });

  it('erases a field it does not know when it rewrites the record', async () => {
    // The standing cost of stripping instead of being strict: a downgraded
    // install can read what a newer version wrote, but editing the instance
    // drops the newer field. Whoever adds one has to expect that.
    memento.seed(INSTANCES_KEY, [{ ...storedRecord, region: 'cn-hangzhou' }]);

    await manager.updateInstance(storedRecord.id, { label: 'prod-renamed' });

    expect(JSON.stringify(memento.peek(INSTANCES_KEY))).not.toContain('cn-hangzhou');
  });

  it('throws instead of dropping a stored record it cannot parse', async () => {
    // Dropping it would not stay a read-time decision: the next write persists
    // whatever the read returned, so a damaged record would be erased for
    // good. Throwing costs one error node in the tree and keeps it on disk.
    memento.seed(INSTANCES_KEY, [storedRecord, { id: 'orphan' }]);
    await expect(manager.listInstances()).rejects.toThrow();
  });

  it('treats a globalState value that is not an array as an empty list', async () => {
    // globalState holds whatever any previous version wrote, and none of these
    // shapes carries a recoverable instance. Throwing here would take the one
    // recovery path the UI has with it, because every write reads first.
    for (const stored of [null, 'nope', 42, { instances: [] }]) {
      const corrupt = createMemento();
      corrupt.seed(INSTANCES_KEY, stored);
      const recovering = new NacosInstanceConfigManager(corrupt, createSecrets());
      expect(await recovering.listInstances()).toEqual([]);
    }
  });

  it('lets a corrupt globalState value be overwritten by adding an instance', async () => {
    memento.seed(INSTANCES_KEY, 'nope');

    const created = await manager.createInstance({
      label: 'prod',
      serverUrl: 'http://h:8848',
      authMode: 'none'
    });

    expect((await manager.listInstances()).map((instance) => instance.id)).toEqual([created.id]);
  });

  it('warns when it discards a globalState value that is not an array', async () => {
    const log = createLog();
    memento.seed(INSTANCES_KEY, 'nope');

    await new NacosInstanceConfigManager(memento, secrets, log).listInstances();

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toContain('warn: ');
    expect(log.entries[0]).toContain(INSTANCES_KEY);
  });
});
