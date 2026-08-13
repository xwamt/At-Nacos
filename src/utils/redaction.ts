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
 * A configuration key whose name ends in a secret word, in either the
 * `key=value` or the `key: value` form. The leading `[.\w-]*` deliberately
 * carries no word boundary: the keys that hold secrets are spelled
 * `spring.datasource.password`, `db_password` and `MYSQL_ROOT_PASSWORD`, and a
 * `\b` would match the first while silently skipping the other two.
 *
 * The value is `\S+` rather than something that stops at `&`, so a secret
 * containing an ampersand is redacted whole. The cost is that a secret carried
 * as a query parameter takes the rest of the query string with it
 * (`?accessToken=[REDACTED]` rather than `?accessToken=[REDACTED]&pageNo=1`);
 * that is the right way to lose the trade, because the alternative leaks.
 */
const NACOS_SECRET_FIELD_PATTERN =
  /([.\w-]*(?:password|passwd|pwd|secret|secretkey|accesskey|token|credential|privatekey)\s*[=:]\s*)(\S+)/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(JWT_PATTERN, '[REDACTED]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(NACOS_SECRET_FIELD_PATTERN, '$1[REDACTED]');
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
