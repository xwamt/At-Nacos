import * as vscode from 'vscode';
import { createNonce } from '../utils/nonce';

export interface WebviewAsset {
  script: vscode.Uri;
  style?: vscode.Uri;
}

/**
 * Wraps a body in the document every Webview in this extension gets: a strict
 * CSP, a nonce minted here, and the bundle that drives the page.
 *
 * `data` is how translated copy and other extension-side values reach the
 * page. It is a parameter rather than something the caller writes itself
 * because the nonce never leaves this module -- exporting the nonce so a
 * caller could build its own block would put the escaping (and the chance of
 * forgetting it) back in every Webview. Each entry becomes one
 * `<script type="application/json" id="...">` block, emitted ahead of the
 * bundle so it is in the document by the time the bundle looks it up.
 */
export function renderWebviewHtml(
  webview: vscode.Webview,
  asset: WebviewAsset,
  body: string,
  data: Readonly<Record<string, unknown>> = {}
): string {
  const nonce = createNonce();
  const styleTag = asset.style ? `<link rel="stylesheet" href="${webview.asWebviewUri(asset.style)}">` : '';
  const dataTags = Object.entries(data)
    .map(([id, value]) => `\n  ${renderJsonScript(id, value, nonce)}`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${styleTag}
</head>
<body>
  ${body}${dataTags}
  <script nonce="${nonce}" src="${webview.asWebviewUri(asset.script)}"></script>
</body>
</html>`;
}

/**
 * A data block the page reads with `JSON.parse`, and the one place in this
 * extension where a value is serialized into a `<script>` element.
 *
 * Escaping `<` is what keeps the value from ending the block. It covers both
 * ways that happens: `</script` closes the element outright, and `<!--` moves
 * the tokenizer into its escaped state, where the next `</script>` no longer
 * closes anything and the rest of the document is swallowed. Nothing else
 * needs escaping -- the block is raw text, so a quote or an ampersand inside
 * it is just data.
 *
 * Two things this must not become:
 *
 * - The substitution has to run on the serialized text. Applied to the values
 *   first, `JSON.stringify` would escape the backslash again and the page
 *   would parse the literal characters `\u003c/script>` -- unsafe and garbled
 *   at once.
 * - HTML entities do not work here. A `<script>` element is raw text and the
 *   parser decodes no entities inside it, so `&lt;` would reach `JSON.parse`
 *   exactly as written.
 *
 * The CSP is a second line of defence, not a replacement: it stops an injected
 * script from running, but not the DOM from being reshaped or this block's own
 * `JSON.parse` from failing.
 */
export function renderJsonScript(id: string, value: unknown, nonce: string): string {
  // `JSON.stringify` returns undefined for a value with no JSON form, and the
  // bare word `undefined` in the block is a parse error on the page.
  const json = JSON.stringify(value) ?? 'null';
  return `<script type="application/json" id="${escapeAttr(id)}" nonce="${escapeAttr(nonce)}">${json.replaceAll('<', '\\u003c')}</script>`;
}

/**
 * Escapes a value for an HTML double-quoted attribute, which also makes it
 * safe as element text: `<` and `>` are covered too.
 *
 * The ampersand is escaped, and escaped first, for two different reasons.
 * Leaving it alone would let a value that already reads as an entity be
 * decoded by the parser -- the label `&quot;` would reach the page as `"`,
 * which is not what anyone typed. Escaping it last would re-encode the `&` of
 * every escape written above it, and a value containing a real quote would
 * arrive as the literal text `&quot;`. Neither breaks out of the attribute;
 * both corrupt the value.
 */
export function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
