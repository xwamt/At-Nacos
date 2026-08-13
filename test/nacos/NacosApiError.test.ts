import { describe, expect, it } from 'vitest';
import { classifyHttpStatus, NacosApiError, toNetworkOrTlsError } from '../../src/nacos/NacosApiError';

function errnoError(message: string, code?: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

describe('classifyHttpStatus', () => {
  it('maps 404 to not-found so the resolver tries the next driver', () => {
    expect(classifyHttpStatus(404)).toBe('not-found');
  });

  it('maps 410 to api-deprecated (Nacos 3.0/3.1 compatibility switch is off)', () => {
    expect(classifyHttpStatus(410)).toBe('api-deprecated');
  });

  it('maps 403 to forbidden — Nacos never returns 401 for its own auth failures', () => {
    expect(classifyHttpStatus(403)).toBe('forbidden');
  });

  it('maps 401 to gateway-auth because it implies a proxy in front of Nacos', () => {
    expect(classifyHttpStatus(401)).toBe('gateway-auth');
  });

  it('maps other 4xx/5xx to api-error', () => {
    expect(classifyHttpStatus(500)).toBe('api-error');
    expect(classifyHttpStatus(400)).toBe('api-error');
  });

  it('maps 2xx to undefined so success is not an error kind', () => {
    expect(classifyHttpStatus(200)).toBeUndefined();
  });
});

describe('toNetworkOrTlsError', () => {
  it('classifies a self-signed certificate rejection as tls, not network', () => {
    const error = toNetworkOrTlsError(errnoError('self signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'));
    expect(error.kind).toBe('tls');
    expect(error.message).toContain('self signed certificate');
  });

  it('classifies a hostname mismatch as tls', () => {
    expect(toNetworkOrTlsError(errnoError('altname invalid', 'ERR_TLS_CERT_ALTNAME_INVALID')).kind).toBe('tls');
  });

  it('classifies a refused connection as network', () => {
    const error = toNetworkOrTlsError(errnoError('connect ECONNREFUSED 127.0.0.1:1', 'ECONNREFUSED'));
    expect(error.kind).toBe('network');
    expect(error.message).toBe('connect ECONNREFUSED 127.0.0.1:1');
  });

  it('classifies an error carrying no code as network', () => {
    expect(toNetworkOrTlsError(errnoError('socket hang up')).kind).toBe('network');
  });

  it('leaves neither classification eligible for driver fall-through', () => {
    expect(toNetworkOrTlsError(errnoError('x', 'CERT_HAS_EXPIRED')).shouldFallThrough()).toBe(false);
    expect(toNetworkOrTlsError(errnoError('x', 'ECONNRESET')).shouldFallThrough()).toBe(false);
  });
});

describe('NacosApiError', () => {
  it('reports whether the resolver should fall through to the next driver', () => {
    expect(new NacosApiError('not-found', 'x', 404).shouldFallThrough()).toBe(true);
    expect(new NacosApiError('api-deprecated', 'x', 410).shouldFallThrough()).toBe(true);
    expect(new NacosApiError('forbidden', 'x', 403).shouldFallThrough()).toBe(true);
    expect(new NacosApiError('api-error', 'x', 500).shouldFallThrough()).toBe(false);
    expect(new NacosApiError('network', 'x').shouldFallThrough()).toBe(false);
  });
});
