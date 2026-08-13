import { isRecord } from '../jsonGuards';

/**
 * Whether a 404 body is Spring Boot's error page rather than Nacos's own
 * answer.
 *
 * Nacos overloads 404 for two unrelated things: this server version has no
 * such endpoint, and this server has no such config. The first must make the
 * resolver try the next driver; the second must not, or every lookup of a
 * dataId that does not exist walks the whole chain and reports "no API flavor
 * could serve this" instead of "no such config".
 *
 * The content type cannot be used to tell them apart -- a real Nacos 2.3.2
 * answers `config data not exist` with `Content-Type: application/json`,
 * which is a lie. Only the body shape discriminates, and all three keys are
 * required so that a Nacos error body that happens to carry a `status` field
 * is not mistaken for a missing endpoint: reading a present endpoint as
 * absent turns a working server into an unusable one, while reading an absent
 * endpoint as present only costs the three requests the chain would have
 * spent anyway.
 */
export function isSpringErrorPage(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Nacos's own 404 text, an HTML page from a proxy, or an empty body.
    return false;
  }
  return isRecord(parsed) && 'status' in parsed && 'error' in parsed && 'path' in parsed;
}
