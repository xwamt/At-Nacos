import * as vscode from 'vscode';
import { t } from '../i18n/t';
import type { NacosCertTrustStore, NacosCertVerifier } from './NacosCertTrustStore';

/**
 * The first real, interactive Trust-On-First-Use verifier. Mirrors
 * at-terminal-series's SSH host-key confirmation UX, but for Nacos TLS
 * certificate fingerprints:
 * - `unknown` (never seen before): prompts once, trusts on accept.
 * - `trusted` (matches the previously-trusted fingerprint): returns true
 *   immediately, no prompt — this is the steady-state, non-interruptive path.
 * - `changed` (fingerprint differs from the previously-trusted one — a
 *   legitimate cert rotation OR a MITM attempt): prompts with a more severe,
 *   explicit warning, and fails closed (rejects) unless the user explicitly
 *   picks the "trust new certificate" action; dismissing the modal (Escape,
 *   clicking away) is treated the same as an explicit reject.
 *
 * This file intentionally imports `vscode` (unlike every other module under
 * src/nacos/) since prompting is inherently a UI concern.
 */
export function createInteractiveCertVerifier(trustStore: NacosCertTrustStore): NacosCertVerifier {
  return {
    async verify(host: string, port: number, fingerprint256: string): Promise<boolean> {
      const status = await trustStore.check(host, port, fingerprint256);

      if (status === 'trusted') {
        return true;
      }

      if (status === 'changed') {
        const previous = trustStore.getTrusted(host, port);
        // Resolved before the prompt so the comparison below is against the
        // same translated label the user actually clicked.
        const trustAction = t('Trust New Certificate');
        const choice = await vscode.window.showWarningMessage(
          t(
            'SECURITY WARNING: The TLS certificate for Nacos instance {host}:{port} has CHANGED since it was last trusted.\n\nPreviously trusted fingerprint: {previousFingerprint}\nNew fingerprint presented: {fingerprint}\n\nThis can happen after a legitimate certificate rotation, but it can also indicate a machine-in-the-middle attack. Only continue if you can independently confirm the new fingerprint with whoever administers this Nacos server.',
            {
              host,
              port,
              previousFingerprint: previous?.fingerprint ?? t('(unknown)'),
              fingerprint: fingerprint256
            }
          ),
          { modal: true },
          trustAction,
          t('Reject')
        );
        if (choice === trustAction) {
          await trustStore.trust(host, port, fingerprint256);
          return true;
        }
        // Fail closed: an explicit "Reject" and a dismissed/closed modal are
        // indistinguishable from `showWarningMessage`'s return value
        // (both resolve `undefined`), and both must reject the certificate.
        return false;
      }

      // status === 'unknown'
      const trustAction = t('Trust Certificate');
      const choice = await vscode.window.showWarningMessage(
        t(
          'Nacos instance {host}:{port} presented a TLS certificate that has not been seen before.\n\nFingerprint: {fingerprint}\n\nIf you recognize and trust this Nacos server (for example, it uses a self-signed or private-CA certificate you administer), you can trust it now. Otherwise, reject the connection.',
          { host, port, fingerprint: fingerprint256 }
        ),
        { modal: true },
        trustAction,
        t('Reject')
      );
      if (choice === trustAction) {
        await trustStore.trust(host, port, fingerprint256);
        return true;
      }
      return false;
    }
  };
}
