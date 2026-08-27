/**
 * The shape the instance form keeps in the webview's `setState`: what
 * `payloadFromForm()` returns, verbatim, written on every edit and read back
 * when VS Code rebuilds the page. Split from the page script, which touches
 * `document` the moment it loads, so this half can run under the Node test
 * runner.
 */

export interface SavedInstanceFormState {
  label: string;
  serverUrl: string;
  consoleUrl: string;
  authMode: string;
  username: string;
  password: string;
  customHeaders: string;
  readOnly: boolean;
  allowBackgroundAccess: boolean;
}

const STRING_FIELDS = [
  'label',
  'serverUrl',
  'consoleUrl',
  'authMode',
  'username',
  'password',
  'customHeaders'
] as const;

const BOOLEAN_FIELDS = ['readOnly', 'allowBackgroundAccess'] as const;

/**
 * Narrows what `getState()` returned to a state this page wrote.
 *
 * All or nothing, for the same reason the extension host parses the submit
 * payload that way: the writer and the reader ship in one bundle and cannot
 * disagree about the shape, so a partial object is not an older version -- it
 * is a state nobody in this extension wrote, and restoring half a form from
 * it helps no one. `undefined` is the ordinary first-open answer, and the
 * caller leaves the values the extension rendered into the HTML alone.
 */
export function readSavedInstanceFormState(value: unknown): SavedInstanceFormState | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const wellFormed =
    STRING_FIELDS.every((key) => typeof record[key] === 'string') &&
    BOOLEAN_FIELDS.every((key) => typeof record[key] === 'boolean');
  return wellFormed ? (value as SavedInstanceFormState) : undefined;
}
