import { asRedactedLog, noopLog, type AtNacosLog } from '../utils/logger';

const TRUSTED_CERTS_KEY = 'atNacos.trustedCertFingerprints';

export type CertTrustStatus = 'unknown' | 'trusted' | 'changed';

export interface TrustedCert {
  host: string;
  port: number;
  fingerprint: string;
  trustedAt: number;
}

export interface CertTrustMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * The TOFU decision, decoupled from both the UI that makes it and the client
 * that acts on it. `NacosHttpClient` calls this on every TLS handshake and
 * `createInteractiveCertVerifier` implements it against the store below, so
 * neither of those two modules has to know the other exists.
 */
export interface NacosCertVerifier {
  verify(host: string, port: number, fingerprint256: string): Promise<boolean>;
}

/**
 * Trust-on-first-use store for self-signed/private-CA Nacos TLS certificates,
 * keyed by instance host:port. Mirrors at-terminal-series's HostKeyStore (SSH
 * host keys) but stores a certificate fingerprint instead.
 *
 * Keying by port rather than host matters more here than in the sibling
 * plugins: a Nacos 3.x deployment answers on 8848 and 8080, and the console
 * port may well terminate TLS somewhere else entirely.
 */
export class NacosCertTrustStore {
  /**
   * Remembers which `host:port -> presented fingerprint` mismatches have
   * already been reported. A changed certificate fails *every* sub-resource
   * of a proxied dashboard, so an undeduplicated warning would emit hundreds
   * of identical lines and bury whatever else the user opened the channel to
   * read. Bounded by the number of distinct fingerprints actually presented,
   * which in any real failure is one.
   */
  private readonly reportedMismatches = new Set<string>();
  private readonly log: AtNacosLog;

  constructor(
    private readonly globalState: CertTrustMemento,
    log: AtNacosLog = noopLog
  ) {
    this.log = asRedactedLog(log);
  }

  async check(host: string, port: number, fingerprint: string): Promise<CertTrustStatus> {
    const existing = this.read()[this.key(host, port)];
    if (!existing) {
      this.log.trace(`cert-trust: no recorded fingerprint for ${this.key(host, port)}`);
      return 'unknown';
    }
    if (existing.fingerprint === fingerprint) {
      this.log.trace(`cert-trust: ${this.key(host, port)} matches the trusted fingerprint`);
      return 'trusted';
    }
    this.warnOnceAboutMismatch(host, port, existing.fingerprint, fingerprint);
    return 'changed';
  }

  async trust(host: string, port: number, fingerprint: string): Promise<void> {
    const certs = this.read();
    const previous = certs[this.key(host, port)];
    certs[this.key(host, port)] = {
      host,
      port,
      fingerprint,
      trustedAt: Date.now()
    };
    await this.globalState.update(TRUSTED_CERTS_KEY, certs);
    // A trust decision is a durable security-relevant state change made once
    // per instance, so it earns a default-visible line -- unlike the `check`
    // that consults it on every request.
    this.log.info(
      previous
        ? `cert-trust: replaced the trusted fingerprint for ${this.key(host, port)} (was ${previous.fingerprint}, now ${fingerprint})`
        : `cert-trust: trusted ${this.key(host, port)} on first use (fingerprint ${fingerprint})`
    );
    this.reportedMismatches.delete(this.mismatchKey(host, port, fingerprint));
  }

  getTrusted(host: string, port: number): TrustedCert | undefined {
    return this.read()[this.key(host, port)];
  }

  async forget(host: string, port: number): Promise<void> {
    const certs = this.read();
    delete certs[this.key(host, port)];
    await this.globalState.update(TRUSTED_CERTS_KEY, certs);
  }

  private warnOnceAboutMismatch(host: string, port: number, expected: string, presented: string): void {
    const key = this.mismatchKey(host, port, presented);
    if (this.reportedMismatches.has(key)) {
      return;
    }
    this.reportedMismatches.add(key);
    this.log.warn(
      `cert-trust: fingerprint CHANGED for ${this.key(host, port)} (trusted ${expected}, presented ${presented}); ` +
        'refusing the connection until the new certificate is confirmed'
    );
  }

  private read(): Record<string, TrustedCert> {
    return this.globalState.get<Record<string, TrustedCert>>(TRUSTED_CERTS_KEY, {});
  }

  private key(host: string, port: number): string {
    return `${host}:${port}`;
  }

  private mismatchKey(host: string, port: number, fingerprint: string): string {
    return `${this.key(host, port)}|${fingerprint}`;
  }
}
