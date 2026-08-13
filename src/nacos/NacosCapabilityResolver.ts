import { asRedactedLog, noopLog, type AtNacosLog } from '../utils/logger';
import { NacosApiError, type NacosApiErrorKind } from './NacosApiError';
import type { NacosApiFlavor, NacosDriver } from './driver/NacosDriver';

/**
 * The cache key, spelled as a union rather than a bare string so that a
 * misspelling is a compile error instead of a second cache entry that probes
 * the whole chain forever and never collides with the first. Every milestone
 * that widens `NacosDriver` widens this alongside it.
 *
 * Listing and reading a config are two keys rather than one because a server
 * can serve one and not the other: on 3.0/3.1 the listing is a CONSOLE_API
 * and answers 410 with the compatibility switch off, while reading a config
 * is an OPEN_API and keeps working (§4.2). Sharing an entry would let a
 * fall-through on either one evict the winner the other had already found.
 */
export type NacosCapability = 'namespaces' | 'configs' | 'config-detail';

/** How one driver in the chain declined, in the terms the chain builder reasons about. */
export interface NacosDriverRefusal {
  flavor: NacosApiFlavor;
  kind: NacosApiErrorKind;
  status: number | undefined;
}

/**
 * One sentence naming what would make an exhausted walk succeed, or undefined
 * when this particular set of refusals suggests nothing.
 *
 * It is supplied from outside because the useful advice is usually about a
 * driver that is *not* in the chain -- the console driver a 3.x server gets
 * only once its console address is known. The resolver is handed a list of
 * drivers and no account of how it was chosen, so it can report the refusals
 * it collected and nothing more; only whoever assembled the chain knows what
 * was left out of it and why.
 */
export type NacosChainAdvice = (refusals: readonly NacosDriverRefusal[]) => string | undefined;

/** What one driver's attempt gave back, before the caller learns which one answered. */
interface Attempt<T> {
  driver: NacosDriver;
  result: T;
}

export class NacosCapabilityResolver {
  private readonly resolved = new Map<NacosCapability, NacosDriver>();
  /**
   * The probe currently walking the chain for a capability, published as the
   * driver that won it. Resolves to undefined when the probe found nobody, and
   * never rejects: the failure belongs to the caller that provoked it.
   */
  private readonly probing = new Map<NacosCapability, Promise<NacosDriver | undefined>>();
  private readonly log: AtNacosLog;

  constructor(
    private readonly drivers: readonly NacosDriver[],
    log: AtNacosLog = noopLog,
    private readonly adviseOnExhaustion: NacosChainAdvice = () => undefined
  ) {
    this.log = asRedactedLog(log);
  }

  /**
   * Runs `invoke` against the driver that serves `capability`, discovering it
   * by walking the chain the first time and reusing it afterwards.
   *
   * Nothing here awaits before either reading the cache or registering a
   * probe. That ordering is the whole dedupe: a tree expansion issues its
   * requests in one tick, and a resolver that yielded first would let every
   * one of them walk the failing prefix of the chain before the first had
   * ruled out a single driver.
   */
  async run<T>(capability: NacosCapability, invoke: (driver: NacosDriver) => Promise<T>): Promise<T> {
    const cached = this.resolved.get(capability);
    if (cached !== undefined) {
      return await this.invokeKnown(capability, cached, invoke);
    }

    const pending = this.probing.get(capability);
    if (pending !== undefined) {
      const winner = await pending;
      if (winner !== undefined) {
        return await this.invokeKnown(capability, winner, invoke);
      }
    }

    return await this.probe(capability, invoke);
  }

  /** For diagnostics: which API family each capability is actually being served by. */
  snapshot(): Partial<Record<NacosCapability, NacosApiFlavor>> {
    const entries = [...this.resolved].map(([capability, driver]): [NacosCapability, NacosApiFlavor] => [
      capability,
      driver.flavor
    ]);
    return Object.fromEntries(entries);
  }

  private async invokeKnown<T>(
    capability: NacosCapability,
    driver: NacosDriver,
    invoke: (driver: NacosDriver) => Promise<T>
  ): Promise<T> {
    try {
      return await invoke(driver);
    } catch (error) {
      if (!isFallThrough(error)) {
        throw error;
      }
      // Only drop what is still there: a concurrent caller may already have
      // re-probed and installed a different winner, and evicting that one
      // would send the next call back down the chain for nothing.
      if (this.resolved.get(capability) === driver) {
        this.resolved.delete(capability);
      }
      this.log.debug(
        `capability ${capability}: ${driver.flavor} stopped working (${describeRefusal(error)}); re-probing`
      );
    }
    return await this.probe(capability, invoke);
  }

  private async probe<T>(capability: NacosCapability, invoke: (driver: NacosDriver) => Promise<T>): Promise<T> {
    if (this.drivers.length === 0) {
      throw new NacosApiError(
        'validation',
        `Cannot serve "${capability}": no Nacos API driver was built for this connection. This is an internal error -- the driver chain is empty.`
      );
    }

    const attempt = this.walkChain(capability, invoke);
    // Callers arriving mid-probe are told which driver won so they can skip
    // the ones this walk is ruling out. What they must never share is the
    // result: one capability serves many different arguments, and handing a
    // caller someone else's answer would be worse than the wasted round trips
    // this saves.
    const winner = attempt.then(
      ({ driver }) => driver,
      () => undefined
    );
    this.probing.set(capability, winner);

    try {
      const { driver, result } = await attempt;
      this.resolved.set(capability, driver);
      this.log.debug(`capability ${capability}: served by ${driver.flavor}`);
      return result;
    } finally {
      if (this.probing.get(capability) === winner) {
        this.probing.delete(capability);
      }
    }
  }

  private async walkChain<T>(
    capability: NacosCapability,
    invoke: (driver: NacosDriver) => Promise<T>
  ): Promise<Attempt<T>> {
    const refusals: NacosDriverRefusal[] = [];
    for (const driver of this.drivers) {
      try {
        const result = await invoke(driver);
        return { driver, result };
      } catch (error) {
        if (!isFallThrough(error)) {
          throw error;
        }
        refusals.push({ flavor: driver.flavor, kind: error.kind, status: error.status });
      }
    }

    const tried = refusals.map((refusal) => `${refusal.flavor} (${describeRefusal(refusal)})`).join('; ');
    // Four refusals listed as equals send the user to check all four. The
    // builder's sentence, when it has one, names the single one worth acting
    // on -- so it goes last, where a reader stops.
    const advice = this.adviseOnExhaustion(refusals);
    throw new NacosApiError(
      'api-error',
      `No Nacos API flavor could serve "${capability}". Tried: ${tried}.${advice ? ` ${advice}` : ''}`
    );
  }
}

/**
 * A type guard rather than a predicate returning boolean, so that the code
 * after it is known to be holding a classified error. Anything else -- a
 * TypeError from a driver bug, say -- carries no kind to reason about and is
 * rethrown untouched rather than hidden behind three more requests.
 */
function isFallThrough(error: unknown): error is NacosApiError {
  return error instanceof NacosApiError && error.shouldFallThrough();
}

/** Takes the two fields rather than either whole type, so an error and a refusal read alike. */
function describeRefusal(refusal: { kind: NacosApiErrorKind; status?: number }): string {
  return `${refusal.kind}${refusal.status === undefined ? '' : ` ${refusal.status}`}`;
}
