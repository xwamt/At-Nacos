import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

/**
 * Every `t('...')` in the extension source.
 *
 * The lookbehind is what keeps `format(`, `assert(` and `.at(` out; the `s`
 * flag is what finds the call that was wrapped across lines because its
 * source string is a paragraph. Only single-quoted literals are matched,
 * which is the whole of what this codebase writes -- a template literal
 * cannot be a translation key anyway, since the bundle is keyed by the source
 * text itself.
 */
const T_CALL = /(?<![\w.])t\(\s*'((?:[^'\\]|\\.)*)'/gs;

function sourceFilesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFilesIn(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function translationKeysIn(source: string): string[] {
  return [...source.matchAll(T_CALL)].map((match) => unescapeLiteral(match[1]));
}

/**
 * A single-quoted TypeScript literal as the string it denotes -- `\n` really
 * is a newline in the bundle's key, and several of these span paragraphs.
 *
 * Read as JSON rather than by substituting escape by escape, so that every
 * sequence TypeScript understands is handled the same way TypeScript handles
 * it. Two adjustments make the literal valid JSON: `\'` is legal in
 * TypeScript and not in JSON, and a bare `"` is legal in a single-quoted
 * literal and has to be escaped once it is inside double quotes.
 */
function unescapeLiteral(raw: string): string {
  return JSON.parse(`"${raw.replaceAll("\\'", "'").replace(/(?<!\\)"/g, '\\"')}"`) as string;
}

describe('every string the extension translates at runtime', () => {
  const sources = sourceFilesIn(resolve(process.cwd(), 'src'));
  const keys = new Map<string, string>();
  for (const path of sources) {
    for (const key of translationKeysIn(readFileSync(path, 'utf8'))) {
      keys.set(key, path);
    }
  }

  /**
   * Each module has a localization test of its own, and each of those can
   * only see the strings its own code reaches. `src/extension.ts` had none at
   * all until M4 -- its command failure messages went through `t()` and
   * nothing checked they were in the bundle, so a zh-cn user would have read
   * them in English and no test would have noticed.
   */
  it('reads a plausible number of them out of the source', () => {
    expect(keys.size).toBeGreaterThan(50);
  });

  it('has a zh-cn translation for every one', () => {
    for (const [key, path] of keys) {
      expect(Object.keys(bundle), `${path}: ${JSON.stringify(key)}`).toContain(key);
    }
  });

  /**
   * The other direction -- a bundle entry nothing asks for any more -- is
   * deliberately *not* checked here, and cannot be from the source text
   * alone: several strings reach `t()` without ever appearing next to it.
   * `buildWebviewStrings` is handed an object of them, and the instance
   * form's auth-mode labels live in a lookup table. A scan that had to be
   * taught each of those indirections would be a test maintained against the
   * shape of the code rather than against its behaviour.
   */
});

/**
 * Every string the manifest holds, at any depth. The placeholders live in
 * values only, so the keys are not walked.
 */
function stringValuesOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringValuesOf);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(stringValuesOf);
  }
  return [];
}

/** What the extension host substitutes: a value that is *entirely* one placeholder. */
const WHOLE_PLACEHOLDER = /^%([\w.-]+)%$/;
const ANY_PLACEHOLDER = /%[\w.-]+%/;

const manifestStrings = stringValuesOf(readJson<unknown>('package.json'));
const manifestPlaceholders = manifestStrings
  .map((value) => WHOLE_PLACEHOLDER.exec(value)?.[1])
  .filter((key): key is string => key !== undefined);

describe('package.json', () => {
  it('points at the l10n directory that holds the bundle', () => {
    // Without this field VS Code never loads the bundle, and every call to
    // `t()` quietly returns its English source even under a zh-cn UI.
    const manifest = readJson<{ l10n?: string }>('package.json');
    expect(manifest.l10n).toBe('./l10n');
  });

  it('uses placeholders for the strings the UI shows', () => {
    // A guard on the guard below: if the manifest stopped using placeholders
    // altogether, every assertion here would pass over an empty list.
    expect(manifestPlaceholders.length).toBeGreaterThanOrEqual(8);
  });

  it('resolves every %placeholder% it writes in both languages', () => {
    // An unresolved key does not fail anything -- VS Code renders the literal
    // `%atNacos.foo%` in the view title, the command palette, or the welcome
    // view, and only in the language that is missing it.
    for (const key of manifestPlaceholders) {
      expect(Object.keys(english), key).toContain(key);
      expect(Object.keys(chinese), key).toContain(key);
    }
  });

  it('never embeds a placeholder inside a longer string', () => {
    // The host substitutes a value only when the placeholder is the whole
    // thing, so `"AT Nacos: %atNacos.foo%"` ships exactly as written.
    for (const value of manifestStrings) {
      if (ANY_PLACEHOLDER.test(value)) {
        expect(value, value).toMatch(WHOLE_PLACEHOLDER);
      }
    }
  });

  it('leaves no nls key unused', () => {
    // These files are only ever read through the manifest. A key nothing
    // points at is a translation being maintained for nothing -- or, more
    // often, a placeholder that was renamed on one side.
    for (const key of Object.keys(english)) {
      expect(manifestPlaceholders, key).toContain(key);
    }
  });
});
