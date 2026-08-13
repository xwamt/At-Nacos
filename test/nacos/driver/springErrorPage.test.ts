import { describe, expect, it } from 'vitest';
import { isSpringErrorPage } from '../../../src/nacos/driver/springErrorPage';

/**
 * Captured verbatim from Nacos 2.3.2 by asking `/v1/cs/configs?show=all` for a
 * dataId that does not exist. It arrives as HTTP 404 with
 * `Content-Type: application/json;charset=UTF-8` -- the same status and the
 * same content type as the missing-endpoint body below, and the content type
 * is a lie besides. Only the body shape can tell the two apart.
 */
const CONFIG_DATA_NOT_EXIST = 'config data not exist';

/** Captured verbatim from Nacos 2.3.2 by asking for a path no version serves. */
const SPRING_ERROR_PAGE =
  '{"timestamp":"2026-08-14T00:34:34.539+08:00","status":404,"error":"Not Found","message":"No message available","path":"/nacos/v1/cs/__nosuchendpoint__"}';

describe('isSpringErrorPage', () => {
  it('recognizes the error page a real Nacos 2.3.2 serves for a path it has no endpoint for', () => {
    expect(isSpringErrorPage(SPRING_ERROR_PAGE)).toBe(true);
  });

  it('does not mistake a real Nacos 2.3.2 missing-config body for a missing endpoint', () => {
    expect(isSpringErrorPage(CONFIG_DATA_NOT_EXIST)).toBe(false);
  });

  /**
   * All three keys are required. Being wrong in this direction is the
   * expensive one: a Nacos error body that happens to carry a `status` would
   * be read as "this version has no such endpoint", the resolver would walk
   * every driver, and a working server would end up unusable. Being wrong the
   * other way only costs three wasted requests.
   */
  it('does not treat a body carrying only a status as a missing endpoint', () => {
    expect(isSpringErrorPage('{"status":404}')).toBe(false);
  });

  it('rejects a JSON body that is missing the path key', () => {
    expect(isSpringErrorPage('{"timestamp":"2026-08-14T00:34:34.539+08:00","status":404,"error":"Not Found"}')).toBe(
      false
    );
  });

  it('rejects a JSON body that is missing the error key', () => {
    expect(isSpringErrorPage('{"status":404,"path":"/nacos/v1/cs/configs"}')).toBe(false);
  });

  it('rejects a JSON array, which has no keys to carry the three fields', () => {
    expect(isSpringErrorPage('[{"status":404,"error":"Not Found","path":"/x"}]')).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(isSpringErrorPage('')).toBe(false);
  });

  it('rejects a body that is not JSON at all', () => {
    expect(isSpringErrorPage('<html><body>404 Not Found</body></html>')).toBe(false);
  });

  /** v2/v3 answer a missing config with their own envelope, which carries none of the three keys. */
  it('does not mistake the v2 resource-not-found envelope for a missing endpoint', () => {
    expect(isSpringErrorPage('{"code":20004,"message":"resource not found","data":null}')).toBe(false);
  });

  /**
   * Only the top level counts. A Nacos body that quotes an upstream error page
   * inside `data` is still Nacos answering, so the endpoint exists.
   */
  it('ignores the three keys when they are nested rather than at the top level', () => {
    expect(isSpringErrorPage('{"code":500,"data":{"status":404,"error":"Not Found","path":"/x"}}')).toBe(false);
  });

  it.each([
    ['a JSON null', 'null'],
    ['a bare JSON number', '404'],
    ['a bare JSON string', '"config data not exist"'],
    ['whitespace only', '   '],
    ['a truncated JSON object', '{"status":404,"error":"Not Found","path":']
  ])('rejects %s without throwing', (_label, body) => {
    expect(isSpringErrorPage(body)).toBe(false);
  });
});
