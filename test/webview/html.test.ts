import { describe, expect, it } from 'vitest';
import { Uri } from '../../test-fixtures/vscode';
import { escapeAttr, renderJsonScript, renderWebviewHtml } from '../../src/webview/html';

/** Enough of `vscode.Webview` for the renderer; the fixture's `Uri` stringifies to `file:/path`. */
const webview = {
  cspSource: 'vscode-webview:',
  asWebviewUri: (uri: Uri) => uri
} as unknown as Parameters<typeof renderWebviewHtml>[0];

const asset = { script: Uri.file('/ext/dist/webview/form.js') } as unknown as Parameters<typeof renderWebviewHtml>[1];
const styledAsset = {
  script: Uri.file('/ext/dist/webview/form.js'),
  style: Uri.file('/ext/webview/form/index.css')
} as unknown as Parameters<typeof renderWebviewHtml>[1];

function nonceOf(html: string): string {
  const match = /<script nonce="([^"]+)"/.exec(html);
  if (!match) {
    throw new Error(`No nonced script tag in:\n${html}`);
  }
  return match[1];
}

describe('renderWebviewHtml', () => {
  it('locks the document down to the bundle it just emitted', () => {
    const html = renderWebviewHtml(webview, asset, '<main></main>');
    const nonce = nonceOf(html);

    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src vscode-webview: 'nonce-${nonce}'`);
    expect(html).toContain(`<script nonce="${nonce}" src="file:/ext/dist/webview/form.js"></script>`);
  });

  it('mints a fresh nonce per render', () => {
    // A nonce reused across renders is a nonce an attacker can learn from one
    // page and spend on the next, which is the whole reason it is random.
    expect(nonceOf(renderWebviewHtml(webview, asset, ''))).not.toBe(nonceOf(renderWebviewHtml(webview, asset, '')));
  });

  it('links the stylesheet only when one is supplied', () => {
    expect(renderWebviewHtml(webview, styledAsset, '')).toContain(
      '<link rel="stylesheet" href="file:/ext/webview/form/index.css">'
    );
    expect(renderWebviewHtml(webview, asset, '')).not.toContain('<link rel="stylesheet"');
  });

  it('places every data block ahead of the bundle that reads it', () => {
    // The bundle runs the moment it loads and looks its data up by id, so a
    // block emitted after it would not be in the document yet.
    const html = renderWebviewHtml(webview, asset, '<main></main>', { atNacosStrings: { save: 'Save' } });

    expect(html.indexOf('id="atNacosStrings"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="atNacosStrings"')).toBeLessThan(html.indexOf('src="file:/ext/dist/webview/form.js"'));
  });

  it('gives the data block the same nonce as the bundle', () => {
    const html = renderWebviewHtml(webview, asset, '', { atNacosStrings: { save: 'Save' } });

    expect(html).toContain(`<script type="application/json" id="atNacosStrings" nonce="${nonceOf(html)}">`);
  });

  it('emits no data block when there is no data', () => {
    expect(renderWebviewHtml(webview, asset, '')).not.toContain('application/json');
  });
});

describe('renderJsonScript', () => {
  it('round-trips the value through the JSON the page will parse', () => {
    const html = renderJsonScript('atNacosStrings', { save: 'Save', cancel: 'Cancel' }, 'n0nce');

    expect(JSON.parse(bodyOf(html))).toEqual({ save: 'Save', cancel: 'Cancel' });
  });

  it('escapes "<" so a value cannot close the block early', () => {
    // The concrete case: an instance label is user input and reaches copy
    // through `t('Edit Nacos Instance: {label}', { label })`. `</script>` here
    // would end the data block and let the rest of the value be parsed as
    // markup -- CSP would refuse to run an injected script, but the DOM would
    // already be wrong and `JSON.parse` would already have failed.
    const hostile = '</script><img src=x onerror=alert(1)>';
    const html = renderJsonScript('atNacosStrings', { title: hostile }, 'n0nce');

    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script>');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(bodyOf(html))).toEqual({ title: hostile });
  });

  it('escapes the "<" of a comment opener, which would otherwise change how the block is tokenized', () => {
    // `<!--` inside a script element puts the tokenizer into its escaped state,
    // where the next `</script>` stops closing the element.
    const html = renderJsonScript('atNacosStrings', { note: '<!-- hi' }, 'n0nce');

    expect(html).not.toContain('<!--');
    expect(JSON.parse(bodyOf(html))).toEqual({ note: '<!-- hi' });
  });

  it('escapes after serializing, so the page reads the copy rather than the escape', () => {
    // Substituting on the dictionary values instead would be serialized a
    // second time by JSON.stringify, and the page would parse the literal text
    // `\u003c` -- unsafe and garbled at once.
    expect(JSON.parse(bodyOf(renderJsonScript('x', { note: 'a < b' }, 'n')))).toEqual({ note: 'a < b' });
  });

  it('escapes the id it is given rather than trusting it in an attribute', () => {
    const html = renderJsonScript('a"><script>alert(1)</script', {}, 'n0nce');

    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('emits valid JSON for a value that has no JSON form', () => {
    // `JSON.stringify(undefined)` is `undefined`, and interpolating that would
    // put the bare word `undefined` in the block for `JSON.parse` to reject.
    expect(bodyOf(renderJsonScript('x', undefined, 'n'))).toBe('null');
  });
});

describe('escapeAttr', () => {
  it('escapes every character that can end an attribute or open a tag', () => {
    expect(escapeAttr(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;');
  });

  it('escapes the ampersand, and before everything it writes one into', () => {
    // A value that already reads as an entity has to survive as text: written
    // back unchanged, the parser would decode `&quot;` into a quote the user
    // never typed. Doing it last instead would escape the escapes above it and
    // turn a real quote into the visible text `&quot;`.
    expect(escapeAttr('&quot;')).toBe('&amp;quot;');
    expect(escapeAttr('a & "b"')).toBe('a &amp; &quot;b&quot;');
  });

  it('leaves ordinary copy alone', () => {
    expect(escapeAttr('http://nacos.example.com/nacos')).toBe('http://nacos.example.com/nacos');
  });
});

/** The text between the block's tags, which is what the page hands to `JSON.parse`. */
function bodyOf(scriptTag: string): string {
  const match = /<script[^>]*>([\s\S]*)<\/script>/.exec(scriptTag);
  if (!match) {
    throw new Error(`Not a script tag: ${scriptTag}`);
  }
  return match[1];
}
