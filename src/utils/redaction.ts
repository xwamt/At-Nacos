/**
 * What this extension handles is Nacos *configuration content*: the
 * `application.properties` / YAML / JSON blobs a team keeps in a config
 * center. Those routinely carry database passwords, Redis passwords and cloud
 * access keys, and they flow through error messages, log lines and tool
 * results. So the patterns below are not about the credentials the extension
 * itself holds -- they are about the payloads it moves.
 *
 * Every replacement is idempotent: the marker it writes cannot produce a
 * different result when the pattern that wrote it matches again, which matters
 * because `formatError` redacts once and the logger redacts again on the way
 * to the channel.
 */

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g;

/**
 * `Bearer <token>`, in any casing. Keeps the scheme readable
 * (`Bearer [REDACTED]`) and redacts anything presented as a bearer credential
 * whether or not we recognize its shape.
 */
const BEARER_PATTERN = /(\bbearer\s+)(\S+)/gi;

/**
 * A JWT, which is the shape of every Nacos `accessToken`. Anchored on the
 * `eyJ` that base64url-encoding a JSON header always produces, plus the two
 * dots, so it cannot swallow ordinary identifiers.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * A secret word introducing a value, in either the `key=value` or the
 * `key: value` form.
 *
 * The pattern describes only the secret word itself, never the key path in
 * front of it. Whatever precedes the match is not part of the match and is
 * written back untouched, so `spring.datasource.password`, `db_password` and
 * `MYSQL_ROOT_PASSWORD` are all handled without the pattern having to say
 * anything about how the name was assembled. Describing that path is a trap in
 * both directions: a word boundary in front of the secret word silently skips
 * every underscore-joined name, and a boundary-free prefix scans backwards
 * from every position in the subject -- five seconds on a 100KB configuration
 * that arrives as one unbroken token.
 *
 * Nothing separates the word from the separator, which is the whole guard
 * against over-matching: `token` introduces a value in `"token": "..."` and
 * does not in `"tokenizer": "standard"`.
 *
 * The two-word names tolerate a separator, because `secret.key` is how Nacos
 * itself spells the deployment's JWT signing key
 * (`nacos.core.auth.plugin.nacos.token.secret.key`) and `access_key` is how
 * every cloud SDK spells its credential. The compound alternatives are listed
 * before the bare words they contain; that ordering is not what makes them
 * win -- a bare `secret` that is followed by `.key` fails the separator that
 * comes next and backtracks into the compound form anyway -- but reading them
 * in that order is how anyone would expect the alternation to behave.
 *
 * The optional quote after the name is what admits `type: json` config
 * content, where the key is written `"password":` -- Nacos stores JSON as
 * readily as it stores properties, so both spellings arrive here.
 *
 * The value is an alternation rather than a plain `\S+` because those two
 * shapes want opposite things. A quoted value has to stop at its closing
 * quote: minified JSON puts the whole document on one line, and `\S+` would
 * swallow every field after the secret. An unquoted value has to keep going
 * to the next space, so that a password containing `&`, `"` or `'` is
 * redacted whole rather than up to its first punctuation mark. The cost of
 * the unquoted branch is that a secret carried as a query parameter takes the
 * rest of the query string with it (`?accessToken=[REDACTED]` rather than
 * `?accessToken=[REDACTED]&pageNo=1`); that is the right way to lose the
 * trade, because the alternative leaks.
 *
 * The whitespace around the separator is horizontal only. A key and its value
 * always share a line, and `\s` would let a YAML key with an empty value
 * (`password:` on its own line) reach across the newline and consume the next
 * key as its value.
 */
const NACOS_SECRET_FIELD_PATTERN =
  /((?:password|passwd|pwd|secret[.\-_]?key|secret|access[.\-_]?key|token|credential|private[.\-_]?key)["']?[ \t]*[=:][ \t]*)("[^"]*"|'[^']*'|\S+)/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(JWT_PATTERN, '[REDACTED]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(NACOS_SECRET_FIELD_PATTERN, (_match, name: string, secret: string) => name + redactFieldValue(secret));
}

export function toUserMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? redactSensitiveText(message) : 'Unexpected error';
  }
  return 'Unexpected error';
}

/**
 * Puts the marker back inside whatever quotes the value arrived in, so
 * redacting `{"password": "hunter2"}` leaves a document that still reads as
 * JSON. Keeping the quotes is also what makes the redaction idempotent: a
 * second pass sees `"[REDACTED]"`, matches the same quoted branch, and writes
 * the identical string back.
 */
function redactFieldValue(value: string): string {
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
  return `${quote}[REDACTED]${quote}`;
}
