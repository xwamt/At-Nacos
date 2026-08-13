import { describe, expect, it, vi } from 'vitest';
import { NacosApiError } from '../../src/nacos/NacosApiError';
import { NacosCapabilityResolver, type NacosCapability } from '../../src/nacos/NacosCapabilityResolver';
import type { NacosApiFlavor, NacosDriver } from '../../src/nacos/driver/NacosDriver';
import type { AtNacosLog } from '../../src/utils/logger';

/**
 * Every capability shares one behavior, because what is under test here is
 * the walking and the caching rather than any particular request. `as never`
 * because the resolver is generic over what a capability returns and these
 * tests hand back marker arrays.
 */
function driver(flavor: NacosApiFlavor, behavior: () => Promise<unknown>): NacosDriver {
  return {
    flavor,
    listNamespaces: behavior as never,
    listConfigs: behavior as never,
    getConfig: behavior as never,
    listServices: behavior as never,
    listInstances: behavior as never,
    listClusterNodes: behavior as never,
    getServerMetrics: behavior as never
  };
}

function recordingLog(): { lines: string[]; log: AtNacosLog } {
  const lines: string[] = [];
  const push = (message: string) => lines.push(message);
  return { lines, log: { error: push, warn: push, info: push, debug: push, trace: push } };
}

/**
 * A second key, so that the cache is shown to be keyed at all -- which is
 * what stops a later milestone from adding a capability that quietly shares
 * another one's entry. Which one it is does not matter; it is only ever
 * asked for the same behavior as `'namespaces'`.
 */
const OTHER_CAPABILITY: NacosCapability = 'configs';

describe('NacosCapabilityResolver', () => {
  it('returns the first driver that succeeds', async () => {
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () => Promise.resolve(['a'])),
      driver('v1', () => Promise.resolve(['b']))
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).resolves.toEqual(['a']);
  });

  it('falls through on 404 and on 410', async () => {
    const tried: NacosApiFlavor[] = [];
    const resolver = new NacosCapabilityResolver([
      driver('v1', () => {
        tried.push('v1');
        return Promise.reject(new NacosApiError('api-deprecated', 'gone', 410));
      }),
      driver('v2', () => {
        tried.push('v2');
        return Promise.reject(new NacosApiError('not-found', 'missing', 404));
      }),
      driver('v3-admin', () => {
        tried.push('v3-admin');
        return Promise.resolve(['ok']);
      })
    ]);
    await resolver.run('namespaces', (d) => d.listNamespaces());
    expect(tried).toEqual(['v1', 'v2', 'v3-admin']);
  });

  it('falls through on 403 so an admin-only endpoint can degrade to console', async () => {
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () => Promise.reject(new NacosApiError('forbidden', 'denied', 403))),
      driver('v3-console', () => Promise.resolve(['ok']))
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).resolves.toEqual(['ok']);
  });

  it('does NOT fall through on a business error, because other versions will fail the same way', async () => {
    const second = vi.fn(() => Promise.resolve(['never']));
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () => Promise.reject(new NacosApiError('api-error', 'namespace not exist', 200))),
      driver('v1', second as never)
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow('namespace not exist');
    expect(second).not.toHaveBeenCalled();
  });

  it('does not fall through on a network error, which says nothing about the API version', async () => {
    const second = vi.fn(() => Promise.resolve(['never']));
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () => Promise.reject(new NacosApiError('network', 'ECONNREFUSED'))),
      driver('v1', second as never)
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow('ECONNREFUSED');
    expect(second).not.toHaveBeenCalled();
  });

  it('remembers the winning driver so the next call skips the failing ones', async () => {
    const v1 = vi.fn(() => Promise.reject(new NacosApiError('not-found', 'missing', 404)));
    const resolver = new NacosCapabilityResolver([
      driver('v1', v1 as never),
      driver('v3-admin', () => Promise.resolve(['ok']))
    ]);
    await resolver.run('namespaces', (d) => d.listNamespaces());
    await resolver.run('namespaces', (d) => d.listNamespaces());
    expect(v1).toHaveBeenCalledTimes(1);
  });

  it('re-probes from the top if the cached driver later stops working', async () => {
    let adminHealthy = true;
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () =>
        adminHealthy ? Promise.resolve(['ok']) : Promise.reject(new NacosApiError('forbidden', 'denied', 403))
      ),
      driver('v3-console', () => Promise.resolve(['console']))
    ]);
    await resolver.run('namespaces', (d) => d.listNamespaces());
    adminHealthy = false;
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).resolves.toEqual(['console']);
  });

  it('reports every attempted flavor when all drivers fail', async () => {
    const resolver = new NacosCapabilityResolver([
      driver('v1', () => Promise.reject(new NacosApiError('api-deprecated', 'gone', 410))),
      driver('v3-admin', () => Promise.reject(new NacosApiError('forbidden', 'denied', 403)))
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow(/v1.*v3-admin/s);
  });

  it('names the status of each attempt, so the report points at what to fix', async () => {
    const resolver = new NacosCapabilityResolver([
      driver('v1', () => Promise.reject(new NacosApiError('api-deprecated', 'gone', 410))),
      driver('v3-admin', () => Promise.reject(new NacosApiError('forbidden', 'denied', 403)))
    ]);
    const error = await resolver.run('namespaces', (d) => d.listNamespaces()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).message).toContain('410');
    expect((error as NacosApiError).message).toContain('403');
    // Whatever the chain reports must not itself look like "try another
    // version" to a resolver stacked above it.
    expect((error as NacosApiError).shouldFallThrough()).toBe(false);
  });

  /**
   * A driver bug, not a server answer. It carries no kind, so treating it as
   * fall-through would hide a programming error behind three more requests
   * and an aggregate message that names none of them.
   */
  it('propagates an error that is not a NacosApiError instead of swallowing it', async () => {
    const second = vi.fn(() => Promise.resolve(['never']));
    const bug = new TypeError('cannot read properties of undefined');
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () => Promise.reject(bug)),
      driver('v1', second as never)
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toBe(bug);
    expect(second).not.toHaveBeenCalled();
  });

  it('treats a driver that throws synchronously exactly like one that rejects', async () => {
    const resolver = new NacosCapabilityResolver([
      driver('v1', (() => {
        throw new NacosApiError('not-found', 'missing', 404);
      }) as never),
      driver('v3-admin', () => Promise.resolve(['ok']))
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).resolves.toEqual(['ok']);
  });

  /**
   * `invalid-response` stays out of the fall-through set. `unwrapDataArray`
   * raises it for a body that came from the right endpoint in a shape we do
   * not understand, and its message names that endpoint -- the single most
   * useful line we produce. Trying three more versions would replace it with a
   * generic "no flavor could serve this", and might even find a version whose
   * different response shape parses, showing wrong data instead of an error.
   */
  it('does not fall through on invalid-response, keeping the malformed-body diagnosis intact', async () => {
    const second = vi.fn(() => Promise.resolve(['never']));
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () =>
        Promise.reject(new NacosApiError('invalid-response', 'Nacos returned no list for /v3/admin/core/namespace/list'))
      ),
      driver('v1', second as never)
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow(
      '/v3/admin/core/namespace/list'
    );
    expect(second).not.toHaveBeenCalled();
  });

  /** A 401 is a proxy in front of Nacos. No Nacos path answers differently. */
  it('does not fall through on gateway-auth', async () => {
    const second = vi.fn(() => Promise.resolve(['never']));
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', () => Promise.reject(new NacosApiError('gateway-auth', 'proxy wants a login', 401))),
      driver('v1', second as never)
    ]);
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow('proxy wants a login');
    expect(second).not.toHaveBeenCalled();
  });

  it('uses the cached driver even when it sits in the middle of the chain', async () => {
    const v1 = vi.fn(() => Promise.reject(new NacosApiError('api-deprecated', 'gone', 410)));
    const v2 = vi.fn(() => Promise.resolve(['v2']));
    const admin = vi.fn(() => Promise.resolve(['admin']));
    const resolver = new NacosCapabilityResolver([
      driver('v1', v1 as never),
      driver('v2', v2 as never),
      driver('v3-admin', admin as never)
    ]);
    await resolver.run('namespaces', (d) => d.listNamespaces());
    v1.mockClear();
    v2.mockClear();

    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).resolves.toEqual(['v2']);
    expect(v1).not.toHaveBeenCalled();
    expect(v2).toHaveBeenCalledTimes(1);
    expect(admin).not.toHaveBeenCalled();
  });

  it('caches each capability on its own, so one does not evict the other', async () => {
    const v1 = vi.fn(() => Promise.reject(new NacosApiError('not-found', 'missing', 404)));
    const admin = vi.fn(() => Promise.resolve(['ok']));
    const resolver = new NacosCapabilityResolver([driver('v1', v1 as never), driver('v3-admin', admin as never)]);

    await resolver.run('namespaces', (d) => d.listNamespaces());
    await resolver.run(OTHER_CAPABILITY, (d) => d.listNamespaces());
    await resolver.run('namespaces', (d) => d.listNamespaces());
    await resolver.run(OTHER_CAPABILITY, (d) => d.listNamespaces());

    // One probe each: the second capability's probe must not have overwritten
    // the first's entry, and neither may re-probe afterwards.
    expect(v1).toHaveBeenCalledTimes(2);
    expect(admin).toHaveBeenCalledTimes(4);
  });

  it('installs the new winner after a failover, so later calls stop retrying the dead driver', async () => {
    let adminHealthy = true;
    const admin = vi.fn(() =>
      adminHealthy ? Promise.resolve(['admin']) : Promise.reject(new NacosApiError('forbidden', 'denied', 403))
    );
    const consoleDriver = vi.fn(() => Promise.resolve(['console']));
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', admin as never),
      driver('v3-console', consoleDriver as never)
    ]);

    await resolver.run('namespaces', (d) => d.listNamespaces());
    adminHealthy = false;
    await resolver.run('namespaces', (d) => d.listNamespaces());
    expect(resolver.snapshot()).toEqual({ namespaces: 'v3-console' });

    admin.mockClear();
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).resolves.toEqual(['console']);
    expect(admin).not.toHaveBeenCalled();
  });

  it('keeps no stale entry when the cached driver dies and the whole re-probe fails', async () => {
    let healthy = true;
    const admin = vi.fn(() =>
      healthy ? Promise.resolve(['ok']) : Promise.reject(new NacosApiError('forbidden', 'denied', 403))
    );
    const resolver = new NacosCapabilityResolver([driver('v3-admin', admin as never)]);

    await resolver.run('namespaces', (d) => d.listNamespaces());
    healthy = false;
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow(/v3-admin/);
    expect(resolver.snapshot()).toEqual({});

    // A stale entry would be harmless here but fatal in the opposite case:
    // recovery must not depend on the cache having been cleaned up.
    healthy = true;
    await expect(resolver.run('namespaces', (d) => d.listNamespaces())).resolves.toEqual(['ok']);
  });

  it('says the chain is empty rather than reporting an empty list of attempts', async () => {
    const resolver = new NacosCapabilityResolver([]);
    const error = await resolver.run('namespaces', (d) => d.listNamespaces()).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('validation');
    expect((error as NacosApiError).message).toMatch(/no .*driver/i);
    expect((error as NacosApiError).message).not.toMatch(/Tried: \./);
  });

  it('passes the resolved value through unchanged, including undefined and null', async () => {
    const undefinedResolver = new NacosCapabilityResolver([driver('v1', () => Promise.resolve(undefined))]);
    await expect(undefinedResolver.run('namespaces', (d) => d.listNamespaces())).resolves.toBeUndefined();

    const nullResolver = new NacosCapabilityResolver([driver('v1', () => Promise.resolve(null))]);
    await expect(nullResolver.run('namespaces', (d) => d.listNamespaces())).resolves.toBeNull();
  });

  it('remembers the winner even when the capability resolved to nothing', async () => {
    const v1 = vi.fn(() => Promise.reject(new NacosApiError('not-found', 'missing', 404)));
    const resolver = new NacosCapabilityResolver([
      driver('v1', v1 as never),
      driver('v3-admin', () => Promise.resolve(undefined))
    ]);
    await resolver.run('namespaces', (d) => d.listNamespaces());
    await resolver.run('namespaces', (d) => d.listNamespaces());
    expect(v1).toHaveBeenCalledTimes(1);
    expect(resolver.snapshot()).toEqual({ namespaces: 'v3-admin' });
  });

  /**
   * A tree expansion asks for several nodes in the same tick. Without a shared
   * probe every one of them repeats the failing prefix -- and on 3.x with a
   * non-admin account that prefix is a 403 on the admin endpoint, which is the
   * normal configuration, not an edge case.
   */
  it('probes the failing prefix once for a burst of calls that arrive before any of them settles', async () => {
    const admin = vi.fn(() => Promise.reject(new NacosApiError('forbidden', 'denied', 403)));
    const consoleDriver = vi.fn(() => Promise.resolve(['ok']));
    const resolver = new NacosCapabilityResolver([
      driver('v3-admin', admin as never),
      driver('v3-console', consoleDriver as never)
    ]);

    const results = await Promise.all([
      resolver.run('namespaces', (d) => d.listNamespaces()),
      resolver.run('namespaces', (d) => d.listNamespaces()),
      resolver.run('namespaces', (d) => d.listNamespaces())
    ]);

    expect(results).toEqual([['ok'], ['ok'], ['ok']]);
    expect(admin).toHaveBeenCalledTimes(1);
    // Sharing the probe must not turn into sharing the request: three callers
    // asked, so the winning driver runs three times.
    expect(consoleDriver).toHaveBeenCalledTimes(3);
  });

  it('gives each concurrent caller the result of its own invocation, not the probing call\'s', async () => {
    const resolver = new NacosCapabilityResolver([
      driver('v1', () => Promise.reject(new NacosApiError('not-found', 'missing', 404))),
      driver('v3-admin', () => Promise.resolve(['ok']))
    ]);
    const call = (label: string): Promise<string> =>
      resolver.run('namespaces', async (d) => `${label}:${d.flavor}:${(await d.listNamespaces()).length}`);

    await expect(Promise.all([call('a'), call('b')])).resolves.toEqual(['a:v3-admin:1', 'b:v3-admin:1']);
  });

  it('lets every caller of a burst fail on its own when nothing in the chain answers', async () => {
    const resolver = new NacosCapabilityResolver([
      driver('v1', () => Promise.reject(new NacosApiError('not-found', 'missing', 404))),
      driver('v3-admin', () => Promise.reject(new NacosApiError('forbidden', 'denied', 403)))
    ]);

    const settled = await Promise.allSettled([
      resolver.run('namespaces', (d) => d.listNamespaces()),
      resolver.run('namespaces', (d) => d.listNamespaces())
    ]);

    expect(settled.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    for (const outcome of settled) {
      const reason = (outcome as PromiseRejectedResult).reason as NacosApiError;
      expect(reason).toBeInstanceOf(NacosApiError);
      expect(reason.message).toContain('v3-admin');
    }
    expect(resolver.snapshot()).toEqual({});
  });

  /**
   * The most useful thing to say about an exhausted chain is usually about a
   * driver that is not in it, which the resolver cannot see: it is handed a
   * list of drivers, not the reasons behind it. So the sentence comes from
   * whoever built the chain, and the resolver only supplies the facts to
   * decide on.
   */
  describe('exhausted-chain advice', () => {
    it('appends the advice the chain builder offers for this set of refusals', async () => {
      const resolver = new NacosCapabilityResolver(
        [
          driver('v3-admin', () => Promise.reject(new NacosApiError('forbidden', 'denied', 403))),
          driver('v2', () => Promise.reject(new NacosApiError('not-found', 'missing', 404)))
        ],
        undefined,
        () => 'Set the console URL on this instance.'
      );

      await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow(
        'No Nacos API flavor could serve "namespaces". Tried: v3-admin (forbidden 403); v2 (not-found 404). Set the console URL on this instance.'
      );
    });

    it('hands the builder each refusal as its flavor, kind and status', async () => {
      const seen: unknown[] = [];
      const resolver = new NacosCapabilityResolver(
        [
          driver('v3-admin', () => Promise.reject(new NacosApiError('forbidden', 'denied', 403))),
          driver('v1', () => Promise.reject(new NacosApiError('api-deprecated', 'gone', 410)))
        ],
        undefined,
        (attempts) => {
          seen.push(...attempts);
          return undefined;
        }
      );

      await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow(NacosApiError);
      expect(seen).toEqual([
        { flavor: 'v3-admin', kind: 'forbidden', status: 403 },
        { flavor: 'v1', kind: 'api-deprecated', status: 410 }
      ]);
    });

    it('leaves the message exactly as it was when the builder has nothing to add', async () => {
      const resolver = new NacosCapabilityResolver(
        [driver('v1', () => Promise.reject(new NacosApiError('not-found', 'missing', 404)))],
        undefined,
        () => undefined
      );

      await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow(
        'No Nacos API flavor could serve "namespaces". Tried: v1 (not-found 404).'
      );
    });

    it('says nothing extra when no builder supplied advice at all', async () => {
      const resolver = new NacosCapabilityResolver([
        driver('v1', () => Promise.reject(new NacosApiError('not-found', 'missing', 404)))
      ]);

      await expect(resolver.run('namespaces', (d) => d.listNamespaces())).rejects.toThrow(
        'No Nacos API flavor could serve "namespaces". Tried: v1 (not-found 404).'
      );
    });
  });

  describe('snapshot', () => {
    it('is empty before anything has been resolved', () => {
      const resolver = new NacosCapabilityResolver([driver('v1', () => Promise.resolve([]))]);
      expect(resolver.snapshot()).toEqual({});
    });

    it('names the flavor actually serving each capability', async () => {
      const resolver = new NacosCapabilityResolver([
        driver('v1', () => Promise.reject(new NacosApiError('not-found', 'missing', 404))),
        driver('v3-admin', () => Promise.resolve(['ok']))
      ]);
      await resolver.run('namespaces', (d) => d.listNamespaces());
      expect(resolver.snapshot()).toEqual({ namespaces: 'v3-admin' });
    });

    it('hands out a copy, so a diagnostics view cannot edit the live cache', async () => {
      const resolver = new NacosCapabilityResolver([driver('v1', () => Promise.resolve(['ok']))]);
      await resolver.run('namespaces', (d) => d.listNamespaces());

      const first = resolver.snapshot();
      delete first.namespaces;
      expect(resolver.snapshot()).toEqual({ namespaces: 'v1' });
    });
  });

  describe('logging', () => {
    it('records which flavor won and when a cached one is dropped', async () => {
      let adminHealthy = true;
      const { lines, log } = recordingLog();
      const resolver = new NacosCapabilityResolver(
        [
          driver('v3-admin', () =>
            adminHealthy ? Promise.resolve(['ok']) : Promise.reject(new NacosApiError('forbidden', 'denied', 403))
          ),
          driver('v3-console', () => Promise.resolve(['console']))
        ],
        log
      );

      await resolver.run('namespaces', (d) => d.listNamespaces());
      adminHealthy = false;
      await resolver.run('namespaces', (d) => d.listNamespaces());

      expect(lines.join('\n')).toContain('v3-admin');
      expect(lines.join('\n')).toContain('v3-console');
    });

    it('passes its lines through redaction, as every component holding a log must', async () => {
      const { lines, log } = recordingLog();
      const resolver = new NacosCapabilityResolver([driver('v1', () => Promise.resolve(['ok']))], log);
      await resolver.run('accessToken=super-secret-value' as NacosCapability, (d) => d.listNamespaces());
      expect(lines.join('\n')).not.toContain('super-secret-value');
    });
  });
});
