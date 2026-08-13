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

  it('redacts a quoted value and leaves the quotes where it found them', () => {
    expect(redactSensitiveText('{"spring.datasource.password": "hunter2"}')).toBe(
      '{"spring.datasource.password": "[REDACTED]"}'
    );
    expect(redactSensitiveText('{"password":"hunter2"}')).toBe('{"password":"[REDACTED]"}');
    expect(redactSensitiveText("password: 'hunter2'")).toBe("password: '[REDACTED]'");
  });

  it('stops a quoted value at its closing quote instead of eating the rest of the object', () => {
    expect(redactSensitiveText('{"password":"hunter2","serverAddr":"127.0.0.1:8848"}')).toBe(
      '{"password":"[REDACTED]","serverAddr":"127.0.0.1:8848"}'
    );
  });

  it('does not let an escaped quote end a string early and leak the rest', () => {
    const once = redactSensitiveText('{"password":"hun\\"ter"}');

    expect(once).toBe('{"password":"[REDACTED]"}');
    expect(redactSensitiveText(once)).toBe(once);
    expect(redactSensitiveText("password: 'hun\\'ter'")).toBe("password: '[REDACTED]'");
  });

  it('leaves an object-valued secret key to the inner keys, which can be judged on their own', () => {
    expect(redactSensitiveText('{"credential": {"accessKey": "LTAI5tSomeAliyunKey"}}')).toBe(
      '{"credential": {"accessKey": "[REDACTED]"}}'
    );
  });

  it('consumes an array-valued secret key whole rather than leaving its elements bare', () => {
    // An array under a secret name holds secrets. Skipping it the way the
    // object case is skipped would leave every element in the clear, because
    // elements carry no names of their own for a second pass to judge. Eating
    // the surrounding punctuation is the safe way to lose this trade.
    expect(redactSensitiveText('{"secret": ["a","b"]}')).toBe('{"secret": [REDACTED]');
    // A plural name is not in the word list, so this one is untouched for a
    // different reason: the secret word has to end where the separator begins.
    expect(redactSensitiveText('{"secrets": ["a","b"]}')).toBe('{"secrets": ["a","b"]}');
  });

  it('redacts an unquoted value that merely contains a brace', () => {
    expect(redactSensitiveText('password=P@ss{word}')).toBe('password=[REDACTED]');
  });

  it('redacts a scalar that happens to open with a bracket', () => {
    // The structural guard covers `{` only. Exempting `[` as well would read
    // this password as a structure and leave it in the clear.
    expect(redactSensitiveText('password=[br@cketed]')).toBe('password=[REDACTED]');
    expect(redactSensitiveText('password: [br@cketed]')).toBe('password: [REDACTED]');
  });

  it('is idempotent on the JSON form, whose marker now carries quotes of its own', () => {
    const once = redactSensitiveText('{"password": "hunter2"}');
    expect(once).toBe('{"password": "[REDACTED]"}');
    expect(redactSensitiveText(once)).toBe(once);
  });

  it('redacts an access key in any casing and however its two words are joined', () => {
    expect(redactSensitiveText('accessKey=LTAI5tSomeAliyunKey')).toBe('accessKey=[REDACTED]');
    expect(redactSensitiveText('nacos.remote.accesskey=abc123')).toBe('nacos.remote.accesskey=[REDACTED]');
    expect(redactSensitiveText('access-key=AKIAIOSFODNN7EXAMPLE')).toBe('access-key=[REDACTED]');
    expect(redactSensitiveText('access_key=AKIAIOSFODNN7EXAMPLE')).toBe('access_key=[REDACTED]');
  });

  it('redacts the dotted signing key that authenticates the whole deployment', () => {
    expect(redactSensitiveText('nacos.core.auth.plugin.nacos.token.secret.key=SecretKey0123')).toBe(
      'nacos.core.auth.plugin.nacos.token.secret.key=[REDACTED]'
    );
    expect(redactSensitiveText('nacos.core.auth.server.identity.secret-key=s3cr3t')).toBe(
      'nacos.core.auth.server.identity.secret-key=[REDACTED]'
    );
  });

  it('still matches the standalone secret and token words the compound forms are built from', () => {
    // A compound alternative that wins too early would truncate these back to
    // an unredacted tail, so they are asserted alongside the compound forms.
    expect(redactSensitiveText('secret=s3cr3t')).toBe('secret=[REDACTED]');
    expect(redactSensitiveText('token=abc123')).toBe('token=[REDACTED]');
  });

  it('redacts a key whose secret word is joined by an underscore', () => {
    // The shape every connection string and container env var uses, and the
    // one the previous `password=` pattern covered -- a word boundary before
    // `password` would silently stop matching all of them.
    expect(redactSensitiveText('db_password=hunter2')).toBe('db_password=[REDACTED]');
    expect(redactSensitiveText('MYSQL_ROOT_PASSWORD=hunter2')).toBe('MYSQL_ROOT_PASSWORD=[REDACTED]');
  });

  it('redacts an accessToken carried in a request URL', () => {
    const redacted = redactSensitiveText(
      'GET /nacos/v1/cs/configs?accessToken=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuYWNvcyJ9.Sf1kx&pageNo=1 -> 403'
    );
    expect(redacted).not.toContain('eyJzdWIiOiJuYWNvcyJ9');
    expect(redacted).toBe('GET /nacos/v1/cs/configs?accessToken=[REDACTED]&pageNo=1 -> 403');
  });

  it('takes the query tail with it when the value itself is what gets matched', () => {
    // The standing cost of an unquoted value running to the next space. The
    // URL above escapes it only because the JWT is replaced first, and the
    // marker that leaves behind is matched by a branch of its own.
    expect(redactSensitiveText('POST /nacos/v1/auth/login?password=hunter2&username=nacos')).toBe(
      'POST /nacos/v1/auth/login?password=[REDACTED]'
    );
  });

  it('stops eroding a line once the value is already the marker', () => {
    // formatError redacts, then the logger redacts again on the way to the
    // channel. Without a branch for the marker each pass would eat a little
    // more of what follows it, so the same line would read differently
    // depending on how many times it had been through.
    const once = redactSensitiveText('GET /configs?accessToken=eyJhbGciOi.eyJzdWIi.Sf1kx&pageNo=1');

    expect(once).toBe('GET /configs?accessToken=[REDACTED]&pageNo=1');
    expect(redactSensitiveText(once)).toBe(once);
    expect(redactSensitiveText(redactSensitiveText(once))).toBe(once);
  });

  it('leaves configuration keys that only look sensitive alone', () => {
    const benign = [
      'spring.application.name=my-app',
      'server.port=8848',
      'nacos.core.auth.plugin.nacos.token.expire.seconds=18000',
      // `token` is a prefix of `tokenizer`, so this only survives because the
      // secret word has to end where the separator begins.
      '{"tokenizer": "standard"}'
    ];
    for (const line of benign) {
      expect(redactSensitiveText(line)).toBe(line);
    }
  });

  it('does not let an empty value swallow the next line of a YAML block', () => {
    const yaml = ['spring:', '  datasource:', '    password:', '    username: nacos'].join('\n');

    const redacted = redactSensitiveText(yaml);

    expect(redacted).toContain('username: nacos');
    expect(redacted).toBe(yaml);
  });

  it('leaves ordinary diagnostic text untouched', () => {
    const message = 'Nacos returned HTTP 403 for /nacos/v1/cs/configs (attempt 2 of 3, retrying in 600ms)';
    expect(redactSensitiveText(message)).toBe(message);
  });

  it('stays cheap on one unbroken token the length of a whole configuration', () => {
    // Nacos caps config content at 100KB, and base64url content (`-` and `_`
    // are word-ish) can arrive as a single run with nothing to break it up.
    // A prefix that scans backwards from every position turns that into
    // seconds of blocking on the extension host.
    const unbroken = 'aB3_-x.'.repeat(15000).slice(0, 100000);

    const started = performance.now();
    const redacted = redactSensitiveText(unbroken);
    const elapsedMs = performance.now() - started;

    expect(redacted).toBe(unbroken);
    expect(elapsedMs).toBeLessThan(250);
  });

  it('handles every shape at once and stays idempotent over the whole chain', () => {
    const blob = [
      'GET /nacos/v1/cs/configs?accessToken=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuYWNvcyJ9.Sf1kx',
      'spring.datasource.password=hunter2',
      '{"spring.redis.password": "r3disPass"}',
      'nacos.core.auth.plugin.nacos.token.secret.key=SecretKey0123456789'
    ].join('\n');

    const once = redactSensitiveText(blob);

    expect(once).toBe(
      [
        'GET /nacos/v1/cs/configs?accessToken=[REDACTED]',
        'spring.datasource.password=[REDACTED]',
        '{"spring.redis.password": "[REDACTED]"}',
        'nacos.core.auth.plugin.nacos.token.secret.key=[REDACTED]'
      ].join('\n')
    );
    expect(redactSensitiveText(once)).toBe(once);
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
