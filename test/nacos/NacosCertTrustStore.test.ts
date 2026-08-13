import { describe, expect, it } from 'vitest';
import { NacosCertTrustStore, type CertTrustMemento } from '../../src/nacos/NacosCertTrustStore';
import type { AtNacosLog } from '../../src/utils/logger';

class MemoryMemento implements CertTrustMemento {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

function recordingLog(): { lines: string[]; log: AtNacosLog } {
  const lines: string[] = [];
  const push = (message: string) => lines.push(message);
  return { lines, log: { error: push, warn: push, info: push, debug: push, trace: push } };
}

describe('NacosCertTrustStore', () => {
  it('returns unknown for an unseen host', async () => {
    const store = new NacosCertTrustStore(new MemoryMemento());
    expect(await store.check('nacos.example.com', 8848, 'SHA256:abc')).toBe('unknown');
  });

  it('trusts a host and returns trusted for the same fingerprint', async () => {
    const store = new NacosCertTrustStore(new MemoryMemento());
    await store.trust('nacos.example.com', 8848, 'SHA256:abc');
    expect(await store.check('nacos.example.com', 8848, 'SHA256:abc')).toBe('trusted');
  });

  it('returns changed when a trusted fingerprint differs', async () => {
    const store = new NacosCertTrustStore(new MemoryMemento());
    await store.trust('nacos.example.com', 8848, 'SHA256:abc');
    expect(await store.check('nacos.example.com', 8848, 'SHA256:def')).toBe('changed');
  });

  it('keys trust by port, so the 3.x console port is a separate decision', async () => {
    const store = new NacosCertTrustStore(new MemoryMemento());
    await store.trust('nacos.example.com', 8848, 'SHA256:abc');
    expect(await store.check('nacos.example.com', 8080, 'SHA256:abc')).toBe('unknown');
  });

  it('forgets a trusted cert by host and port', async () => {
    const store = new NacosCertTrustStore(new MemoryMemento());
    await store.trust('nacos.example.com', 8848, 'SHA256:abc');
    await store.forget('nacos.example.com', 8848);
    expect(await store.check('nacos.example.com', 8848, 'SHA256:def')).toBe('unknown');
  });

  it('persists trusted fingerprints across store instances sharing the same memento', async () => {
    const memento = new MemoryMemento();
    await new NacosCertTrustStore(memento).trust('nacos.example.com', 8848, 'SHA256:abc');
    expect(await new NacosCertTrustStore(memento).check('nacos.example.com', 8848, 'SHA256:abc')).toBe('trusted');
  });

  it('warns once per changed fingerprint however many times it is presented', async () => {
    const { lines, log } = recordingLog();
    const store = new NacosCertTrustStore(new MemoryMemento(), log);
    await store.trust('nacos.example.com', 8848, 'SHA256:abc');
    await store.check('nacos.example.com', 8848, 'SHA256:def');
    await store.check('nacos.example.com', 8848, 'SHA256:def');
    expect(lines.filter((line) => line.includes('CHANGED'))).toHaveLength(1);
  });
});
