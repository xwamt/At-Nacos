import { describe, expect, it } from 'vitest';
import { stripUrlCredentials } from '../../src/utils/url';

describe('stripUrlCredentials', () => {
  it('removes a username and password', () => {
    expect(stripUrlCredentials('http://admin:hunter2@nacos.example.com:8848/nacos')).toBe(
      'http://nacos.example.com:8848/nacos'
    );
  });

  it('removes a username on its own', () => {
    expect(stripUrlCredentials('http://admin@nacos.example.com:8848/nacos')).toBe(
      'http://nacos.example.com:8848/nacos'
    );
  });

  it('removes an empty userinfo, which is still a delimiter', () => {
    expect(stripUrlCredentials('http://@h:8848')).toBe('http://h:8848');
  });

  it('leaves an address without userinfo exactly as it was', () => {
    expect(stripUrlCredentials('https://h:8848/nacos')).toBe('https://h:8848/nacos');
  });

  /** The WHATWG parser splits on the *last* `@` of the authority, so a password may hold one. */
  it('cuts at the last @ of the authority, not the first', () => {
    expect(stripUrlCredentials('http://admin:pass@word@h:8848/nacos')).toBe('http://h:8848/nacos');
  });

  it('leaves an @ in the path alone', () => {
    expect(stripUrlCredentials('http://h:8848/nacos@edge/v1')).toBe('http://h:8848/nacos@edge/v1');
  });

  it('leaves an @ in the query alone', () => {
    expect(stripUrlCredentials('http://h:8848/nacos?owner=a@b')).toBe('http://h:8848/nacos?owner=a@b');
  });

  it('leaves an @ in the fragment alone', () => {
    expect(stripUrlCredentials('http://h:8848#a@b')).toBe('http://h:8848#a@b');
  });

  it('keeps an IPv6 literal intact', () => {
    expect(stripUrlCredentials('http://admin:hunter2@[2001:db8::1]:8848/nacos')).toBe(
      'http://[2001:db8::1]:8848/nacos'
    );
  });

  it('matches the scheme case-insensitively', () => {
    expect(stripUrlCredentials('HTTPS://admin:hunter2@h:8848')).toBe('HTTPS://h:8848');
  });

  /** Nothing here parses addresses; a string that is not one is returned untouched. */
  it('leaves a string with no scheme alone', () => {
    expect(stripUrlCredentials('admin:hunter2@h:8848/nacos')).toBe('admin:hunter2@h:8848/nacos');
  });

  it('leaves an empty string alone', () => {
    expect(stripUrlCredentials('')).toBe('');
  });
});
