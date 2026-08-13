import { randomUUID } from 'node:crypto';
import { asRedactedLog, noopLog, type AtNacosLog } from '../utils/logger';
import {
  parseNacosInstanceConfig,
  parseNacosInstanceConfigList,
  type NacosAuthMode,
  type NacosInstanceConfig
} from './schema';

const INSTANCES_KEY = 'atNacos.instances';
const PASSWORD_PREFIX = 'atNacos.password.';
const HEADERS_PREFIX = 'atNacos.headers.';

export interface ExtensionMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface NacosInstanceSecrets {
  password?: string;
  customHeaders?: Record<string, string>;
}

export interface CreateNacosInstanceInput extends NacosInstanceSecrets {
  label: string;
  serverUrl: string;
  consoleUrl?: string;
  authMode: NacosAuthMode;
  username?: string;
  readOnly?: boolean;
  allowBackgroundAccess?: boolean;
}

export type UpdateNacosInstanceInput = Partial<
  Pick<
    CreateNacosInstanceInput,
    'label' | 'serverUrl' | 'consoleUrl' | 'authMode' | 'username' | 'readOnly' | 'allowBackgroundAccess'
  >
>;

export class NacosInstanceConfigManager {
  private readonly log: AtNacosLog;

  constructor(
    private readonly globalState: ExtensionMemento,
    private readonly secrets: SecretStore,
    log: AtNacosLog = noopLog
  ) {
    this.log = asRedactedLog(log);
  }

  /**
   * globalState holds whatever any previous version of this extension wrote,
   * so the two ways it can be wrong are handled differently on purpose.
   *
   * A value that is not an array carries no recoverable instance: there is
   * nothing to lose by starting over, and rejecting it would be unrecoverable
   * in the product. Every write path reads first, so a throw here would take
   * `createInstance` down with it and leave the user an error node in the tree
   * and no button that fixes it. Starting from an empty list keeps Add
   * Instance working, and its first write replaces the bad value.
   *
   * A record inside the array is the opposite case: the array shape says a
   * real instance was stored there, so dropping the damaged one would not stay
   * a read-time decision -- `persist` writes back whatever the read returned,
   * which would erase it for good on the next save. Letting the schema throw
   * costs one error node (the tree providers catch it) and keeps the record on
   * disk for a later version to repair.
   */
  async listInstances(): Promise<NacosInstanceConfig[]> {
    const stored = this.globalState.get<unknown>(INSTANCES_KEY, []);
    if (!Array.isArray(stored)) {
      this.log.warn(
        `Ignoring the stored ${INSTANCES_KEY} value: expected an array, found ${describeType(stored)}. ` +
          'Adding an instance will overwrite it.'
      );
      return [];
    }
    return parseNacosInstanceConfigList(stored);
  }

  async getInstance(id: string): Promise<NacosInstanceConfig | undefined> {
    return (await this.listInstances()).find((instance) => instance.id === id);
  }

  async createInstance(input: CreateNacosInstanceInput): Promise<NacosInstanceConfig> {
    const now = Date.now();
    const instance = parseNacosInstanceConfig({
      id: randomUUID(),
      label: input.label.trim(),
      serverUrl: input.serverUrl.trim(),
      consoleUrl: input.consoleUrl?.trim() || undefined,
      authMode: input.authMode,
      username: input.username?.trim() || undefined,
      readOnly: input.readOnly ?? false,
      allowBackgroundAccess: input.allowBackgroundAccess ?? false,
      createdAt: now,
      updatedAt: now
    });
    await this.persist(instance, input);
    return instance;
  }

  async updateInstance(
    id: string,
    patch: UpdateNacosInstanceInput,
    secrets: NacosInstanceSecrets = {}
  ): Promise<NacosInstanceConfig> {
    const existing = await this.getInstance(id);
    if (!existing) {
      throw new Error(`Unknown Nacos instance: ${id}`);
    }
    const updated = parseNacosInstanceConfig({
      ...existing,
      ...patch,
      label: (patch.label ?? existing.label).trim(),
      serverUrl: (patch.serverUrl ?? existing.serverUrl).trim(),
      updatedAt: Date.now()
    });
    await this.persist(updated, secrets);
    return updated;
  }

  async deleteInstance(id: string): Promise<void> {
    const instances = await this.listInstances();
    await this.globalState.update(
      INSTANCES_KEY,
      instances.filter((instance) => instance.id !== id)
    );
    await this.secrets.delete(this.passwordKey(id));
    await this.secrets.delete(this.headersKey(id));
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.secrets.get(this.passwordKey(id));
  }

  async getCustomHeaders(id: string): Promise<Record<string, string> | undefined> {
    const raw = await this.secrets.get(this.headersKey(id));
    if (raw === undefined) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isStringRecord(parsed) ? parsed : undefined;
    } catch {
      // A corrupt secret must not take down the tree; treat it as absent.
      return undefined;
    }
  }

  passwordKey(id: string): string {
    return `${PASSWORD_PREFIX}${id}`;
  }

  headersKey(id: string): string {
    return `${HEADERS_PREFIX}${id}`;
  }

  /**
   * `undefined` means "leave the stored credential alone"; only an empty
   * string clears it. A blank password box on the edit form takes the first
   * path, which is the convention every AT Series plugin shares.
   */
  private async persist(instance: NacosInstanceConfig, secrets: NacosInstanceSecrets): Promise<void> {
    const instances = await this.listInstances();
    const next = [...instances.filter((entry) => entry.id !== instance.id), instance].sort((a, b) =>
      a.label.localeCompare(b.label)
    );
    await this.globalState.update(INSTANCES_KEY, next);
    if (secrets.password !== undefined) {
      await this.secrets.store(this.passwordKey(instance.id), secrets.password);
    }
    if (secrets.customHeaders !== undefined) {
      await this.secrets.store(this.headersKey(instance.id), JSON.stringify(secrets.customHeaders));
    }
  }
}

/** Names the shape without putting its contents in the log. */
function describeType(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}
