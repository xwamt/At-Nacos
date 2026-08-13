import { afterEach, describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import { NacosHttpClient } from '../../../src/nacos/NacosHttpClient';
import { candidateBaseUrls, fetchConsoleHint, parseConsoleHint } from '../../../src/nacos/probe/resolveBaseUrl';
import { startTestHttpServer, type TestHttpServer } from '../testHttpServer';

/** What Nacos 3.x's NacosConsolePathTipFilter answers at `{base}/`. */
const CONSOLE_TIP = 'Nacos Console default port is 8080, and the path is /.';

let server: TestHttpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('candidateBaseUrls', () => {
  it('keeps an explicit context path as the only candidate', () => {
    expect(candidateBaseUrls('http://h:8848/nacos')).toEqual(['http://h:8848/nacos']);
  });

  it('tries /nacos before the bare origin when no context path was given', () => {
    expect(candidateBaseUrls('http://h:8848')).toEqual(['http://h:8848/nacos', 'http://h:8848']);
  });

  it('strips trailing slashes before building candidates', () => {
    expect(candidateBaseUrls('http://h:8848///')).toEqual(['http://h:8848/nacos', 'http://h:8848']);
  });

  it('treats a path of exactly / as no context path at all', () => {
    expect(candidateBaseUrls('http://h:8848/')).toEqual(['http://h:8848/nacos', 'http://h:8848']);
  });

  it('strips the trailing slash of an explicit context path', () => {
    expect(candidateBaseUrls('http://h:8848/nacos/')).toEqual(['http://h:8848/nacos']);
  });

  it('keeps https and its implicit port', () => {
    expect(candidateBaseUrls('https://nacos.example.com')).toEqual([
      'https://nacos.example.com/nacos',
      'https://nacos.example.com'
    ]);
    expect(candidateBaseUrls('https://nacos.example.com/prod-nacos')).toEqual(['https://nacos.example.com/prod-nacos']);
  });

  it('handles a URL with no port', () => {
    expect(candidateBaseUrls('http://nacos')).toEqual(['http://nacos/nacos', 'http://nacos']);
  });

  it('ignores surrounding whitespace', () => {
    expect(candidateBaseUrls('  http://h:8848/nacos  ')).toEqual(['http://h:8848/nacos']);
  });

  /**
   * A candidate is used as a base URL, and relative resolution against
   * `http://h:8848/nacos?x=1/` throws the context path away -- the request
   * lands on `/v1/...`. The explicit-path branch hands back what the user
   * typed, so the query and fragment have to come off before it does.
   */
  it('drops a query string, which would otherwise erase the context path', () => {
    expect(candidateBaseUrls('http://h:8848/nacos?x=1')).toEqual(['http://h:8848/nacos']);
    expect(candidateBaseUrls('http://h:8848?x=1')).toEqual(['http://h:8848/nacos', 'http://h:8848']);
  });

  /** Copying the console URL out of a browser address bar produces exactly this. */
  it('drops a fragment', () => {
    expect(candidateBaseUrls('http://h:8848/nacos#frag')).toEqual(['http://h:8848/nacos']);
    expect(candidateBaseUrls('http://h:8848/nacos/#/login')).toEqual(['http://h:8848/nacos']);
  });

  it('drops a fragment that itself contains a question mark', () => {
    expect(candidateBaseUrls('http://h:8848/nacos#/login?redirect=/x')).toEqual(['http://h:8848/nacos']);
  });

  /**
   * Only the origin-derived candidates get normalized, because the explicit
   * branch exists precisely to hand back what the user typed. Both forms are
   * accepted downstream: the HTTP client re-parses every base URL anyway.
   */
  it('normalizes an uppercase scheme only when it derives the candidates itself', () => {
    expect(candidateBaseUrls('HTTP://h:8848')).toEqual(['http://h:8848/nacos', 'http://h:8848']);
    expect(candidateBaseUrls('HTTP://h:8848/nacos')).toEqual(['HTTP://h:8848/nacos']);
  });

  it('rejects an unparseable address as a validation failure, not a raw TypeError', () => {
    const error = catchError(() => candidateBaseUrls('not a url'));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).kind).toBe('validation');
    expect((error as NacosApiError).message).toMatch(/not a valid url/i);
  });

  /**
   * An address too malformed to parse is also too malformed to strip
   * credentials out of, and this message can reach the output channel.
   */
  it('does not echo the rejected address, which may carry credentials', () => {
    const error = catchError(() => candidateBaseUrls('http://admin:hunter2@ho st:8848'));
    expect(error).toBeInstanceOf(NacosApiError);
    expect((error as NacosApiError).message).not.toContain('hunter2');
  });

  it('rejects an empty address', () => {
    expect(() => candidateBaseUrls('')).toThrow(NacosApiError);
    expect(() => candidateBaseUrls('   ')).toThrow(NacosApiError);
  });
});

describe('parseConsoleHint', () => {
  it('extracts the console port and path from the 3.x path tip filter response', () => {
    expect(parseConsoleHint(CONSOLE_TIP)).toEqual({ port: 8080, path: '/' });
  });

  it('returns undefined for a 1.x/2.x console HTML response', () => {
    expect(parseConsoleHint('<!DOCTYPE html><html><head><title>Nacos</title>')).toBeUndefined();
  });

  it('returns undefined for an empty body', () => {
    expect(parseConsoleHint('')).toBeUndefined();
  });

  it('ignores surrounding whitespace and newlines', () => {
    expect(parseConsoleHint(`\n  ${CONSOLE_TIP}  \n\n`)).toEqual({ port: 8080, path: '/' });
  });

  it('reads a hint that is not the last line of the body', () => {
    expect(parseConsoleHint(`Welcome.\n${CONSOLE_TIP}\nSee the docs for details.\n`)).toEqual({
      port: 8080,
      path: '/'
    });
  });

  it('reads a hint carrying CRLF line endings', () => {
    expect(parseConsoleHint(`Welcome.\r\n${CONSOLE_TIP}\r\n`)).toEqual({ port: 8080, path: '/' });
  });

  /** The upstream wording is only known approximately, so a trailing clause must not defeat it. */
  it('reads a hint followed by more text on the same line', () => {
    expect(parseConsoleHint(`${CONSOLE_TIP} Please visit the console there.`)).toEqual({ port: 8080, path: '/' });
  });

  /** An operator can change nacos.console.contextPath, so the path is not always `/`. */
  it('reads a console path other than the root', () => {
    expect(parseConsoleHint('Nacos Console default port is 8080, and the path is /console.')).toEqual({
      port: 8080,
      path: '/console'
    });
    expect(parseConsoleHint('Nacos Console default port is 9090, and the path is /console/ui. Visit it.')).toEqual({
      port: 9090,
      path: '/console/ui'
    });
  });

  it('returns undefined when the port is outside the usable range', () => {
    expect(parseConsoleHint('Nacos Console default port is 0, and the path is /.')).toBeUndefined();
    expect(parseConsoleHint('Nacos Console default port is 99999, and the path is /.')).toBeUndefined();
  });
});

describe('fetchConsoleHint', () => {
  it('reads the tip a Nacos 3.x server serves at the base path', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/plain');
      response.end(CONSOLE_TIP);
    });
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
    await expect(fetchConsoleHint(client)).resolves.toEqual({ port: 8080, path: '/' });
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: '/nacos/' });
  });

  it('returns undefined when a 1.x/2.x server answers with the console HTML', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<!DOCTYPE html><html><head><title>Nacos</title></head><body></body></html>');
    });
    const client = new NacosHttpClient({ baseUrl: `${server.origin}/nacos` });
    await expect(fetchConsoleHint(client)).resolves.toBeUndefined();
  });

  /** The tip filter's status code is unverified, so the sentence is the only signal we trust. */
  it('reads the tip even when it does not arrive with a 2xx', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.statusCode = 404;
      response.setHeader('content-type', 'text/plain');
      response.end(CONSOLE_TIP);
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(fetchConsoleHint(client)).resolves.toEqual({ port: 8080, path: '/' });
  });

  it('returns undefined rather than throwing when the server cannot be reached', async () => {
    const client = new NacosHttpClient({ baseUrl: 'http://127.0.0.1:1' });
    await expect(fetchConsoleHint(client)).resolves.toBeUndefined();
  });

  /** A body too big to be one line of text is, by that fact, not the tip. */
  it('returns undefined for a body far larger than a one-line tip', async () => {
    server = await startTestHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<!DOCTYPE html>${'x'.repeat(200_000)}`);
    });
    const client = new NacosHttpClient({ baseUrl: server.origin });
    await expect(fetchConsoleHint(client)).resolves.toBeUndefined();
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
