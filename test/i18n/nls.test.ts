import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Read from disk rather than importing, so the assertions are about the files
 * that actually ship. Anchored on `process.cwd()` the way `vitest.config.ts`
 * anchors its `vscode` alias -- `import.meta.url` would be the sturdier
 * anchor, but these sources compile as CommonJS, where it is not allowed.
 */
function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf8')) as T;
}

/** The pattern the extension host substitutes on, so the test sees what it sees. */
function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/{([^}]+)}/g)].map((match) => match[1]).sort();
}

const english = readJson<Record<string, string>>('package.nls.json');
const chinese = readJson<Record<string, string>>('package.nls.zh-cn.json');
const bundle = readJson<Record<string, string>>('l10n/bundle.l10n.zh-cn.json');

describe('package.nls files', () => {
  it('declares exactly the same keys in both languages', () => {
    // A key in one file and not the other fails silently: VS Code renders the
    // raw `%atNacos.whatever%` placeholder in the language that is missing it,
    // and only in that language, so it survives any English-only check.
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
  });

  it('leaves no entry blank in either language', () => {
    for (const [key, value] of [...Object.entries(english), ...Object.entries(chinese)]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('namespaces every key under atNacos', () => {
    // These files are meant to be copied into the sibling AT Series plugins.
    // A key left behind under another plugin's prefix resolves to nothing.
    for (const key of Object.keys(english)) {
      expect(key.startsWith('atNacos.'), key).toBe(true);
    }
  });
});

describe('l10n runtime bundle', () => {
  it('keeps every placeholder of the English source in its translation', () => {
    // Keys here are the English source strings. A translation that drops
    // `{label}` loses that value at runtime with no warning, because
    // substitution only fills placeholders that are still in the string.
    for (const [source, translation] of Object.entries(bundle)) {
      expect(placeholdersOf(translation), source).toEqual(placeholdersOf(source));
    }
  });

  it('translates every entry into something other than an empty string', () => {
    for (const [source, translation] of Object.entries(bundle)) {
      expect(translation.trim(), source).not.toBe('');
    }
  });
});

describe('package.json', () => {
  it('points at the l10n directory that holds the bundle', () => {
    // Without this field VS Code never loads the bundle, and every call to
    // `t()` quietly returns its English source even under a zh-cn UI.
    const manifest = readJson<{ l10n?: string }>('package.json');
    expect(manifest.l10n).toBe('./l10n');
  });
});
