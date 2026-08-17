import type { NacosInstanceConfig } from '../config/schema';
import type { NacosClient } from './NacosClient';

export type NacosClientFactory = (instance: NacosInstanceConfig) => Promise<NacosClient>;

interface PoolEntry {
  clientPromise: Promise<NacosClient>;
  fingerprint: string;
}

/**
 * Computes a fingerprint representing the connection-relevant fields of an instance.
 * When any of these change, the cached client is considered stale and evicted.
 */
function instanceFingerprint(instance: NacosInstanceConfig): string {
  return JSON.stringify([
    instance.serverUrl,
    instance.consoleUrl,
    instance.authMode,
    instance.username,
    instance.readOnly,
    instance.updatedAt
  ]);
}

/**
 * Manages cached `NacosClient` instances across user operations.
 *
 * Avoids redundant authentication (login JWT requests + server-side BCrypt calculations),
 * repeated version probing (`/v1/console/server/state`), and repeated console endpoint
 * discovery on every single click.
 *
 * Automatically evicts cached clients when an instance's configuration is modified,
 * or on explicit eviction/clear.
 */
export class NacosClientPool {
  private readonly pool = new Map<string, PoolEntry>();

  async getClient(instance: NacosInstanceConfig, factory: NacosClientFactory): Promise<NacosClient> {
    const key = instance.id;
    const currentFingerprint = instanceFingerprint(instance);
    const cached = this.pool.get(key);

    if (cached && cached.fingerprint === currentFingerprint) {
      return cached.clientPromise;
    }

    const clientPromise = factory(instance).catch((error) => {
      // Evict pending failed promise so future attempts can retry cleanly
      const existing = this.pool.get(key);
      if (existing && existing.clientPromise === clientPromise) {
        this.pool.delete(key);
      }
      throw error;
    });

    this.pool.set(key, {
      clientPromise,
      fingerprint: currentFingerprint
    });

    return clientPromise;
  }

  evict(instanceId: string): void {
    this.pool.delete(instanceId);
  }

  clear(): void {
    this.pool.clear();
  }
}
