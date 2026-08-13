import { describe, expect, it } from 'vitest';
import { asRedactedLog, createRedactedLog, noopLog, type LogLevelName, type LogSink } from '../../src/utils/logger';

interface CapturedLine {
  level: LogLevelName;
  message: string;
}

function capturingSink(): { sink: LogSink; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const push = (level: LogLevelName) => (message: string) => {
    lines.push({ level, message });
  };
  return {
    lines,
    sink: { error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug'), trace: push('trace') }
  };
}

/**
 * Every secret shape that can realistically reach this extension's channel,
 * each embedded in the text that would carry it. The assertion is deliberately
 * "the raw secret does not appear anywhere in the channel", not "the message
 * equals X" -- a future logger that reformats messages must still keep every
 * one of these out.
 */
const CREDENTIALS = {
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuYWNvcyIsImV4cCI6MTcwMDAwMDAwMH0.Sf1kXPnI9v0',
  datasourcePassword: 'hunter2',
  redisPassword: 'r3disPass',
  aliyunAccessKey: 'LTAI5tSomeAliyunKey'
};

describe('createRedactedLog', () => {
  it('forwards each level to the matching sink method', () => {
    const { sink, lines } = capturingSink();
    const log = createRedactedLog(sink);

    log.error('boom');
    log.warn('careful');
    log.info('started');
    log.debug('detail');
    log.trace('flow');

    expect(lines).toEqual([
      { level: 'error', message: 'boom' },
      { level: 'warn', message: 'careful' },
      { level: 'info', message: 'started' },
      { level: 'debug', message: 'detail' },
      { level: 'trace', message: 'flow' }
    ]);
  });

  it('scrubs every credential shape out of every level before the sink sees it', () => {
    const { sink, lines } = capturingSink();
    const log = createRedactedLog(sink);

    log.error(`Nacos rejected the request: authorization: Bearer ${CREDENTIALS.accessToken}`);
    log.warn(`config content carries spring.datasource.password=${CREDENTIALS.datasourcePassword}`);
    log.info(`applied spring.redis.password: ${CREDENTIALS.redisPassword}`);
    log.debug(`instance credential accessKey=${CREDENTIALS.aliyunAccessKey} rotated`);
    log.trace(`GET /nacos/v1/cs/configs?accessToken=${CREDENTIALS.accessToken}&pageNo=1 -> 200`);
    log.error('-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----');

    const channelText = lines.map((line) => line.message).join('\n');
    for (const [name, secret] of Object.entries(CREDENTIALS)) {
      expect(channelText, `${name} leaked into the output channel`).not.toContain(secret);
    }
    expect(channelText).not.toContain('MIIEow');

    expect(lines.map((line) => line.message)).toEqual([
      'Nacos rejected the request: authorization: Bearer [REDACTED]',
      'config content carries spring.datasource.password=[REDACTED]',
      'applied spring.redis.password: [REDACTED]',
      'instance credential accessKey=[REDACTED] rotated',
      // The pagination survives because the JWT is replaced before the field
      // pattern runs, and the marker it leaves behind is matched as itself.
      'GET /nacos/v1/cs/configs?accessToken=[REDACTED]&pageNo=1 -> 200',
      '[REDACTED_PRIVATE_KEY]'
    ]);
  });

  it('redacts a credential that survived one pass of formatError', () => {
    // formatError already redacts, so log lines are frequently redacted twice.
    // Re-redacting must be a no-op rather than mangling the marker.
    const { sink, lines } = capturingSink();
    const log = createRedactedLog(sink);

    log.error('Bearer [REDACTED] rejected while calling accessToken=[REDACTED]');

    expect(lines[0]?.message).toBe('Bearer [REDACTED] rejected while calling accessToken=[REDACTED]');
  });

  it('keeps the useful part of a diagnostic intact', () => {
    const { sink, lines } = capturingSink();
    const log = createRedactedLog(sink);

    log.warn('listing namespace public hit the page guardrail (pageNo=11, pageSize=100)');

    expect(lines[0]?.message).toBe('listing namespace public hit the page guardrail (pageNo=11, pageSize=100)');
  });

  it('noopLog accepts every level without a sink', () => {
    expect(() => {
      noopLog.error('e');
      noopLog.warn('w');
      noopLog.info('i');
      noopLog.debug('d');
      noopLog.trace('t');
    }).not.toThrow();
  });
});

describe('asRedactedLog', () => {
  it('falls back to the no-op log rather than making logging a behavior', () => {
    expect(asRedactedLog(undefined)).toBe(noopLog);
    expect(asRedactedLog(noopLog)).toBe(noopLog);
  });

  it('redacts through a sink that never went through createRedactedLog', () => {
    const { sink, lines } = capturingSink();

    asRedactedLog(sink).error('spring.datasource.password=hunter2');

    expect(lines[0]?.message).toBe('spring.datasource.password=[REDACTED]');
  });

  it('survives being applied to an already-wrapped log', () => {
    const { sink, lines } = capturingSink();

    asRedactedLog(asRedactedLog(sink)).error('accessToken=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuYWNvcyJ9.abc123');

    expect(lines[0]?.message).toBe('accessToken=[REDACTED]');
  });
});
