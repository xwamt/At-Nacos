export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keeps only the string-valued entries of an object.
 *
 * Nacos's server-state endpoints answer with a map whose values are all
 * strings, including the ones that read as booleans and numbers
 * (`auth_enabled: "false"`, `server_port: "8848"`). The set of keys differs
 * between versions and grows without notice -- 2.5 alone added a dozen Raft
 * and Distro parameters -- so callers treat the map as an open bag of strings
 * rather than validating it against a shape.
 */
export function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}
