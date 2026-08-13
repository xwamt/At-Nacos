/**
 * The userinfo of an absolute URL: everything between `//` and the last `@`
 * of the authority. Bounded by `[^/?#]` so an `@` further along -- in a path
 * segment, or in a query value -- is not mistaken for the delimiter, and
 * greedy so that `http://a@b@host/` cuts at the last one, which is where the
 * WHATWG URL parser puts the boundary.
 */
const URL_USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

/**
 * Removes any `user:password@` from an address.
 *
 * `http://admin:hunter2@nacos.example.com:8848/nacos` is a perfectly valid URL
 * and a perfectly ordinary thing to paste, and everything downstream treats it
 * as an address rather than as a credential: it is stored, shown in tooltips
 * and quick picks, and echoed back in failure messages. Redaction cannot save
 * it either -- there is no `password=` marker for those patterns to anchor on.
 *
 * Node also turns userinfo into a real `Authorization: Basic` header, which a
 * strategy-supplied `authorization` then silently suppresses, so it half-works
 * by accident and which half depends on the authentication mode. A user who
 * genuinely needs Basic against a proxy in front of Nacos has a designed way
 * to send it, and the gateway-401 message already names it: the "Custom
 * headers" authentication mode.
 *
 * Textual rather than a `URL` round trip, so that an address is otherwise
 * returned exactly as it was written, and so that something too malformed to
 * parse is left alone rather than thrown over.
 */
export function stripUrlCredentials(input: string): string {
  return input.replace(URL_USERINFO_PATTERN, '$1');
}
