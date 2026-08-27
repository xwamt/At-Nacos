import { describe, expect, it } from 'vitest';
import { configLanguageId, configTypeForDataId } from '../../../src/nacos/driver/configLanguage';

describe('configLanguageId from the type Nacos stored', () => {
  it.each([
    ['yaml', 'yaml'],
    ['yml', 'yaml'],
    ['properties', 'properties'],
    ['json', 'json'],
    ['xml', 'xml'],
    ['html', 'html'],
    ['text', 'plaintext']
  ])('maps the %s type to %s', (type, expected) => {
    expect(configLanguageId({ dataId: 'application', type })).toBe(expected);
  });

  /**
   * The type is what the publisher chose and what the Nacos console and the
   * Spring Cloud Alibaba client both dispatch on. A dataId suffix is an
   * unenforced naming habit, and it is only consulted here because blur
   * search drops the type -- it answers absence, it does not outrank a
   * present answer.
   */
  it('lets the type win over a suffix that disagrees with it', () => {
    expect(configLanguageId({ dataId: 'application-uat.yml', type: 'json' })).toBe('json');
  });

  it('falls back to the suffix for a type no version of Nacos defines', () => {
    expect(configLanguageId({ dataId: 'application-uat.yml', type: 'toml' })).toBe('yaml');
  });

  it('reads a type the server upper-cased', () => {
    expect(configLanguageId({ dataId: 'application', type: 'YAML' })).toBe('yaml');
  });

  /**
   * Nacos stores several of these columns as fixed-width `char` and hands
   * them back padded -- `opType` arrives as `"I "` on every version. Trimming
   * costs nothing and a padded type would otherwise silently become
   * plaintext.
   */
  it('reads a type the server padded with whitespace', () => {
    expect(configLanguageId({ dataId: 'application', type: ' yaml ' })).toBe('yaml');
  });

  it('falls back to the suffix for an empty type', () => {
    expect(configLanguageId({ dataId: 'application.json', type: '' })).toBe('json');
  });
});

/**
 * Verified on a real Nacos 2.3.2: `type` is populated under `search=accurate`
 * and null under `search=blur`. The filter UI uses blur, so the moment a user
 * searches, the suffix is the only thing left to decide syntax highlighting.
 * This is a required path, not a safety net.
 */
describe('configLanguageId when a blur search left the type null', () => {
  it.each([
    ['application.yml', 'yaml'],
    ['application.yaml', 'yaml'],
    ['jdbc.properties', 'properties'],
    ['routes.json', 'json'],
    ['logback.xml', 'xml'],
    ['notes.txt', 'plaintext'],
    ['nginx.conf', 'properties'],
    ['index.html', 'html']
  ])('infers %s as %s', (dataId, expected) => {
    expect(configLanguageId({ dataId, type: null })).toBe(expected);
  });

  it('reads only the last suffix of a dataId that carries several dots', () => {
    expect(configLanguageId({ dataId: 'application-uat.yml', type: null })).toBe('yaml');
    expect(configLanguageId({ dataId: 'com.example.service.config.yaml', type: null })).toBe('yaml');
  });

  it('gives up on a dataId whose last segment is not a suffix it knows', () => {
    expect(configLanguageId({ dataId: 'a.b.c', type: null })).toBe('plaintext');
  });

  it('gives up on a dataId with no dot at all', () => {
    expect(configLanguageId({ dataId: 'application', type: null })).toBe('plaintext');
  });

  it.each([
    ['APPLICATION.YML', 'yaml'],
    ['Routes.Json', 'json'],
    ['LOGBACK.XML', 'xml']
  ])('matches the suffix of %s case-insensitively', (dataId, expected) => {
    expect(configLanguageId({ dataId, type: null })).toBe(expected);
  });

  it('gives up on a dataId that ends in a dot', () => {
    expect(configLanguageId({ dataId: 'application.', type: null })).toBe('plaintext');
  });

  it('gives up on an empty dataId rather than throwing', () => {
    expect(configLanguageId({ dataId: '', type: null })).toBe('plaintext');
  });

  /** The normalizer turns the server's null into undefined, so both spellings arrive here. */
  it('treats an absent type the same as a null one', () => {
    expect(configLanguageId({ dataId: 'application.yml' })).toBe('yaml');
    expect(configLanguageId({ dataId: 'application' })).toBe('plaintext');
  });
});

/**
 * The inverse direction, for a draft created before the config exists: the
 * Nacos `type` its first publish should carry. Every answer must agree with
 * what `configLanguageId` highlights the same dataId as, or the config would
 * render one way in this editor and another in the Nacos console.
 */
describe('configTypeForDataId for a configuration that does not exist yet', () => {
  it.each([
    ['application.yml', 'yaml'],
    ['application.yaml', 'yaml'],
    ['jdbc.properties', 'properties'],
    ['nginx.conf', 'properties'],
    ['app.cfg', 'properties'],
    ['routes.json', 'json'],
    ['logback.xml', 'xml'],
    ['index.html', 'html'],
    ['index.htm', 'html']
  ])('infers %s as %s', (dataId, expected) => {
    expect(configTypeForDataId(dataId)).toBe(expected);
  });

  /** Nacos spells "no format" as `text`, not as VS Code's `plaintext`. */
  it.each([['notes.txt'], ['application'], ['a.b.c'], ['']])('answers text for %s', (dataId) => {
    expect(configTypeForDataId(dataId)).toBe('text');
  });

  it('matches the suffix case-insensitively, as the language lookup does', () => {
    expect(configTypeForDataId('APPLICATION.YML')).toBe('yaml');
  });
});
