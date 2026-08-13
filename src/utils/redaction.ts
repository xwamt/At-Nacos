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
 *
 * Three shapes are deliberately out of scope, so that nobody widens the
 * patterns to reach them:
 *
 * - Prose. `the password is hunter2` has no separator introducing the value,
 *   and a pattern loose enough to read English would fire on most sentences
 *   containing the word.
 * - Unlabelled high-entropy strings. Recognizing a bare base64 key without a
 *   name in front of it means scoring entropy, which cannot tell a secret from
 *   a namespace id or a config md5 -- both of which appear in nearly every
 *   line this extension logs.
 * - The tail of a query string whose value is not already redacted. See
 *   `NACOS_SECRET_FIELD_PATTERN`; narrowing the value to stop at `&` would
 *   half-redact any password containing one.
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
 * quote -- and only at a real one, since an escaped `\"` inside the string
 * would otherwise end it early and leave the tail in the clear. Its two
 * branches start on disjoint characters, which is what keeps a run of quotes
 * from being ambiguous enough to backtrack over. Stopping at the closing
 * quote is what a plain `\S+` cannot do: minified JSON puts the whole
 * document on one line, and it would swallow every field after the secret.
 * An unquoted value has to keep going
 * to the next space, so that a password containing `&`, `"` or `'` is
 * redacted whole rather than up to its first punctuation mark. The cost of
 * the unquoted branch is that a secret carried as a query parameter takes the
 * rest of the query string with it (`?password=[REDACTED]` rather than
 * `?password=[REDACTED]&username=nacos`); that is the right way to lose the
 * trade, because the alternative leaks.
 *
 * What the unquoted branch must not do is start on a `{`, because an object is
 * not a scalar to redact. `{"credential": {"accessKey": "..."}}` would
 * otherwise have its outer key consume `{"accessKey":`, which strips the inner
 * field of the very name that would have got it redacted. Skipping the outer
 * key leaves each inner key to be judged on its own. A `[` gets no such
 * exemption: an array under a secret name holds secrets, and consuming it
 * whole over-redacts the surrounding punctuation rather than leaving its
 * elements in the clear.
 *
 * The marker leads the alternation so that a value which has already been
 * redacted is matched as itself rather than as an unquoted run. Without that
 * branch the second pass over `?accessToken=[REDACTED]&pageNo=1` would take
 * the query tail along with it, and every log line that survives two passes
 * would lose a little more of itself than the pass before.
 *
 * The whitespace around the separator is horizontal only. A key and its value
 * always share a line, and `\s` would let a YAML key with an empty value
 * (`password:` on its own line) reach across the newline and consume the next
 * key as its value.
 */
const NACOS_SECRET_FIELD_PATTERN =
  /((?:password|passwd|pwd|secret[.\-_]?key|secret|access[.\-_]?key|token|credential|private[.\-_]?key)["']?[ \t]*[=:][ \t]*)(\[REDACTED\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s{]\S*)/gi;

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
