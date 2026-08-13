/**
 * The `type` values Nacos itself defines. `text` is its name for "no format";
 * VS Code calls the same thing `plaintext`.
 */
const LANGUAGE_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['properties', 'properties'],
  ['json', 'json'],
  ['xml', 'xml'],
  ['html', 'html'],
  ['text', 'plaintext']
]);

/**
 * dataId suffixes. `.conf` and `.cfg` resolve to `properties` because that is
 * what VS Code's own built-in language definition already claims them for, so
 * a config opened from this tree gets the same highlighting as the same file
 * opened from disk.
 */
const LANGUAGE_BY_SUFFIX: ReadonlyMap<string, string> = new Map([
  ['yml', 'yaml'],
  ['yaml', 'yaml'],
  ['properties', 'properties'],
  ['conf', 'properties'],
  ['cfg', 'properties'],
  ['json', 'json'],
  ['xml', 'xml'],
  ['html', 'html'],
  ['htm', 'html'],
  ['txt', 'plaintext']
]);

const PLAIN_TEXT = 'plaintext';

/**
 * The VS Code language mode to open a config's virtual document in.
 *
 * The suffix fallback is a required path rather than a safety net. Verified
 * on a real Nacos 2.3.2: `type` is populated under `search=accurate` and null
 * under `search=blur`, and the filter UI searches with blur -- so the moment
 * a user filters the tree, the field that decides syntax highlighting is gone
 * and the dataId is all that is left.
 *
 * `type` wins where the two disagree. It is what the publisher chose, what
 * the Nacos console renders by and what the Spring Cloud Alibaba client
 * parses by, while a dataId suffix is an unenforced naming habit that nothing
 * on the server validates. The suffix answers the type's absence; it does not
 * overrule its presence. An unrecognized type is absence, not disagreement,
 * so it falls back too.
 *
 * Takes `type` as `string | null` rather than the normalized `string |
 * undefined`, so that a raw server entry can be passed straight in.
 */
export function configLanguageId(config: { dataId: string; type?: string | null }): string {
  return LANGUAGE_BY_TYPE.get(lookupKey(config.type)) ?? LANGUAGE_BY_SUFFIX.get(suffixOf(config.dataId)) ?? PLAIN_TEXT;
}

/**
 * Lower-cased and trimmed: Nacos stores several of these columns as
 * fixed-width `char` and hands them back padded -- `opType` arrives as `"I "`
 * on every version -- and a padded or upper-cased type would otherwise fall
 * all the way through to plaintext.
 */
function lookupKey(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Only the last segment: a dataId like `com.example.service.yaml` is dotted by convention. */
function suffixOf(dataId: string): string {
  const lastDot = dataId.lastIndexOf('.');
  return lastDot === -1 ? '' : lookupKey(dataId.slice(lastDot + 1));
}
