import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  describeFailure,
  NacosApiError,
  toNetworkOrTlsError
} from '../../src/nacos/NacosApiError';

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

  /**
   * Both 404s reach here, and only this flag separates them. If a missing
   * config fell through, every lookup of a dataId that does not exist would
   * walk all four drivers and end in "No Nacos API flavor could serve
   * configs" -- a sentence about the plugin's driver chain in answer to a
   * question about one config.
   */
  it('keeps a missing resource off the fall-through path even though it is also a 404', () => {
    expect(new NacosApiError('resource-not-found', 'config data not exist', 404).shouldFallThrough()).toBe(false);
  });
});

describe('describeFailure', () => {
  const target = new URL('http://nacos.example.com:8848/nacos/v1/cs/configs?dataId=nope&group=DEFAULT_GROUP');

  it('says the resource is missing rather than the endpoint, and quotes what Nacos said', () => {
    const message = describeFailure('resource-not-found', 404, 'config data not exist', target);
    expect(message).toMatch(/no such resource/i);
    expect(message).toContain('config data not exist');
    expect(message).toContain('/nacos/v1/cs/configs');
    expect(message).not.toMatch(/no endpoint/i);
  });

  it('still names the path when Nacos sends an empty body with the 404', () => {
    const message = describeFailure('resource-not-found', 404, '', target);
    expect(message).toMatch(/no such resource/i);
    expect(message).toContain('/nacos/v1/cs/configs');
    expect(message).not.toMatch(/no endpoint/i);
  });

  /** The two 404s must not read alike, or the output channel cannot say which one happened. */
  it('words a missing resource differently from a missing endpoint', () => {
    expect(describeFailure('resource-not-found', 404, 'config data not exist', target)).not.toBe(
      describeFailure('not-found', 404, 'config data not exist', target)
    );
  });

  it('never leaks the query string, which carries the dataId a user typed', () => {
    expect(describeFailure('resource-not-found', 404, 'config data not exist', target)).not.toContain('dataId=nope');
  });
});
