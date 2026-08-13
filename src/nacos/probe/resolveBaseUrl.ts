import { NacosApiError } from '../NacosApiError';
import { normalizeBaseUrl, type NacosHttpClient } from '../NacosHttpClient';

/** Nacos 3.x is the first version to serve its console from a port of its own. */
export const CONSOLE_MAJOR_VERSION = 3;

/**
 * The base URLs to try, in order. `/nacos` is not a given: a K8s Ingress and
 * some Docker images serve Nacos at the root path.
 *
 * `normalizeBaseUrl` runs again here, not because the HTTP client fails to do
 * it -- it does -- but because the candidate itself is echoed back: the
 * connection test treats whichever candidate answered as the `serverUrl` to
 * save, and storing one with `#/login` still on it would only convince the
 * user they had typed it correctly.
 */
export function candidateBaseUrls(input: string): string[] {
  const trimmed = normalizeBaseUrl(input);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // An address that will not even parse gives us no way to strip the
    // password out of its userinfo, so none of it is echoed back -- this
    // message goes to the output channel.
    throw new NacosApiError(
      'validation',
      'The Nacos server address is not a valid URL. It should look like http://host:8848/nacos.'
    );
  }
  // The user has already given a context path (the path is non-empty), so
  // take it exactly as written -- guessing would only get in the way.
  // Returning it as-is rather than rebuilding it from `origin` is what leaves
  // everything the user wrote untouched.
  if (url.pathname !== '/' && url.pathname !== '') {
    return [trimmed];
  }
  return [`${url.origin}/nacos`, url.origin];
}

/**
 * More text may follow the hint sentence, so the right-hand boundary is a
 * lookahead for whitespace (newlines included) or the end of the string,
 * rather than an end-of-line anchor: `$` with `m` only holds when the hint
 * has a line to itself, and one more sentence such as "Please visit ..." on
 * the same line would stop it matching. That lookahead is what closes off the
 * laziness of `\S+?`, so the path is still captured whole when it is not `/`
 * (an operator having changed `nacos.console.contextPath`).
 */
const CONSOLE_HINT_PATTERN = /Nacos Console default port is (\d+), and the path is (\S+?)\.?(?=\s|$)/;

export interface NacosConsoleHint {
  port: number;
  path: string;
}

/**
 * Nacos 3.x's `NacosConsolePathTipFilter` answers `{base}/` with a one-line
 * text/plain hint. Matching it settles both "this is 3.x" and "which port the
 * console is on" at once. 1.x/2.x answer the same path with the console's
 * HTML, which does not match.
 */
export function parseConsoleHint(body: string): NacosConsoleHint | undefined {
  const match = CONSOLE_HINT_PATTERN.exec(body);
  if (!match) {
    return undefined;
  }
  const port = Number.parseInt(match[1], 10);
  if (port < 1 || port > 65535) {
    return undefined;
  }
  return { port, path: match[2] };
}

/**
 * The hint is a single line. A small cap means a body that plainly cannot be
 * that sentence (the console home page 1.x/2.x serve at the same path) does
 * not have to be read to the end -- over the limit `requestRaw` throws
 * `response-too-large`, which lands squarely in the catch below.
 */
const CONSOLE_HINT_MAX_BYTES = 8 * 1024;

/**
 * Makes one raw request to `{base}/` and asks whether the answer is 3.x's
 * console hint.
 *
 * `requestRaw` for two reasons: the body is text/plain rather than JSON, and
 * the body is wanted on a non-2xx as well -- which status code this filter
 * answers with has never been confirmed against a real server, so the
 * sentence itself is the only thing worth trusting.
 *
 * Not detecting the console is not an error, only "this one is not 3.x, or it
 * will not say". So every classified failure becomes undefined: the caller
 * loses one hint, and should not lose a connection over it.
 */
export async function fetchConsoleHint(
  http: Pick<NacosHttpClient, 'requestRaw'>
): Promise<NacosConsoleHint | undefined> {
  try {
    const response = await http.requestRaw('GET', '/', { maxResponseBytes: CONSOLE_HINT_MAX_BYTES });
    return parseConsoleHint(response.text);
  } catch (error) {
    if (error instanceof NacosApiError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The hint carries a port and a path but no host, because Nacos is describing
 * itself -- so the host has to come from the base URL that answered rather
 * than from what the user typed, which may have been a bare origin.
 *
 * Rebuilt through `URL` rather than by concatenation so that an IPv6 literal
 * keeps its brackets, and stripped of any userinfo, which would otherwise be
 * copied into a field the form saves.
 */
export function composeConsoleUrl(baseUrl: string, hint: NacosConsoleHint): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  url.username = '';
  url.password = '';
  url.pathname = hint.path;
  url.port = String(hint.port);
  return normalizeBaseUrl(url.href);
}

/**
 * Asks a 3.x server where its console is and turns the answer into a base URL.
 *
 * Every failure becomes undefined, the unparsable hint included. A console
 * that cannot be located is one fallback the caller does not get, not a
 * connection that failed: the admin API is still there, and on an
 * administrator account it is all that is needed.
 */
export async function discoverConsoleBaseUrl(
  http: Pick<NacosHttpClient, 'requestRaw'>,
  baseUrl: string
): Promise<string | undefined> {
  try {
    const hint = await fetchConsoleHint(http);
    return hint && composeConsoleUrl(baseUrl, hint);
  } catch {
    return undefined;
  }
}
