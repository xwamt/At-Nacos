import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NacosApiError } from '../../../src/nacos/NacosApiError';
import { NacosHttpClient } from '../../../src/nacos/NacosHttpClient';
import type { NacosApiFlavor, NacosDriver } from '../../../src/nacos/driver/NacosDriver';
import { V1Driver } from '../../../src/nacos/driver/V1Driver';
import { V2Driver } from '../../../src/nacos/driver/V2Driver';
import { V3AdminDriver } from '../../../src/nacos/driver/V3AdminDriver';
import { V3ConsoleDriver } from '../../../src/nacos/driver/V3ConsoleDriver';
import type { NacosInstance, NacosServiceRef } from '../../../src/nacos/driver/normalize';
import { startTestHttpServer, type TestHttpServer, type TestRequestHandler } from '../testHttpServer';

/** Kept on the server base URL and off the console one, exactly as Nacos 3.x deploys them. */
const CONTEXT_PATH = '/nacos';

/** Not '' or 'public', so a dropped namespace parameter cannot pass by accident. */
const NAMESPACE_ID = 'uat';
const GROUP = 'cl-intimfy';
const DATA_ID = 'application-uat.yml';

const NACOS_JSON_CONTENT_TYPE = 'application/json;charset=UTF-8';

/**
 * What a publish carries. `type` is required by the interface for the reason
 * §M5 Task 1 exists to enforce: 2.3.2's ConfigController answers a blank or
 * unrecognized type with `configForm.setType(ConfigType.getDefaultType())`,
 * which is `text` -- so a publish that leaves it out silently resets a YAML
 * config to plain text and the next reader loses its highlighting.
 */
const PUBLISH = {
  namespaceId: NAMESPACE_ID,
  group: GROUP,
  dataId: DATA_ID,
  content: 'spring:\n  application:\n    name: order\n',
  type: 'yaml'
};

/** The service the instance under test belongs to. */
const SERVICE: NacosServiceRef = { namespaceId: NAMESPACE_ID, group: GROUP, serviceName: 'order-service' };

/**
 * One instance exactly as `listInstances` normalizes it off a real 2.3.2.
 *
 * The weight is deliberately not 1 and the metadata deliberately not empty:
 * both are what the update endpoint's builder defaults to when a request
 * omits them, so a driver that sent only the address and `enabled` would pass
 * a test built on the defaults and still destroy a real instance's weight and
 * metadata.
 */
const INSTANCE: NacosInstance = {
  ip: '10.0.0.7',
  port: 8080,
  healthy: true,
  enabled: true,
  weight: 2,
  clusterName: 'DEFAULT',
  ephemeral: true,
  instanceId: '10.0.0.7#8080#DEFAULT#cl-intimfy@@order-service',
  metadata: { version: '1.2.0' }
};

interface WriteDriverCase {
  flavor: NacosApiFlavor;
  publishPath: string;
  deletePath: string;
  instancePath: string;
  /** §6.1: only the v1 config endpoints say `tenant`, and v2 reaches them too. */
  configNamespaceParam: 'tenant' | 'namespaceId';
  configGroupParam: 'group' | 'groupName';
  /** v1's naming endpoints carry the group inside the service name and have no group parameter. */
  sendsGroupedServiceName: boolean;
  /** v3-console lives on its own origin, so its requests carry no context path. */
  onConsoleOrigin: boolean;
  /** v1's config writes answer a bare `true`; v2/v3 wrap the same boolean. */
  configAccepted: string;
  configRefused: string;
  /** The instance update answers a String, not a Boolean: bare `ok` on v1, wrapped from v2 on. */
  instanceAccepted: string;
  make(http: NacosHttpClient, consoleBaseUrl: string): NacosDriver;
}

const WRITE_CASES: WriteDriverCase[] = [
  {
    flavor: 'v1',
    publishPath: '/v1/cs/configs',
    deletePath: '/v1/cs/configs',
    instancePath: '/v1/ns/instance',
    configNamespaceParam: 'tenant',
    configGroupParam: 'group',
    sendsGroupedServiceName: true,
    onConsoleOrigin: false,
    configAccepted: 'true',
    configRefused: 'false',
    instanceAccepted: 'ok',
    make: (http) => new V1Driver(http)
  },
  {
    flavor: 'v2',
    publishPath: '/v1/cs/configs',
    deletePath: '/v1/cs/configs',
    instancePath: '/v2/ns/instance',
    configNamespaceParam: 'tenant',
    configGroupParam: 'group',
    sendsGroupedServiceName: false,
    onConsoleOrigin: false,
    configAccepted: 'true',
    configRefused: 'false',
    instanceAccepted: '{"code":0,"message":"success","data":"ok"}',
    make: (http) => new V2Driver(http)
  },
  {
    flavor: 'v3-admin',
    publishPath: '/v3/admin/cs/config',
    deletePath: '/v3/admin/cs/config',
    instancePath: '/v3/admin/ns/instance',
    configNamespaceParam: 'namespaceId',
    configGroupParam: 'groupName',
    sendsGroupedServiceName: false,
    onConsoleOrigin: false,
    configAccepted: '{"code":0,"message":"success","data":true}',
    configRefused: '{"code":0,"message":"success","data":false}',
    instanceAccepted: '{"code":0,"message":"success","data":"ok"}',
    make: (http) => new V3AdminDriver(http)
  },
  {
    flavor: 'v3-console',
    publishPath: '/v3/console/cs/config',
    deletePath: '/v3/console/cs/config',
    instancePath: '/v3/console/ns/instance',
    configNamespaceParam: 'namespaceId',
    configGroupParam: 'groupName',
    sendsGroupedServiceName: false,
    onConsoleOrigin: true,
    configAccepted: '{"code":0,"message":"success","data":true}',
    configRefused: '{"code":0,"message":"success","data":false}',
    instanceAccepted: '{"code":0,"message":"success","data":"ok"}',
    make: (http, consoleBaseUrl) => new V3ConsoleDriver(http, consoleBaseUrl)
  }
];

/** Where a driver's request should land, context path included or not. */
function expectedPath(driverCase: WriteDriverCase, path: string): string {
  return driverCase.onConsoleOrigin ? path : `${CONTEXT_PATH}${path}`;
}

function respondWith(status: number, body: string, contentType = NACOS_JSON_CONTENT_TYPE): TestRequestHandler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': contentType });
    response.end(body);
  };
}

/**
 * Runs a driver against a real HTTP server rather than a recording stub.
 *
 * For a write this is not a preference. The whole encoding question --
 * whether a config body containing `&`, `=`, `+`, a newline or a Chinese
 * character survives as the same bytes -- lives between the driver's
 * `form` object and what the server parses out of the request body, and a
 * stub that records `options.form` never crosses that boundary.
 */
async function drive<T>(
  driverCase: WriteDriverCase,
  handler: TestRequestHandler,
  run: (driver: NacosDriver) => Promise<T>
): Promise<{ requests: TestHttpServer['requests']; result: PromiseSettledResult<T> }> {
  const server = await startTestHttpServer(handler);
  try {
    const http = new NacosHttpClient({ baseUrl: `${server.origin}${CONTEXT_PATH}` });
    const [result] = await Promise.allSettled([run(driverCase.make(http, server.origin))]);
    return { requests: server.requests, result: result as PromiseSettledResult<T> };
  } finally {
    await server.close();
  }
}

/** Surfaces the driver's own failure instead of an unhelpful "undefined is not an object". */
function valueOf<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') {
    throw result.reason;
  }
  return result.value;
}

function errorOf<T>(result: PromiseSettledResult<T>): NacosApiError {
  if (result.status === 'fulfilled') {
    throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  }
  expect(result.reason).toBeInstanceOf(NacosApiError);
  return result.reason as NacosApiError;
}

function pathOf(url: string): string {
  return url.split('?')[0] ?? '';
}

function queryOf(url: string): URLSearchParams {
  return new URL(url, 'http://127.0.0.1').searchParams;
}

/**
 * The form body as the server parsed it, which is the only reading that
 * means anything: `URLSearchParams` is the same percent-decoding a servlet
 * container applies to `application/x-www-form-urlencoded`.
 */
function formOf(request: TestHttpServer['requests'][number] | undefined): URLSearchParams {
  return new URLSearchParams(request?.body ?? '');
}

for (const driverCase of WRITE_CASES) {
  const {
    flavor,
    publishPath,
    deletePath,
    instancePath,
    configNamespaceParam,
    configGroupParam,
    sendsGroupedServiceName,
    configAccepted,
    configRefused,
    instanceAccepted
  } = driverCase;
  const otherNamespaceParam = configNamespaceParam === 'tenant' ? 'namespaceId' : 'tenant';
  const otherGroupParam = configGroupParam === 'group' ? 'groupName' : 'group';

  describe(`${flavor} publishConfig`, () => {
    it(`posts to ${publishPath}`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, configAccepted), (driver) =>
        driver.publishConfig(PUBLISH)
      );
      valueOf(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe('POST');
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, publishPath));
    });

    /**
     * Nacos's write endpoints are all `@RequestParam`, which Spring reads
     * from the request parameters -- the query string and a
     * `application/x-www-form-urlencoded` body, never a JSON one. A JSON body
     * is not refused, it is ignored, and the server then answers "parameter
     * missing" about a field the request did send.
     */
    it('sends the fields as a form body, not as JSON', async () => {
      const { requests } = await drive(driverCase, respondWith(200, configAccepted), (driver) =>
        driver.publishConfig(PUBLISH)
      );
      expect(requests[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect(formOf(requests[0]).get('content')).toBe(PUBLISH.content);
    });

    it(`names the config ${configNamespaceParam}/${configGroupParam}, never ${otherNamespaceParam}/${otherGroupParam}`, async () => {
      const { requests } = await drive(driverCase, respondWith(200, configAccepted), (driver) =>
        driver.publishConfig(PUBLISH)
      );
      const form = formOf(requests[0]);
      expect(form.get('dataId')).toBe(DATA_ID);
      expect(form.get(configGroupParam)).toBe(GROUP);
      expect(form.get(configNamespaceParam)).toBe(NAMESPACE_ID);
      expect(form.has(otherGroupParam)).toBe(false);
      expect(form.has(otherNamespaceParam)).toBe(false);
    });

    /** Omit it and the stored type becomes `text`, taking the syntax highlighting with it. */
    it('carries the type the caller supplied', async () => {
      const { requests } = await drive(driverCase, respondWith(200, configAccepted), (driver) =>
        driver.publishConfig(PUBLISH)
      );
      expect(formOf(requests[0]).get('type')).toBe('yaml');
    });

    /**
     * A blank type is the same reset spelled a different way, so it is
     * refused before anything is sent -- `validation`, which does not fall
     * through, because no other API version would treat it differently.
     */
    it('refuses a blank type without sending anything', async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, configAccepted), (driver) =>
        driver.publishConfig({ ...PUBLISH, type: '  ' })
      );
      expect(errorOf(result).kind).toBe('validation');
      expect(requests).toHaveLength(0);
    });

    it('reads the accepted answer of this version as success', async () => {
      const { result } = await drive(driverCase, respondWith(200, configAccepted), (driver) =>
        driver.publishConfig(PUBLISH)
      );
      expect(valueOf(result)).toBeUndefined();
    });

    /**
     * The lie. HTTP 200 with `false` is one of the ways Nacos reports a write
     * it did not perform -- a permission refusal or a validation rejection --
     * and reading it as success would tell a user their config was published
     * when the server had thrown it away.
     */
    it('reads HTTP 200 with false as a refusal, not as success', async () => {
      const { result } = await drive(driverCase, respondWith(200, configRefused), (driver) =>
        driver.publishConfig(PUBLISH)
      );
      const error = errorOf(result);
      expect(error.kind).toBe('api-error');
      expect(error.message).toContain('refused');
      // Not a fall-through: retrying a write against another API family is
      // the last thing a refused write should provoke.
      expect(error.shouldFallThrough()).toBe(false);
    });
  });

  describe(`${flavor} deleteConfig`, () => {
    it(`deletes at ${deletePath}`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, configAccepted), (driver) =>
        driver.deleteConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID })
      );
      valueOf(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe('DELETE');
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, deletePath));
    });

    /**
     * A DELETE's parameters cannot travel in a form. A servlet container
     * parses a `x-www-form-urlencoded` body for POST alone, so a form body
     * here reaches no `@RequestParam` at all and the server answers
     * "parameter missing" about a dataId the request did send.
     */
    it('puts the parameters in the query string, with no request body at all', async () => {
      const { requests } = await drive(driverCase, respondWith(200, configAccepted), (driver) =>
        driver.deleteConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID })
      );
      expect(requests[0]?.body).toBe('');
      const query = queryOf(requests[0]?.url ?? '');
      expect(query.get('dataId')).toBe(DATA_ID);
      expect(query.get(configGroupParam)).toBe(GROUP);
      expect(query.get(configNamespaceParam)).toBe(NAMESPACE_ID);
      expect(query.has(otherGroupParam)).toBe(false);
      expect(query.has(otherNamespaceParam)).toBe(false);
    });

    /**
     * Deleting a dataId nobody published is a plain success, not an error:
     * 2.3.2's `ConfigOperationService.deleteConfig` answers `true` whether or
     * not a row was there. Anything treating that as "the config was missing"
     * would be inventing a distinction the server does not draw.
     */
    it('treats deleting a config that does not exist as the success the server reports', async () => {
      const { result } = await drive(driverCase, respondWith(200, configAccepted), (driver) =>
        driver.deleteConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: 'at-nacos-never-published.yml' })
      );
      expect(valueOf(result)).toBeUndefined();
    });

    it('reads HTTP 200 with false as a refusal here too', async () => {
      const { result } = await drive(driverCase, respondWith(200, configRefused), (driver) =>
        driver.deleteConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID })
      );
      const error = errorOf(result);
      expect(error.kind).toBe('api-error');
      expect(error.message).toContain('refused');
    });
  });

  describe(`${flavor} updateInstanceHealth`, () => {
    const takeOffline = (driver: NacosDriver): Promise<void> =>
      driver.updateInstanceHealth({ service: SERVICE, instance: INSTANCE, enabled: false });

    it(`puts to ${instancePath} with a form body`, async () => {
      const { requests, result } = await drive(driverCase, respondWith(200, instanceAccepted), takeOffline);
      valueOf(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe('PUT');
      expect(pathOf(requests[0]?.url ?? '')).toBe(expectedPath(driverCase, instancePath));
      expect(requests[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    });

    /**
     * A form body carries strings and nothing else, and both sides read it
     * that way: 2.3.2 parses the field with `ConvertUtils.toBoolean`, 3.x
     * binds it to a `Boolean` through Spring's converter. So the wire wants
     * the lower-case text `true` / `false`, which is also the only thing
     * `NacosRequestOptions.form` (a `Record<string, string>`) can carry.
     */
    it('sends enabled as the text false, not as a JS boolean', async () => {
      const { requests } = await drive(driverCase, respondWith(200, instanceAccepted), takeOffline);
      expect(formOf(requests[0]).get('enabled')).toBe('false');
    });

    it('sends enabled as the text true when putting an instance back in rotation', async () => {
      const { requests } = await drive(driverCase, respondWith(200, instanceAccepted), (driver) =>
        driver.updateInstanceHealth({ service: SERVICE, instance: { ...INSTANCE, enabled: false }, enabled: true })
      );
      expect(formOf(requests[0]).get('enabled')).toBe('true');
    });

    /**
     * The reset trap. The update rebuilds the instance from the request, and
     * every field the request omits takes a default -- weight 1, healthy
     * true, an empty metadata map. Taking an instance offline must not also
     * halve its weight and forget what it is.
     */
    it('sends the rest of the instance back verbatim, so nothing is reset by omission', async () => {
      const { requests } = await drive(driverCase, respondWith(200, instanceAccepted), takeOffline);
      const form = formOf(requests[0]);
      expect(form.get('ip')).toBe('10.0.0.7');
      expect(form.get('port')).toBe('8080');
      expect(form.get('clusterName')).toBe('DEFAULT');
      expect(form.get('weight')).toBe('2');
      expect(form.get('healthy')).toBe('true');
      expect(form.get('ephemeral')).toBe('true');
      expect(JSON.parse(form.get('metadata') ?? 'null')).toEqual({ version: '1.2.0' });
    });

    /**
     * v1's instance controller has no group parameter: the group travels
     * inside `serviceName` as `GROUP@@name`, which is what every version's
     * `NamingUtils.getGroupName` reads back out. v2 onward takes the two
     * apart, and a grouped name sent *there* is composed in twice.
     */
    it(
      sendsGroupedServiceName
        ? 'folds the group into the service name, as the v1 naming dialect requires'
        : 'sends the group beside a bare service name',
      async () => {
        const { requests } = await drive(driverCase, respondWith(200, instanceAccepted), takeOffline);
        const form = formOf(requests[0]);
        expect(form.get('namespaceId')).toBe(NAMESPACE_ID);
        if (sendsGroupedServiceName) {
          expect(form.get('serviceName')).toBe(`${GROUP}@@order-service`);
          expect(form.has('groupName')).toBe(false);
        } else {
          expect(form.get('serviceName')).toBe('order-service');
          expect(form.get('groupName')).toBe(GROUP);
        }
      }
    );

    /** Nacos derives it from the address and reads no such parameter; sending one would be noise. */
    it('does not send the instanceId back', async () => {
      const { requests } = await drive(driverCase, respondWith(200, instanceAccepted), takeOffline);
      expect(formOf(requests[0]).has('instanceId')).toBe(false);
    });

    /** The fourth success shape: this endpoint answers a String, and `ok` is not JSON on v1. */
    it('reads this version\u2019s "ok" as success rather than as an unreadable body', async () => {
      const { result } = await drive(driverCase, respondWith(200, instanceAccepted), takeOffline);
      expect(valueOf(result)).toBeUndefined();
    });
  });
}

/**
 * A configuration body is not a well-behaved form value, and this is where
 * that stops being theoretical.
 *
 * `&` and `=` are the separators of the encoding itself, `+` decodes to a
 * space unless it is escaped, `%` starts an escape sequence, a newline is a
 * control character, and a Chinese comment is several bytes per character.
 * Any one of them mishandled corrupts a production configuration in a way
 * nobody notices until the service that reads it restarts.
 */
const ADVERSARIAL_CONTENT = [
  'jdbc.url=jdbc:mysql://db:3306/app?useSSL=false&serverTimezone=UTC',
  'jdbc.password=p@ss+w0rd&salt==aGk=',
  'progress=100% done; ratio=1/2',
  '# \u4e2d\u6587\u6ce8\u91ca\uff1a\u6570\u636e\u5e93\u8fde\u63a5\u914d\u7f6e',
  'trailing.spaces=  ',
  'emoji=\u{1f680}'
].join('\r\n');

describe('what reaches the wire', () => {
  async function publishAndReadBack(content: string): Promise<{
    received: string | null;
    contentLength: string | undefined;
    bodyBytes: number;
  }> {
    const { requests } = await drive(WRITE_CASES[0] as WriteDriverCase, respondWith(200, 'true'), (driver) =>
      driver.publishConfig({ ...PUBLISH, content })
    );
    const request = requests[0];
    return {
      received: formOf(request).get('content'),
      contentLength: request?.headers['content-length'] as string | undefined,
      bodyBytes: Buffer.byteLength(request?.body ?? '')
    };
  }

  it('delivers a body full of separators, escapes, newlines and non-ASCII byte for byte', async () => {
    const { received } = await publishAndReadBack(ADVERSARIAL_CONTENT);
    expect(received).toBe(ADVERSARIAL_CONTENT);
  });

  /**
   * Spelled out one character at a time, because `toBe` on the whole string
   * says only that something is wrong. A `+` that arrived as a space is the
   * failure this encoding is famous for.
   */
  it.each([
    ['an ampersand', 'a=1&b=2'],
    ['an equals sign', 'token==padded=='],
    ['a plus sign', 'shift=a+b'],
    ['a percent sign', 'done=100%'],
    ['a newline', 'first\nsecond'],
    ['a CRLF pair', 'first\r\nsecond'],
    ['a tab', 'key\tvalue'],
    ['non-ASCII text', '\u4e2d\u6587 = \u503c'],
    ['an astral-plane character', '\u{1f680}'],
    ['a trailing space', 'key=value '],
    ['a semicolon', 'a=1;b=2']
  ])('survives %s in the content', async (_name, content) => {
    expect((await publishAndReadBack(content)).received).toBe(content);
  });

  /**
   * A config can legitimately be blank, and blanking one is not the same
   * operation as deleting it -- so the field has to arrive **present and
   * empty** rather than be dropped. Dropped, the v1 endpoint answers
   * "Required request parameter 'content' is not present" and a user is told
   * their empty configuration is a malformed request.
   *
   * Nacos's own answer to a blank body is a separate matter and is the
   * server's to give: 2.3.2 rejects it in `ParamUtils.checkParam` and 3.x in
   * `ConfigForm.validateWithContent`. The driver's job is to state what the
   * caller asked for accurately enough that the refusal is about the right
   * thing.
   */
  it('sends an empty content as a present, empty field rather than omitting it', async () => {
    const { requests } = await drive(WRITE_CASES[0] as WriteDriverCase, respondWith(200, 'true'), (driver) =>
      driver.publishConfig({ ...PUBLISH, content: '' })
    );
    const form = formOf(requests[0]);
    expect(form.has('content')).toBe(true);
    expect(form.get('content')).toBe('');
    // And it is still a publish. Nothing about an empty body may turn this
    // into the other endpoint.
    expect(requests[0]?.method).toBe('POST');
  });

  /**
   * Nacos caps one configuration at 100KB, so the largest body this ever has
   * to carry is just under it -- which after percent-escaping is several
   * times that on the wire, written in one go by `request.write`.
   */
  it('carries a body at the edge of the 100KB Nacos limit intact, with a matching content-length', async () => {
    const line = 'key.that.is.reasonably.long=value with spaces & symbols\uff0c\u4e2d\u6587\n';
    const large = line.repeat(Math.ceil(99_000 / line.length)).slice(0, 99_000);

    const { received, contentLength, bodyBytes } = await publishAndReadBack(large);

    expect(received).toHaveLength(99_000);
    expect(received).toBe(large);
    // A content-length that disagreed with the body would leave the server
    // parsing a truncated form, which reads as a missing parameter.
    expect(Number(contentLength)).toBe(bodyBytes);
  });
});

/**
 * The success decision, which is shared by all three writes and all four
 * drivers -- so it is exercised once, through one of them, rather than
 * sixteen times.
 */
describe('how a write result is read', () => {
  function publish(body: string, status = 200): ReturnType<typeof drive<void>> {
    return drive(WRITE_CASES[0] as WriteDriverCase, respondWith(status, body), (driver) =>
      driver.publishConfig(PUBLISH)
    );
  }

  it.each([
    ['v1\u2019s bare boolean', 'true'],
    ['v2/v3\u2019s wrapped boolean', '{"code":0,"message":"success","data":true}'],
    ['1.x\u2019s RestResult, whose success code is 200 rather than 0', '{"code":200,"message":null,"data":true}'],
    ['the instance update\u2019s bare ok', 'ok'],
    ['the instance update\u2019s wrapped ok', '{"code":0,"message":"success","data":"ok"}'],
    ['a boolean that arrived as text', '"true"'],
    ['a body with whitespace around it', '  true\n']
  ])('accepts %s', async (_name, body) => {
    expect(valueOf(await publish(body).then((outcome) => outcome.result))).toBeUndefined();
  });

  it.each([
    ['a bare false', 'false'],
    ['a wrapped false', '{"code":0,"message":"success","data":false}'],
    ['a false that arrived as text', '"false"']
  ])('reads %s as a refusal, naming the server as the one that refused', async (_name, body) => {
    const { result } = await publish(body);
    const error = errorOf(result);
    expect(error.kind).toBe('api-error');
    expect(error.message).toContain('refused');
    expect(error.shouldFallThrough()).toBe(false);
  });

  /**
   * §6.3: some endpoints report a business failure under HTTP 200 with the
   * real error only in `code`. `requestJson` checks that for every caller
   * that can use it, and a write cannot use it -- v1's `ok` is not JSON --
   * so the check has to be restored here or the code is never looked at.
   */
  it('reads a business error code under HTTP 200 as the failure it is', async () => {
    const { result } = await publish('{"code":10001,"message":"access denied"}');
    const error = errorOf(result);
    expect(error.kind).toBe('api-error');
    expect(error.message).toContain('access denied');
  });

  /** Silence is not consent: a write that answered nothing has not said it happened. */
  it.each([
    ['an empty body', ''],
    ['a body that is neither a confirmation nor a refusal', '{"code":0,"data":{"unexpected":1}}']
  ])('refuses to read %s as success', async (_name, body) => {
    const { result } = await publish(body);
    expect(errorOf(result).kind).toBe('invalid-response');
  });

  /**
   * The classifications a read gets, unchanged. 403 and 404 keep falling
   * through, which for a write is the 3.x path that matters: an ordinary
   * account is refused by the admin API and served by the console one.
   */
  it.each([
    [403, 'forbidden', true],
    [404, 'not-found', true],
    [410, 'api-deprecated', true],
    [500, 'api-error', false]
  ])('classifies HTTP %s as %s', async (status, kind, fallsThrough) => {
    const { result } = await publish('{"code":10001,"message":"denied"}', status);
    const error = errorOf(result);
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.shouldFallThrough()).toBe(fallsThrough);
  });
});

describe('what a publish does with the fields a caller may leave out', () => {
  async function formFor(request: Partial<typeof PUBLISH> & { appName?: string; description?: string }) {
    const { requests } = await drive(WRITE_CASES[0] as WriteDriverCase, respondWith(200, 'true'), (driver) =>
      driver.publishConfig({ ...PUBLISH, ...request })
    );
    return formOf(requests[0]);
  }

  it('carries an appName and a description through when it was given them', async () => {
    const form = await formFor({ appName: 'order-service', description: 'the UAT copy' });
    expect(form.get('appName')).toBe('order-service');
    expect(form.get('desc')).toBe('the UAT copy');
  });

  /**
   * A publish rewrites the whole row, so a field left out is not left alone
   * -- it is overwritten with nothing. Sending the empty string makes that
   * visible on the wire instead of leaving it to be discovered afterwards,
   * and it is the same value the server would have stored either way.
   */
  it('sends them empty rather than omitting them, because an omitted one is cleared all the same', async () => {
    const form = await formFor({});
    expect(form.get('appName')).toBe('');
    expect(form.get('desc')).toBe('');
  });
});

const CONSOLE_BASE_URL = 'http://h:8080';

describe('where the console driver sends its writes', () => {
  /**
   * 3.x's console API is a **different origin** -- port 8080, empty context
   * path -- so a write that forgot the override would reach `/nacos` on 8848,
   * which for a POST is not a 404 but a different server's endpoint.
   */
  it('sends all three writes to the console origin', async () => {
    const calls: { path: string; baseUrlOverride: string | undefined }[] = [];
    const http = {
      requestJson: <T,>(): Promise<T> => Promise.reject(new Error('a write must not use requestJson')),
      requestRaw: (_method: string, path: string, options?: { baseUrlOverride?: string }) => {
        calls.push({ path, baseUrlOverride: options?.baseUrlOverride });
        return Promise.resolve({ status: 200, ok: true, text: 'true', contentType: 'text/plain' });
      }
    };
    const driver = new V3ConsoleDriver(http as never, CONSOLE_BASE_URL);

    await driver.publishConfig(PUBLISH);
    await driver.deleteConfig({ namespaceId: NAMESPACE_ID, group: GROUP, dataId: DATA_ID });
    await driver.updateInstanceHealth({ service: SERVICE, instance: INSTANCE, enabled: false });

    expect(calls).toEqual([
      { path: '/v3/console/cs/config', baseUrlOverride: CONSOLE_BASE_URL },
      { path: '/v3/console/cs/config', baseUrlOverride: CONSOLE_BASE_URL },
      { path: '/v3/console/ns/instance', baseUrlOverride: CONSOLE_BASE_URL }
    ]);
  });
});

/**
 * The one safety rule this layer is required **not** to enforce.
 *
 * An instance's "read only" switch is a fact about how this workspace has
 * configured a server, not about the server, and M5 enforces it twice above
 * here: the tree hides the write commands from a node whose contextValue
 * carries `.readonly`, and `confirmWrite` asserts it again for a command
 * invoked from the palette. A driver that checked it a third time would put
 * one rule in three places, and a rule in three places is a rule with a path
 * where none of the copies runs.
 *
 * Checked as a layering fact rather than a behaviour, because that is what it
 * is: the driver layer cannot read the flag, since it has no way to reach the
 * module the flag is declared in.
 */
describe('the driver layer and the read-only switch', () => {
  const DRIVER_DIRECTORY = resolve(process.cwd(), 'src/nacos/driver');

  function driverSources(): { name: string; source: string }[] {
    return readdirSync(DRIVER_DIRECTORY)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({ name, source: readFileSync(join(DRIVER_DIRECTORY, name), 'utf8') }));
  }

  it('has driver sources to check at all, so a rename cannot quietly empty this suite', () => {
    expect(driverSources().map((entry) => entry.name)).toContain('writes.ts');
  });

  it('reaches neither the instance configuration nor vscode from anywhere in the driver layer', () => {
    for (const { name, source } of driverSources()) {
      expect(source, `${name} imports the instance configuration, where readOnly lives`).not.toMatch(
        /from\s+'(\.\.\/)+config\//
      );
      expect(source, `${name} imports vscode`).not.toMatch(/from\s+'vscode'/);
    }
  });

  /** And nothing in the write request types names it either, so it cannot arrive as an argument. */
  it('takes no read-only flag as part of a write request', async () => {
    const { requests } = await drive(WRITE_CASES[0] as WriteDriverCase, respondWith(200, 'true'), (driver) =>
      driver.publishConfig(PUBLISH)
    );
    expect(requests[0]?.body).not.toContain('readOnly');
  });
});
