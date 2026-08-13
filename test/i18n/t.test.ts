import { describe, expect, it } from 'vitest';
import { buildWebviewStrings, t } from '../../src/i18n/t';

describe('t', () => {
  it('passes the message through with named placeholders substituted', () => {
    expect(t('Delete instance "{label}"?', { label: 'prod' })).toBe('Delete instance "prod"?');
  });

  it('returns a message that has no placeholders unchanged', () => {
    expect(t('Test Connection')).toBe('Test Connection');
    expect(t('Test Connection', { unused: 'ignored' })).toBe('Test Connection');
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    expect(t('{label} -> {label}', { label: 'prod' })).toBe('prod -> prod');
  });

  it('substitutes falsy numbers and booleans instead of dropping to the placeholder', () => {
    // The host resolves values with `??`, so `0` and `false` are real values.
    // A fixture written with `||` would pass every other test in this file and
    // fail only on the two values a paging or flag message actually carries.
    expect(t('{count} shown, truncated: {truncated}', { count: 0, truncated: false })).toBe(
      '0 shown, truncated: false'
    );
  });

  it('leaves a placeholder with no matching argument literal', () => {
    // A missing key resolves to the placeholder text itself, so a caller that
    // forgot an argument ships `{mode}` to the UI. Asserting "undefined" here
    // would bless the wrong behaviour and hide the bug behind a passing test.
    expect(t('Connected to Nacos {version} ({mode}).', { version: '3.0.1' })).toBe(
      'Connected to Nacos 3.0.1 ({mode}).'
    );
  });
});

describe('buildWebviewStrings', () => {
  it('resolves every requested key into a plain dictionary', () => {
    const strings = buildWebviewStrings({
      save: 'Save',
      cancel: 'Cancel'
    });
    expect(strings).toEqual({ save: 'Save', cancel: 'Cancel' });
  });

  it('produces a JSON-embeddable dictionary with no prototype pollution vector', () => {
    const strings = buildWebviewStrings({ save: 'Save' });
    expect(Object.getPrototypeOf(strings)).toBeNull();
  });

  it('returns an empty dictionary for an empty source', () => {
    const strings = buildWebviewStrings({});
    expect(Object.keys(strings)).toEqual([]);
    expect(JSON.stringify(strings)).toBe('{}');
  });

  it('serializes to the JSON the page will actually be handed', () => {
    // `toEqual` ignores the prototype, so it passes whether or not the result
    // survives serialization. JSON.stringify is the step that matters, since
    // the dictionary reaches the Webview as JSON text and nothing else.
    expect(JSON.stringify(buildWebviewStrings({ save: 'Save', cancel: 'Cancel' }))).toBe(
      '{"save":"Save","cancel":"Cancel"}'
    );
  });

  it('carries a "__proto__" key as data instead of losing it to the inherited setter', () => {
    // This is what the null prototype buys. On an ordinary object the
    // assignment would run `Object.prototype.__proto__`'s setter, which
    // ignores string values, so the entry would disappear without an error.
    const strings = buildWebviewStrings({ ['__proto__']: 'Save' });

    expect(strings['__proto__']).toBe('Save');
    expect(JSON.stringify(strings)).toBe('{"__proto__":"Save"}');
  });

  it('leaves placeholders unresolved for the page to fill in', () => {
    // Translating and formatting are separate steps here: only the Webview
    // holds the runtime values, so `{label}` has to survive the trip intact.
    expect(buildWebviewStrings({ title: 'Edit Nacos Instance: {label}' })).toEqual({
      title: 'Edit Nacos Instance: {label}'
    });
  });

  it('passes values through unescaped, leaving escaping to whoever embeds them', () => {
    // Deliberate: a `</script>` in a translation would close the
    // `<script type="application/json">` block that carries this dictionary,
    // but the fix belongs to the code that writes the HTML. Only that layer
    // knows the target context, and the correct escape there is `<` as
    // `\u003c` in the serialized JSON. Doing it here would be wrong twice --
    // HTML entities are not decoded inside a raw-text script element, so
    // `&lt;` would reach JSON.parse verbatim, and every non-HTML consumer
    // would receive corrupted copy.
    expect(buildWebviewStrings({ danger: '</script><img src=x onerror=alert(1)>' })).toEqual({
      danger: '</script><img src=x onerror=alert(1)>'
    });
  });
});
