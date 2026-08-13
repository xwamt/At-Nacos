import { describe, expect, it } from 'vitest';
import { redactSensitiveText, toUserMessage } from '../../src/utils/redaction';

describe('redactSensitiveText', () => {
  it('redacts a JWT access token', () => {
    const text = 'accessToken=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuYWNvcyJ9.abc123';
    expect(redactSensitiveText(text)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redactSensitiveText(text)).toContain('[REDACTED]');
  });

  it('redacts a bearer header value', () => {
    expect(redactSensitiveText('authorization: Bearer eyJhbGciOi.xxx.yyy')).toBe(
      'authorization: Bearer [REDACTED]'
    );
  });

  it('redacts spring datasource passwords found in config content', () => {
    const text = 'spring.datasource.password=hunter2';
    expect(redactSensitiveText(text)).toBe('spring.datasource.password=[REDACTED]');
  });

  it('is idempotent so double-redaction does not mangle the marker', () => {
    const once = redactSensitiveText('spring.datasource.password=hunter2');
    expect(redactSensitiveText(once)).toBe(once);
  });

  it('redacts a bare password and a private key block', () => {
    const input = 'password=secret -----BEGIN OPENSSH PRIVATE KEY----- abc';
    expect(redactSensitiveText(input)).toBe('password=[REDACTED] [REDACTED_PRIVATE_KEY]');
  });

  it('redacts a colon-form secret, the shape a YAML configuration uses', () => {
    expect(redactSensitiveText('spring:\n  redis:\n    password: r3disPass')).toBe(
      'spring:\n  redis:\n    password: [REDACTED]'
    );
    expect(redactSensitiveText('secret: s3cr3tV4lue')).toBe('secret: [REDACTED]');
  });

  it('redacts an access key in either casing', () => {
    expect(redactSensitiveText('accessKey=LTAI5tSomeAliyunKey')).toBe('accessKey=[REDACTED]');
    expect(redactSensitiveText('nacos.remote.accesskey=abc123')).toBe('nacos.remote.accesskey=[REDACTED]');
  });

  it('redacts a key whose secret word is joined by an underscore', () => {
    // The shape every connection string and container env var uses, and the
    // one the previous `password=` pattern covered -- a word boundary before
    // `password` would silently stop matching all of them.
    expect(redactSensitiveText('db_password=hunter2')).toBe('db_password=[REDACTED]');
    expect(redactSensitiveText('MYSQL_ROOT_PASSWORD=hunter2')).toBe('MYSQL_ROOT_PASSWORD=[REDACTED]');
  });

  it('redacts an accessToken carried in a request URL, at the cost of the query tail', () => {
    const redacted = redactSensitiveText(
      'GET /nacos/v1/cs/configs?accessToken=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuYWNvcyJ9.Sf1kx&pageNo=1 -> 403'
    );
    expect(redacted).not.toContain('eyJzdWIiOiJuYWNvcyJ9');
    expect(redacted).toBe('GET /nacos/v1/cs/configs?accessToken=[REDACTED] -> 403');
  });

  it('leaves configuration keys that only look sensitive alone', () => {
    const benign = [
      'spring.application.name=my-app',
      'server.port=8848',
      'nacos.core.auth.plugin.nacos.token.expire.seconds=18000'
    ];
    for (const line of benign) {
      expect(redactSensitiveText(line)).toBe(line);
    }
  });

  it('leaves ordinary diagnostic text untouched', () => {
    const message = 'Nacos returned HTTP 403 for /nacos/v1/cs/configs (attempt 2 of 3, retrying in 600ms)';
    expect(redactSensitiveText(message)).toBe(message);
  });
});

describe('toUserMessage', () => {
  it('formats unknown errors without leaking raw objects', () => {
    expect(toUserMessage(new Error('connect failed'))).toBe('connect failed');
    expect(toUserMessage({ message: 'custom failure' })).toBe('custom failure');
    expect(toUserMessage(42)).toBe('Unexpected error');
  });

  it('redacts the message it extracts', () => {
    expect(toUserMessage(new Error('login rejected for password=hunter2'))).toBe(
      'login rejected for password=[REDACTED]'
    );
  });
});
